import express, { type Request, type Response } from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { UpdateEvent, UpdateStatus, UpdateStep } from "@shared/api-types";
import { asyncHandler } from "../lib/http";
import { childLogger } from "../lib/logger";
import { runStore, type RunStatus } from "./run-store";

const log = childLogger("app-update");

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DATABASE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT = 256 * 1024;
const STEP_ORDER: UpdateStep[] = ["backup", "replace", "dependencies", "build", "database", "restart", "complete"];
const PROGRESS: Record<UpdateStep, number> = { backup: 10, replace: 25, dependencies: 45, build: 65, database: 80, restart: 95, complete: 100 };

class UpdateError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Paths & versions
// ---------------------------------------------------------------------------

/** Project root managed by the updater. `APP_UPDATE_ROOT` lets tests point it at a tmpdir. */
export function getRoot(): string {
  return path.resolve(process.env.APP_UPDATE_ROOT || process.cwd());
}

export function updatePaths(root = getRoot()) {
  const tempDir = path.join(root, ".update-temp");
  const backupRoot = path.join(root, ".update-backups");
  return {
    root,
    tempDir,
    uploadDir: path.join(tempDir, "uploads"),
    extractedDir: path.join(tempDir, "extracted"),
    manifestFile: path.join(tempDir, "manifest.json"),
    backupDir: path.join(backupRoot, "latest"),
    backupMetaFile: path.join(backupRoot, "latest.json"),
  };
}

/** Reads `VERSION`, falling back to `package.json` version. */
export function readVersion(dir: string): string {
  try {
    const v = fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim();
    if (v) return v;
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.version) return String(pkg.version);
  } catch {}
  return "unknown";
}

// ---------------------------------------------------------------------------
// In-memory lock: one upload / execute / rollback at a time.
// ---------------------------------------------------------------------------

let lock: { kind: string; startedAt: string } | null = null;

function acquireLock(kind: string): boolean {
  if (lock) return false;
  lock = { kind, startedAt: new Date().toISOString() };
  return true;
}
const releaseLock = () => {
  lock = null;
};

export function __resetUpdateLockForTests() {
  lock = null;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const PRESERVED_TOP_LEVEL = new Set(["node_modules", ".git", ".update-backups", ".update-temp", "uploads", "attached_assets"]);

/** Top-level entries an update/rollback never deletes, overwrites or backs up. */
export function isPreserved(name: string): boolean {
  if (PRESERVED_TOP_LEVEL.has(name) || name === ".env") return true;
  return name.startsWith(".env.") && name !== ".env.example";
}

/** Makes `dest` an exact mirror of `src`, skipping preserved top-level entries on both sides. */
async function mirrorDir(src: string, dest: string, isTop = true): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const srcNames = new Set(await fsp.readdir(src));
  for (const name of await fsp.readdir(dest)) {
    if (isTop && isPreserved(name)) continue;
    if (!srcNames.has(name)) await fsp.rm(path.join(dest, name), { recursive: true, force: true });
  }
  for (const name of srcNames) {
    if (isTop && isPreserved(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const sStat = await fsp.lstat(s);
    const dStat = await fsp.lstat(d).catch(() => null);
    if (sStat.isDirectory()) {
      if (dStat && !dStat.isDirectory()) await fsp.rm(d, { recursive: true, force: true });
      await mirrorDir(s, d, false);
    } else {
      if (dStat) await fsp.rm(d, { recursive: true, force: true });
      if (sStat.isSymbolicLink()) await fsp.symlink(await fsp.readlink(s), d);
      else await fsp.copyFile(s, d);
    }
  }
}

async function syncTree(src: string, dest: string) {
  await mirrorDir(src, dest);
}

async function backupCurrentApp(root: string, backupDir: string) {
  await fsp.rm(backupDir, { recursive: true, force: true });
  await mirrorDir(root, backupDir);
  const meta = { version: readVersion(root), createdAt: new Date().toISOString() };
  await fsp.writeFile(path.join(path.dirname(backupDir), "latest.json"), JSON.stringify(meta, null, 2));
  return meta;
}

async function restoreFromBackup(backupDir: string, root: string) {
  if (!fs.existsSync(backupDir)) throw new UpdateError("No backup available", 404);
  await mirrorDir(backupDir, root);
  return readVersion(root);
}

function getBackupInfo(): UpdateStatus["backup"] {
  const { backupDir, backupMetaFile } = updatePaths();
  if (!fs.existsSync(backupDir)) return null;
  try {
    return JSON.parse(fs.readFileSync(backupMetaFile, "utf8"));
  } catch {
    return { version: readVersion(backupDir), createdAt: null };
  }
}

interface Manifest {
  appRoot: string;
  newVersion: string;
  currentVersion: string;
  originalName: string;
  uploadedAt: string;
}

function readManifest(): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(updatePaths().manifestFile, "utf8"));
  } catch {
    return null;
  }
}

