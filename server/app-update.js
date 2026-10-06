import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { getRoot, readVersion, updatePaths } from "./paths.js";
import { createRun, appendEvent, finishRun, latestRun } from "./update-runs.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DATABASE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT = 256 * 1024;

const STEP_ORDER = ["backup", "replace", "dependencies", "build", "database", "restart", "complete"];

class UpdateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// In-memory lock. Only one upload / execute / rollback may run at a time.
// ---------------------------------------------------------------------------

let lock = null;

function acquireLock(kind) {
  if (lock) return false;
  lock = { kind, startedAt: new Date().toISOString() };
  return true;
}

function releaseLock() {
  lock = null;
}

export function __resetUpdateLockForTests() {
  lock = null;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const PRESERVED_TOP_LEVEL = new Set([
  "node_modules",
  ".git",
  ".update-backups",
  ".update-temp",
  ".update-runs.json",
  ".update-runs.json.tmp",
  "uploads",
  "attached_assets",
]);

/** Top-level entries that an update/rollback never deletes, overwrites, or backs up. */
export function isPreserved(name) {
  if (PRESERVED_TOP_LEVEL.has(name)) return true;
  if (name === ".env") return true;
  return name.startsWith(".env.") && name !== ".env.example";
}

/** Makes `dest` an exact mirror of `src`, skipping preserved top-level entries on both sides. */
async function mirrorDir(src, dest, isTop = true) {
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

async function syncTree(src, dest) {
  await mirrorDir(src, dest);
}

async function backupCurrentApp(root, backupDir) {
  await fsp.rm(backupDir, { recursive: true, force: true });
  await mirrorDir(root, backupDir);
  const meta = { version: readVersion(root), createdAt: new Date().toISOString() };
  await fsp.writeFile(path.join(path.dirname(backupDir), "latest.json"), JSON.stringify(meta, null, 2));
  return meta;
}

async function restoreFromBackup(backupDir, root) {
  if (!fs.existsSync(backupDir)) throw new UpdateError("No backup available", 404);
  await mirrorDir(backupDir, root);
  return readVersion(root);
}

function getBackupInfo() {
  const { backupDir, backupMetaFile } = updatePaths();
  if (!fs.existsSync(backupDir)) return null;
  try {
    return JSON.parse(fs.readFileSync(backupMetaFile, "utf8"));
  } catch {
    return { version: readVersion(backupDir), createdAt: null };
  }
}

function readManifest() {
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

/**
 * Spawns a command and resolves (never rejects) with `{ ok, code, output, timedOut }`.
 * stdin is always closed; with `stdinNewlines` a stream of newlines is written first so
 * interactive prompts (drizzle-kit push) accept their highlighted default.
 */
function runCommand(cmd, args, { cwd = getRoot(), timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdinNewlines = false } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return done({ ok: false, code: null, output: err.message, timedOut: false });
    }

    const capture = (chunk) => {
      output += chunk.toString();
      if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => {}); // EPIPE when the child exits before reading stdin
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
  const child = spawn("sh", ["-c", "sleep 0.5; pm2 restart all"], {
    cwd: getRoot(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Production call sites dispatch through `__deps` so tests can replace them with
 * `vi.spyOn(__deps, "fn")`.
 */
export const __deps = { runCommand, backupCurrentApp, syncTree, restoreFromBackup, scheduleRestart };

async function detectPm2() {
  const r = await __deps.runCommand("which", ["pm2"], { timeoutMs: 5000 });
  return r.ok;
}

function installArgs(root) {
  return fs.existsSync(path.join(root, "package-lock.json"))
    ? ["ci", "--no-audit", "--no-fund"]
    : ["install", "--no-audit", "--no-fund"];
}

function tail(text, max = 1500) {
  const t = String(text || "").trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function commandFailure(label, r) {
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
export function detectDrizzlePrompts(output) {
  const clean = String(output || "").replace(ANSI, "");
  const found = new Set();
  for (const re of DRIZZLE_PROMPT_PATTERNS) for (const m of clean.matchAll(re)) found.add(m[0].trim());
  return [...found];
}

// ---------------------------------------------------------------------------
// ZIP validation
// ---------------------------------------------------------------------------

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function listZipEntries(zipFile) {
  try {
    const { stdout } = await execFileP("unzip", ["-Z1", zipFile]);
    return stdout.split("\n").filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") throw new UpdateError("Failed to extract ZIP: `unzip` is not installed on the server", 500);
    throw new UpdateError("Failed to extract ZIP: the file is not a valid ZIP archive");
  }
}

function assertNoTraversal(entries) {
  if (entries.length === 0) throw new UpdateError("Invalid application ZIP: archive is empty");
  for (const entry of entries) {
    const name = entry.replace(/\\/g, "/");
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..")) {
      throw new UpdateError(`Invalid application ZIP: path traversal detected in entry "${entry}"`);
    }
  }
}

async function extractZip(zipFile, dest) {
  try {
    await execFileP("unzip", ["-q", "-o", zipFile, "-d", dest]);
  } catch (err) {
    throw new UpdateError(`Failed to extract ZIP: ${tail(err.stderr || err.message, 300)}`);
  }
}

/** Returns the directory holding package.json — the archive root, or a single wrapper folder. */
async function locateAppRoot(extractedDir) {
  let appRoot = extractedDir;
  if (!fs.existsSync(path.join(extractedDir, "package.json"))) {
    const entries = (await fsp.readdir(extractedDir, { withFileTypes: true })).filter((e) => e.name !== "__MACOSX");
    if (entries.length === 1 && entries[0].isDirectory()) appRoot = path.join(extractedDir, entries[0].name);
  }
  if (!fs.existsSync(path.join(appRoot, "package.json"))) {
    throw new UpdateError("Invalid application ZIP: package.json not found at the archive root");
  }
  const isDir = (p) => fs.existsSync(p) && fs.lstatSync(p).isDirectory();
  if (!isDir(path.join(appRoot, "server")) || !isDir(path.join(appRoot, "client"))) {
    throw new UpdateError("Invalid application ZIP: expected both server/ and client/ directories");
  }
  return appRoot;
}

/**
 * Allows internal symlinks; rejects dangling ones and any whose target escapes the archive.
 * Both sides are resolved with realpath so symlinked temp/app directories don't cause false positives.
 */
async function assertSafeSymlinks(extractedDir) {
  const realRoot = await fsp.realpath(extractedDir);
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(extractedDir, full);
      if (entry.isSymbolicLink()) {
        let target;
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

const lockedResponse = (res) =>
  res.status(409).json({ success: false, message: "An update is already in progress" });

function getStatus(req, res) {
  const manifest = readManifest();
  res.json({
    currentVersion: readVersion(getRoot()),
    backup: getBackupInfo(),
    updateInProgress: Boolean(lock),
    lockKind: lock?.kind ?? null,
    pendingUpload: manifest
      ? { newVersion: manifest.newVersion, originalName: manifest.originalName, uploadedAt: manifest.uploadedAt }
      : null,
    lastRun: latestRun(),
  });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = updatePaths().uploadDir;
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}.zip`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/\.zip$/i.test(file.originalname)) return cb(new UpdateError("Only .zip files are accepted"));
    cb(null, true);
  },
});

function rejectIfLocked(req, res, next) {
  if (!lock) return next();
  // Drain the unread multipart body so the client isn't left blocked mid-upload.
  res.set("Connection", "close");
  req.resume();
  lockedResponse(res);
}

function receiveUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err instanceof multer.MulterError ? `Upload failed: ${err.message}` : err.message;
    res.status(err.status || 400).json({ success: false, message });
  });
}

async function handleUpload(req, res) {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
  if (!acquireLock("upload")) {
    await fsp.rm(req.file.path, { force: true });
    return lockedResponse(res);
  }

  const root = getRoot();
  const { extractedDir, manifestFile } = updatePaths(root);
  try {
    await cleanupTemp();
    assertNoTraversal(await listZipEntries(req.file.path));
    await fsp.mkdir(extractedDir, { recursive: true });
    await extractZip(req.file.path, extractedDir);
    const appRoot = await locateAppRoot(extractedDir);
    await assertSafeSymlinks(extractedDir);

    const newVersion = readVersion(appRoot);
    const currentVersion = readVersion(root);
    await fsp.writeFile(
      manifestFile,
      JSON.stringify(
        { appRoot, newVersion, currentVersion, originalName: req.file.originalname, uploadedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    res.json({ success: true, newVersion, currentVersion, message: `Version ${newVersion} ready to install` });
  } catch (err) {
    await cleanupTemp().catch(() => {});
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
    releaseLock();
  }
}

async function executeUpdate(req, res) {
  if (!acquireLock("execute")) return lockedResponse(res);

  const root = getRoot();
  const { backupDir } = updatePaths(root);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let runId = null;
  let finished = false;

  const send = (step, status, message, extra = {}) => {
    const event = { step, status, message, at: new Date().toISOString(), ...extra };
    if (runId) appendEvent(runId, event);
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Persists the final run status and closes the SSE response before anything
  // (like a pm2 restart) can kill this process.
  const finish = (status, message = null) => {
    if (finished) return;
    finished = true;
    if (runId) finishRun(runId, status, message);
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
  runId = createRun({ kind: "update", fromVersion, toVersion, startedBy: req.session.user.username }).id;

  let step = "backup";
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
    const db = await __deps.runCommand("npm", ["run", "db:push", "--", "--force"], {
      cwd: root,
      timeoutMs: DATABASE_TIMEOUT_MS,
      stdinNewlines: true,
    });
    const prompts = detectDrizzlePrompts(db.output);
    if (!db.ok) {
      const asked = prompts.length ? ` Drizzle was asking: ${prompts.map((p) => `"${p}"`).join("; ")}.` : "";
      throw new Error(`${commandFailure("Database schema push", db)}${asked}`);
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
    finish("success", message);

    if (pm2) __deps.scheduleRestart();
  } catch (err) {
    send(step, "error", err.message);
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
        send("rollback", "error", `Rollback failed: ${rollbackErr.message}`);
      }
    }
    finish("failed", err.message);
  }
}

async function rollback(req, res) {
  if (lock) return lockedResponse(res);
  const backup = getBackupInfo();
  if (!backup) return res.status(404).json({ success: false, message: "No backup available" });
  acquireLock("rollback");

  const root = getRoot();
  const { backupDir } = updatePaths(root);
  const runId = createRun({
    kind: "rollback",
    fromVersion: readVersion(root),
    toVersion: backup.version,
    startedBy: req.session.user.username,
  }).id;

  try {
    await __deps.restoreFromBackup(backupDir, root);
    const warnings = [];
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
    finishRun(runId, "success", message);
    releaseLock();
    res.json({ success: true, restoredVersion, warnings, message });
    if (pm2) __deps.scheduleRestart();
  } catch (err) {
    finishRun(runId, "failed", err.message);
    releaseLock();
    res.status(err.status || 500).json({ success: false, message: `Rollback failed: ${err.message}` });
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Mounted at /api/app-update behind requireAuth + requireRole("superadmin"). */
export function appUpdateRouter() {
  const router = express.Router();
  router.get("/status", getStatus);
  router.post("/upload", rejectIfLocked, receiveUpload, wrap(handleUpload));
  router.post("/execute", wrap(executeUpdate));
  router.post("/rollback", wrap(rollback));
  return router;
}
