import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { makeZip } from "./zip-fixture";
import { login, makeUser, mockDirectory } from "./helpers";
import { createApp } from "../app";
import { __deps, __resetUpdateLockForTests, detectDrizzlePrompts, type CommandResult } from "../app-update/controller";
import { MemoryRunStore, setUpdateRunStore } from "../app-update/run-store";
import { reconcileStaleRuns } from "../app-update/reconciler";

let root: string;
let app: Express;
let store: MemoryRunStore;

const superadmin = makeUser({ username: "superadmin", role: "superadmin" });
const admin = makeUser({ username: "tenantadmin", role: "admin" });

const ok: CommandResult = { ok: true, code: 0, output: "", timedOut: false };
const fail = (output = "boom"): CommandResult => ({ ok: false, code: 1, output, timedOut: false });

function writeFile(rel: string, content: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const readRootVersion = () => fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();

function releaseZip(version = "2.0.0", extra: Record<string, string | { symlink: string }> = {}, prefix = "") {
  const files: Record<string, string | { symlink: string }> = {
    VERSION: `${version}\n`,
    "package.json": JSON.stringify({ name: "woomarket360", version }),
    "server/index.ts": `// v${version}\n`,
    "client/index.html": "<!doctype html>\n",
    ...extra,
  };
  return makeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [prefix + k, v])));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const rawText = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: string) => void) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, data));
};

const parseSse = (text: string) =>
  text
    .split("\n\n")
    .map((c) => c.trim())
    .filter((c) => c.startsWith("data:"))
    .map((c) => JSON.parse(c.slice(5).trim()));

type Session = Awaited<ReturnType<typeof login>>;
const upload = (s: Session, buf: Buffer, name = "release.zip") =>
  s.agent.post("/api/app-update/upload").set("X-CSRF-Token", s.csrf).attach("file", buf, name);
const execute = (s: Session) => s.agent.post("/api/app-update/execute").set("X-CSRF-Token", s.csrf).buffer(true).parse(rawText as never);
const rollback = (s: Session) => s.agent.post("/api/app-update/rollback").set("X-CSRF-Token", s.csrf);
const status = async (s: Session) => (await s.agent.get("/api/app-update/status").expect(200)).body;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "app-update-test-"));
  writeFile("VERSION", "1.0.0\n");
  writeFile("package.json", JSON.stringify({ name: "woomarket360", version: "1.0.0" }));
  writeFile("server/index.ts", "// v1.0.0\n");
  writeFile("client/index.html", "<!-- v1 -->\n");
  writeFile(".env", "SECRET=keep-me\n");
  process.env.APP_UPDATE_ROOT = root;
  __resetUpdateLockForTests();
  store = new MemoryRunStore();
  setUpdateRunStore(store);
  mockDirectory([superadmin, admin]);

  // Never run real shell commands or restart anything from the test suite.
  vi.spyOn(__deps, "runCommand").mockImplementation(async (cmd) => (cmd === "which" ? fail("") : ok));
  vi.spyOn(__deps, "scheduleRestart").mockImplementation(() => {});

  app = createApp().app;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.APP_UPDATE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { default: request } = await import("supertest");
    await request(app).get("/api/app-update/status").expect(401);
  });

  it("rejects non-superadmin users with 403", async () => {
    const s = await login(app, "tenantadmin");
    await s.agent.get("/api/app-update/status").expect(403);
  });

  it("allows superadmin", async () => {
    const s = await login(app, "superadmin");
    await s.agent.get("/api/app-update/status").expect(200);
  });
});

describe("csrf", () => {
  for (const endpoint of ["upload", "execute", "rollback"]) {
    it(`rejects ${endpoint} without X-CSRF-Token`, async () => {
      const s = await login(app, "superadmin");
      const res = await s.agent.post(`/api/app-update/${endpoint}`).expect(403);
      expect(res.body.code).toBe("CSRF_INVALID");
    });
  }
});

describe("status", () => {
  it("reports current VERSION, no backup and lock state", async () => {
    const s = await login(app, "superadmin");
    expect(await status(s)).toMatchObject({ currentVersion: "1.0.0", backup: null, updateInProgress: false, pendingUpload: null, lastRun: null });
  });
});