async function cleanupTemp() {
  const { extractedDir, manifestFile } = updatePaths();
  await fsp.rm(extractedDir, { recursive: true, force: true });
  await fsp.rm(manifestFile, { force: true });
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

export interface CommandResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Spawns a command and resolves (never rejects). stdin is always closed; with
 * `stdinNewlines` a stream of newlines is written first so interactive prompts
 * (drizzle-kit push) accept their highlighted default instead of hanging.
 */
function runCommand(
  cmd: string,
  args: string[],
  { cwd = getRoot(), timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdinNewlines = false } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return done({ ok: false, code: null, output: (err as Error).message, timedOut: false });
    }
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => {});
    if (stdinNewlines) child.stdin.write("\n".repeat(64));
    child.stdin.end();

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.on("error", (err) => done({ ok: false, code: null, output: `${output}${err.message}`, timedOut }));
    child.on("close", (code) => done({ ok: code === 0 && !timedOut, code, output, timedOut }));
  });
}

/** Restarts via pm2 from a detached shell after a short delay so the SSE response can flush first. */
function scheduleRestart() {
  spawn("sh", ["-c", "sleep 0.5; pm2 restart all"], { cwd: getRoot(), detached: true, stdio: "ignore" }).unref();
}

/** Every production call site dispatches through `__deps` so tests can spy on them. */
export const __deps = { runCommand, backupCurrentApp, syncTree, restoreFromBackup, scheduleRestart };

async function detectPm2(): Promise<boolean> {
  return (await __deps.runCommand("which", ["pm2"], { timeoutMs: 5000 })).ok;
}

const installArgs = (root: string) =>
  fs.existsSync(path.join(root, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];

function tail(text: string, max = 1500): string {
  const t = String(text || "").trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function commandFailure(label: string, r: CommandResult): string {
  const why = r.timedOut ? "timed out" : `exit code ${r.code ?? "n/a"}`;
  const out = tail(r.output);
  return `${label} failed (${why})${out ? `: ${out}` : ""}`;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DRIZZLE_PROMPT_PATTERNS = [
  /Is [^\n?]+? (?:table|column|enum|schema|sequence|view|policy|role)[^\n?]*? created or renamed from another[^\n?]*\?/gi,
  /Do you want to truncate [^\n?]+\?/gi,
  /Are you sure you want to [^\n?]+\?/gi,
];

/** Extracts drizzle-kit interactive questions from captured output, verbatim. */
export function detectDrizzlePrompts(output: string): string[] {
  const clean = String(output || "").replace(ANSI, "");
  const found = new Set<string>();
  for (const re of DRIZZLE_PROMPT_PATTERNS) for (const m of clean.matchAll(re)) found.add(m[0].trim());
  return [...found];
}

// ---------------------------------------------------------------------------
// ZIP validation
// ---------------------------------------------------------------------------

function execFileP(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

async function listZipEntries(zipFile: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("unzip", ["-Z1", zipFile]);
    return stdout.split("\n").filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UpdateError("Failed to extract ZIP: `unzip` is not installed on the server", 500);
    }
    throw new UpdateError("Failed to extract ZIP: the file is not a valid ZIP archive");
  }
}

function assertNoTraversal(entries: string[]) {
  if (entries.length === 0) throw new UpdateError("Invalid application ZIP: archive is empty");
  for (const entry of entries) {
    const name = entry.replace(/\\/g, "/");
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..")) {
      throw new UpdateError(`Invalid application ZIP: path traversal detected in entry "${entry}"`);
    }
  }
}

async function extractZip(zipFile: string, dest: string) {
  try {
    await execFileP("unzip", ["-q", "-o", zipFile, "-d", dest]);
  } catch (err) {
    const e = err as Error & { stderr?: string };
    throw new UpdateError(`Failed to extract ZIP: ${tail(e.stderr || e.message, 300)}`);
  }
}

/** Returns the directory holding package.json — the archive root, or a single wrapper folder. */
async function locateAppRoot(extractedDir: string): Promise<string> {
  let appRoot = extractedDir;
  if (!fs.existsSync(path.join(extractedDir, "package.json"))) {
    const entries = (await fsp.readdir(extractedDir, { withFileTypes: true })).filter((e) => e.name !== "__MACOSX");
    if (entries.length === 1 && entries[0].isDirectory()) appRoot = path.join(extractedDir, entries[0].name);
  }
  if (!fs.existsSync(path.join(appRoot, "package.json"))) {
    throw new UpdateError("Invalid application ZIP: package.json not found at the archive root");
  }
  const isDir = (p: string) => fs.existsSync(p) && fs.lstatSync(p).isDirectory();
  if (!isDir(path.join(appRoot, "server")) || !isDir(path.join(appRoot, "client"))) {
    throw new UpdateError("Invalid application ZIP: expected both server/ and client/ directories");
  }
  return appRoot;
}

/** Internal symlinks are fine; dangling ones and ones escaping the archive are rejected (both sides realpath'd). */
async function assertSafeSymlinks(extractedDir: string) {
  const realRoot = await fsp.realpath(extractedDir);
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(extractedDir, full);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fsp.realpath(full);
        } catch {
          throw new UpdateError(`Invalid application ZIP: symlink "${rel}" is dangling`);
        }
        if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
          throw new UpdateError(`Invalid application ZIP: symlink "${rel}" points outside the archive`);
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(extractedDir);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const lockedResponse = (res: Response) =>
  res.status(409).json({ success: false, message: "An update is already in progress" });

async function getStatus(_req: Request, res: Response) {
  const manifest = readManifest();
  const status: UpdateStatus = {
    currentVersion: readVersion(getRoot()),
    backup: getBackupInfo(),
    updateInProgress: Boolean(lock),
    lockKind: lock?.kind ?? null,
    pendingUpload: manifest
      ? { newVersion: manifest.newVersion, originalName: manifest.originalName, uploadedAt: manifest.uploadedAt }
      : null,
    lastRun: await runStore().latest(),
  };
  res.json(status);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = updatePaths().uploadDir;
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}.zip`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/\.zip$/i.test(file.originalname)) return cb(new UpdateError("Only .zip files are accepted"));
    cb(null, true);
  },
});

function rejectIfLocked(req: Request, res: Response, next: express.NextFunction) {
  if (!lock) return next();
  res.set("Connection", "close");
  req.resume(); // drain the unread multipart body so the client isn't left blocked
  lockedResponse(res);
}

function receiveUpload(req: Request, res: Response, next: express.NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    const message = err instanceof multer.MulterError ? `Upload failed: ${err.message}` : (err as Error).message;
    res.status((err as UpdateError).status || 400).json({ success: false, message });
  });
}

async function handleUpload(req: Request, res: Response) {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
  if (!acquireLock("upload")) {
    await fsp.rm(req.file.path, { force: true });
    return lockedResponse(res);
  }
  const root = getRoot();
  const { extractedDir, manifestFile } = updatePaths(root);
  // The response is sent only after the lock is released, so a client's next request never sees a stale lock.
  let status = 200;
  let body: Record<string, unknown>;
  try {
    await cleanupTemp();
    assertNoTraversal(await listZipEntries(req.file.path));
    await fsp.mkdir(extractedDir, { recursive: true });
    await extractZip(req.file.path, extractedDir);
    const appRoot = await locateAppRoot(extractedDir);
    await assertSafeSymlinks(extractedDir);
    const newVersion = readVersion(appRoot);
    const currentVersion = readVersion(root);
    const manifest: Manifest = { appRoot, newVersion, currentVersion, originalName: req.file.originalname, uploadedAt: new Date().toISOString() };
    await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    log.info({ newVersion, currentVersion, by: req.user?.username }, "Update package uploaded");
    body = { success: true, newVersion, currentVersion, message: `Version ${newVersion} ready to install` };
  } catch (err) {
    await cleanupTemp().catch(() => {});
    status = (err as UpdateError).status || 500;
    body = { success: false, message: (err as Error).message };
  } finally {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
    releaseLock();
  }
  res.status(status).json(body);
}

async function executeUpdate(req: Request, res: Response) {
  if (!acquireLock("execute")) return lockedResponse(res);
  const root = getRoot();
  const { backupDir } = updatePaths(root);
  const store = runStore();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let runId: string | null = null;
  let finished = false;
  const pending: Promise<void>[] = [];

  const send = (step: UpdateEvent["step"], status: UpdateEvent["status"], message: string, extra: Partial<UpdateEvent> = {}) => {
    const progress = step in PROGRESS ? PROGRESS[step as UpdateStep] : undefined;
    const event: UpdateEvent = { step, status, message, at: new Date().toISOString(), progress, ...extra };
    if (runId) pending.push(store.appendEvent(runId, event).catch((err) => log.warn({ err: err.message }, "appendEvent failed")));
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Persists the final status, then closes the SSE response before anything
  // (like a pm2 restart) can kill this process.
  const finish = async (status: RunStatus, message: string | null = null) => {
    if (finished) return;
    finished = true;
    await Promise.all(pending);
    if (runId) await store.finish(runId, status, message).catch((err) => log.error({ err: err.message }, "finish failed"));
    if (!res.writableEnded) res.end();
    releaseLock();
  };

  const manifest = readManifest();
  if (!manifest || !fs.existsSync(path.join(manifest.appRoot || "", "package.json"))) {
    send("error", "error", "No uploaded update found. Upload a release ZIP first.");
    return finish("failed");
  }

  const fromVersion = readVersion(root);
  const toVersion = manifest.newVersion;
  try {
    runId = await store.create({ fromVersion, toVersion, triggeredBy: req.user?.id ?? null, triggeredByUsername: req.user?.username ?? null });
  } catch (err) {
    send("error", "error", `Could not record the update run: ${(err as Error).message}`);
    return finish("failed");
  }

  let step: UpdateStep = "backup";
  let filesReplaced = false;

  try {
    send("backup", "running", `Backing up current version (v${fromVersion})...`);
    await __deps.backupCurrentApp(root, backupDir);
    send("backup", "done", `Backup of v${fromVersion} created`);

    step = "replace";
    send("replace", "running", "Replacing application files...");
    filesReplaced = true;
    await __deps.syncTree(manifest.appRoot, root);
    send("replace", "done", `Application files replaced with v${toVersion}`);

    step = "dependencies";
    send("dependencies", "running", "Installing dependencies...");
    await fsp.rm(path.join(root, "node_modules"), { recursive: true, force: true });
    const install = await __deps.runCommand("npm", installArgs(root), { cwd: root });
    if (!install.ok) throw new Error(commandFailure("npm install", install));
    send("dependencies", "done", "Dependencies installed");

    step = "build";
    send("build", "running", "Building application...");
    const build = await __deps.runCommand("npm", ["run", "build"], { cwd: root });
    if (!build.ok) throw new Error(commandFailure("npm run build", build));
    send("build", "done", "Build completed");

    step = "database";
    send("database", "running", "Updating database schema...");
    const dbPush = await __deps.runCommand("npm", ["run", "db:push", "--", "--force"], {
      cwd: root,
      timeoutMs: DATABASE_TIMEOUT_MS,
      stdinNewlines: true,
    });
    const prompts = detectDrizzlePrompts(dbPush.output);
    if (!dbPush.ok) {
      const asked = prompts.length ? ` Drizzle was asking: ${prompts.map((p) => `"${p}"`).join("; ")}.` : "";
      throw new Error(`${commandFailure("Database schema push", dbPush)}${asked}`);
    }
    send(
      "database",
      "done",
      prompts.length
        ? `Database schema updated. Drizzle prompts were auto-answered with their defaults: ${prompts.map((p) => `"${p}"`).join("; ")}`
        : "Database schema updated",
    );

    step = "restart";
    const pm2 = await detectPm2();
    if (pm2) send("restart", "done", "Restarting application via pm2...");
    else send("restart", "warning", "pm2 not found. Please restart the application manually.");

    step = "complete";
    await cleanupTemp().catch(() => {});
    const message = pm2
      ? `Update to v${toVersion} complete. Application restarted successfully.`
      : `Update to v${toVersion} complete. Please restart the application manually.`;
    send("complete", "done", message, { version: toVersion });
    await finish("success", message);
    log.info({ fromVersion, toVersion }, "Update applied");

    if (pm2) __deps.scheduleRestart();
  } catch (err) {
    send(step, "error", (err as Error).message);
    if (filesReplaced) {
      send("rollback", "running", `Restoring v${fromVersion} from backup...`);
      try {
        await __deps.restoreFromBackup(backupDir, root);
        if (STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf("dependencies")) {
          const reinstall = await __deps.runCommand("npm", installArgs(root), { cwd: root });
          const rebuild = reinstall.ok ? await __deps.runCommand("npm", ["run", "build"], { cwd: root }) : reinstall;
          if (!reinstall.ok || !rebuild.ok) {
            send("rollback", "warning", "Files restored, but reinstalling dependencies / rebuilding failed. Run `npm ci && npm run build` manually.");
          }
        }
        send("rollback", "done", `Rolled back to v${fromVersion}`);
      } catch (rollbackErr) {
        send("rollback", "error", `Rollback failed: ${(rollbackErr as Error).message}`);
      }
    }
    log.error({ step, err: (err as Error).message }, "Update failed");
    await finish("failed", (err as Error).message);
  }
}

async function rollback(req: Request, res: Response) {
  if (lock) return lockedResponse(res);
  const backup = getBackupInfo();
  if (!backup) return res.status(404).json({ success: false, message: "No backup available" });
  acquireLock("rollback");

  const root = getRoot();
  const { backupDir } = updatePaths(root);
  const store = runStore();
  let runId: string | null = null;
  try {
    runId = await store.create({
      fromVersion: readVersion(root),
      toVersion: backup.version,
      triggeredBy: req.user?.id ?? null,
      triggeredByUsername: req.user?.username ?? null,
    });
    await __deps.restoreFromBackup(backupDir, root);
    const warnings: string[] = [];
    const install = await __deps.runCommand("npm", installArgs(root), { cwd: root });
    if (!install.ok) warnings.push(commandFailure("npm install", install));
    else {
      const build = await __deps.runCommand("npm", ["run", "build"], { cwd: root });
      if (!build.ok) warnings.push(commandFailure("npm run build", build));
    }
    const pm2 = await detectPm2();
    const restoredVersion = readVersion(root);
    const message = pm2
      ? `Rolled back to v${restoredVersion}. Application restarted successfully.`
      : `Rolled back to v${restoredVersion}. Please restart the application manually.`;
    await store.finish(runId, "success", `Manual rollback: ${message}`);
    releaseLock();
    res.json({ success: true, restoredVersion, warnings, message });
    if (pm2) __deps.scheduleRestart();
  } catch (err) {
    if (runId) await store.finish(runId, "failed", (err as Error).message).catch(() => {});
    releaseLock();
    res.status((err as UpdateError).status || 500).json({ success: false, message: `Rollback failed: ${(err as Error).message}` });
  }
}

/** Mounted at /api/app-update behind requireAuth + requireRole("superadmin"). */
export function appUpdateRouter() {
  const router = express.Router();
  router.get("/status", asyncHandler(getStatus));
  router.get(
    "/runs",
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      res.json({ data: await runStore().list(limit) });
    }),
  );
  router.get(
    "/runs/latest",
    asyncHandler(async (_req, res) => {
      res.json({ data: await runStore().latest() });
    }),
  );
  router.get(
    "/runs/:id",
    asyncHandler(async (req, res) => {
      const run = await runStore().get(req.params.id);
      if (!run) return res.status(404).json({ success: false, message: "Update run not found" });
      res.json({ data: run });
    }),
  );
  router.post("/upload", rejectIfLocked, receiveUpload, asyncHandler(handleUpload));
  router.post("/execute", asyncHandler(executeUpdate));
  router.post("/rollback", asyncHandler(rollback));
  return router;
}