describe("upload — rejections", () => {
  let s: Session;
  beforeEach(async () => {
    s = await login(app, "superadmin");
  });

  it("rejects a request with no file", async () => {
    const res = await s.agent.post("/api/app-update/upload").set("X-CSRF-Token", s.csrf).expect(400);
    expect(res.body.message).toMatch(/No file uploaded/);
  });

  it("rejects a non-.zip filename", async () => {
    const res = await upload(s, Buffer.from("hello"), "bogus.txt").expect(400);
    expect(res.body.message).toBe("Only .zip files are accepted");
  });

  it("rejects a ZIP missing package.json", async () => {
    const res = await upload(s, makeZip({ "server/index.ts": "", "client/index.html": "" })).expect(400);
    expect(res.body.message).toMatch(/Invalid application ZIP/);
  });

  it("rejects a ZIP missing server/ and client/", async () => {
    const res = await upload(s, makeZip({ "package.json": "{}" })).expect(400);
    expect(res.body.message).toMatch(/Invalid application ZIP/);
  });

  it("rejects a path-traversal entry", async () => {
    const res = await upload(s, releaseZip("2.0.0", { "../evil.txt": "pwned" })).expect(400);
    expect(res.body.message).toMatch(/traversal|Failed to extract/);
    expect(fs.existsSync(path.join(root, ".update-temp", "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".update-temp", "extracted"))).toBe(false);
  });

  it("rejects garbage bytes", async () => {
    const res = await upload(s, Buffer.from("definitely not a zip archive")).expect(400);
    expect(res.body.message).toMatch(/Failed to extract/);
  });

  it("rejects symlinks that escape the archive, naming them", async () => {
    const res = await upload(s, releaseZip("2.0.0", { "server/escape": { symlink: "/etc" } })).expect(400);
    expect(res.body.message).toMatch(/symlink "server\/escape" points outside/);
    const res2 = await upload(s, releaseZip("2.0.0", { "client/up": { symlink: "../../.." } })).expect(400);
    expect(res2.body.message).toMatch(/symlink "client\/up" points outside/);
  });

  it("rejects a dangling symlink", async () => {
    const res = await upload(s, releaseZip("2.0.0", { "server/dangling": { symlink: "missing-file" } })).expect(400);
    expect(res.body.message).toMatch(/symlink "server\/dangling" is dangling/);
  });

  it("returns 409 while an update holds the lock", async () => {
    await upload(s, releaseZip()).expect(200);
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(__deps, "backupCurrentApp").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { version: "1.0.0", createdAt: "" };
    });
    vi.spyOn(__deps, "syncTree").mockResolvedValue();
    const running = execute(s).then((r) => r);
    await entered.promise;
    const res = await upload(s, releaseZip("3.0.0")).expect(409);
    expect(res.body.message).toBe("An update is already in progress");
    gate.resolve();
    await running;
  });
});

describe("upload — happy path", () => {
  it("parses VERSION and leaves .update-temp/extracted/ ready", async () => {
    const s = await login(app, "superadmin");
    const res = await upload(s, releaseZip("2.0.0")).expect(200);
    expect(res.body).toMatchObject({ success: true, newVersion: "2.0.0", currentVersion: "1.0.0" });
    expect(fs.existsSync(path.join(root, ".update-temp", "extracted", "package.json"))).toBe(true);
    expect((await status(s)).pendingUpload.newVersion).toBe("2.0.0");
  });

  it("accepts internal symlinks and a single wrapper directory", async () => {
    const s = await login(app, "superadmin");
    const zip = releaseZip("2.1.0", { "server/link.ts": { symlink: "index.ts" } }, "woomarket360-2.1.0/");
    expect((await upload(s, zip).expect(200)).body.newVersion).toBe("2.1.0");
  });
});

describe("execute", () => {
  let s: Session;
  beforeEach(async () => {
    s = await login(app, "superadmin");
  });

  it("emits an SSE error when nothing has been uploaded", async () => {
    const events = parseSse((await execute(s).expect(200)).body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error" });
    expect(events[0].message).toMatch(/Upload a release ZIP first/);
    expect((await status(s)).updateInProgress).toBe(false);
  });

  it("runs backup → replace → dependencies → build → database → restart → complete and persists the run", async () => {
    await upload(s, releaseZip("2.0.0")).expect(200);
    writeFile("stale-file.txt", "removed by the update");

    const events = parseSse((await execute(s).expect(200)).body);
    expect([...new Set(events.map((e) => e.step))]).toEqual(["backup", "replace", "dependencies", "build", "database", "restart", "complete"]);
    expect(events.find((e) => e.step === "restart").status).toBe("warning");
    expect(events.at(-1)).toMatchObject({ step: "complete", status: "done", progress: 100 });
    expect(events.at(-1).message).toMatch(/Please restart the application manually/);

    expect(readRootVersion()).toBe("2.0.0");
    expect(fs.existsSync(path.join(root, "stale-file.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toContain("keep-me");
    expect(__deps.runCommand).toHaveBeenCalledWith("npm", ["run", "db:push", "--", "--force"], expect.objectContaining({ stdinNewlines: true, timeoutMs: 120000 }));

    const after = await status(s);
    expect(after).toMatchObject({ currentVersion: "2.0.0", updateInProgress: false, pendingUpload: null });
    expect(after.backup.version).toBe("1.0.0");
    expect(after.lastRun).toMatchObject({ status: "success", fromVersion: "1.0.0", toVersion: "2.0.0", triggeredByUsername: "superadmin" });
    expect(after.lastRun.events.length).toBe(events.length);
    expect(__deps.scheduleRestart).not.toHaveBeenCalled();
  });

  it("reports 'restarted successfully' and schedules a detached restart when pm2 is present", async () => {
    vi.mocked(__deps.runCommand).mockImplementation(async () => ok);
    await upload(s, releaseZip("2.0.0")).expect(200);
    const events = parseSse((await execute(s).expect(200)).body);
    expect(events.find((e) => e.step === "restart").status).toBe("done");
    expect(events.at(-1).message).toMatch(/restarted successfully/);
    expect(__deps.scheduleRestart).toHaveBeenCalledTimes(1);
    expect(store.runs.at(-1)?.status).toBe("success");
  });

  it("rolls back when npm install fails and releases the lock", async () => {
    vi.mocked(__deps.runCommand).mockImplementation(async (cmd, args) =>
      cmd === "npm" && (args[0] === "install" || args[0] === "ci") ? fail("npm ERR! network") : cmd === "which" ? fail("") : ok,
    );
    const restoreSpy = vi.spyOn(__deps, "restoreFromBackup");
    await upload(s, releaseZip("2.0.0")).expect(200);

    const events = parseSse((await execute(s).expect(200)).body);
    const tags = events.map((e) => `${e.step}:${e.status}`);
    expect(tags).toContain("dependencies:error");
    expect(tags.indexOf("rollback:running")).toBeGreaterThan(tags.indexOf("dependencies:error"));
    expect(tags.at(-1)).toBe("rollback:done");
    expect(events.find((e) => e.step === "dependencies" && e.status === "error").message).toMatch(/npm ERR! network/);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(readRootVersion()).toBe("1.0.0");
    const after = await status(s);
    expect(after.updateInProgress).toBe(false);
    expect(after.lastRun.status).toBe("failed");
  });

  it("surfaces the drizzle prompt verbatim when the database step stalls", async () => {
    const question = "Is update_run_events table created or renamed from another table?";
    vi.mocked(__deps.runCommand).mockImplementation(async (cmd, args) =>
      args?.includes("db:push")
        ? { ok: false, code: null, timedOut: true, output: `\x1b[1m${question}\x1b[0m\n❯ + update_run_events  create table` }
        : cmd === "which"
          ? fail("")
          : ok,
    );
    await upload(s, releaseZip("2.0.0")).expect(200);
    const events = parseSse((await execute(s).expect(200)).body);
    const dbError = events.find((e) => e.step === "database" && e.status === "error");
    expect(dbError.message).toContain(question);
    expect(dbError.message).toMatch(/timed out/);
    expect(events.at(-1)).toMatchObject({ step: "rollback", status: "done" });
    expect(readRootVersion()).toBe("1.0.0");
  });

  it("returns 409 for a concurrent execute", async () => {
    await upload(s, releaseZip()).expect(200);
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(__deps, "backupCurrentApp").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { version: "1.0.0", createdAt: "" };
    });
    vi.spyOn(__deps, "syncTree").mockResolvedValue();
    const first = execute(s).then((r) => r);
    await entered.promise;
    expect((await status(s)).updateInProgress).toBe(true);
    const second = await execute(s).expect(409);
    expect(JSON.parse(second.body).message).toBe("An update is already in progress");
    gate.resolve();
    await first;
    expect((await status(s)).updateInProgress).toBe(false);
  });
});

describe("rollback", () => {
  let s: Session;
  beforeEach(async () => {
    s = await login(app, "superadmin");
  });

  it("returns 404 when there is no backup", async () => {
    expect((await rollback(s).expect(404)).body.message).toBe("No backup available");
  });

  it("restores the backup and returns restoredVersion", async () => {
    await upload(s, releaseZip("2.0.0")).expect(200);
    await execute(s).expect(200);
    expect(readRootVersion()).toBe("2.0.0");
    const res = await rollback(s).expect(200);
    expect(res.body).toMatchObject({ success: true, restoredVersion: "1.0.0" });
    expect(readRootVersion()).toBe("1.0.0");
    expect(fs.readFileSync(path.join(root, "server/index.ts"), "utf8")).toBe("// v1.0.0\n");
    expect(store.runs.at(-1)).toMatchObject({ status: "success", toVersion: "1.0.0" });
  });

  it("returns 409 while an update is in progress", async () => {
    await upload(s, releaseZip()).expect(200);
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(__deps, "backupCurrentApp").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { version: "1.0.0", createdAt: "" };
    });
    vi.spyOn(__deps, "syncTree").mockResolvedValue();
    writeFile(".update-backups/latest/VERSION", "0.9.0\n");
    const running = execute(s).then((r) => r);
    await entered.promise;
    await rollback(s).expect(409);
    gate.resolve();
    await running;
  });
});

describe("run history", () => {
  it("lists runs and fetches one by id", async () => {
    const s = await login(app, "superadmin");
    await upload(s, releaseZip("2.0.0")).expect(200);
    await execute(s).expect(200);
    const list = await s.agent.get("/api/app-update/runs").expect(200);
    expect(list.body.data).toHaveLength(1);
    const one = await s.agent.get(`/api/app-update/runs/${list.body.data[0].id}`).expect(200);
    expect(one.body.data.events.length).toBeGreaterThan(5);
    await s.agent.get("/api/app-update/runs/00000000-0000-0000-0000-000000000000").expect(404);
  });
});

describe("startup reconciler", () => {
  it("marks runs whose target version landed as success, others as interrupted", async () => {
    const landed = await store.create({ fromVersion: "0.9.0", toVersion: "1.0.0", triggeredBy: null, triggeredByUsername: "superadmin" });
    const lost = await store.create({ fromVersion: "1.0.0", toVersion: "2.0.0", triggeredBy: null, triggeredByUsername: "superadmin" });
    expect(await reconcileStaleRuns()).toBe(2);
    expect(await store.get(landed)).toMatchObject({ status: "success" });
    expect((await store.get(landed))?.finalMessage).toMatch(/reconciled at startup/);
    expect(await store.get(lost)).toMatchObject({ status: "interrupted" });
    expect(await reconcileStaleRuns()).toBe(0);
  });
});

describe("detectDrizzlePrompts", () => {
  it("extracts rename and truncate questions", () => {
    const out = "Pulling schema...\nIs users table created or renamed from another table?\nDo you want to truncate templates table?\n";
    expect(detectDrizzlePrompts(out)).toEqual(["Is users table created or renamed from another table?", "Do you want to truncate templates table?"]);
  });
});
