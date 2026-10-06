import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeZip } from "./zip-fixture.js";
import { createApp } from "../app.js";
import { __deps, __resetUpdateLockForTests, detectDrizzlePrompts } from "../app-update.js";
import { createRun, reconcileStaleRuns, latestRun } from "../update-runs.js";

const CREDENTIALS = {
  superadmin: [process.env.SUPERADMIN_USERNAME || "superadmin", process.env.SUPERADMIN_PASSWORD || "superadmin123"],
  admin: [process.env.ADMIN_USERNAME || "admin", process.env.ADMIN_PASSWORD || "admin123"],
};

let root;
let app;

const ok = { ok: true, code: 0, output: "", timedOut: false };
const fail = (output = "boom") => ({ ok: false, code: 1, output, timedOut: false });

function writeFile(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const readRootVersion = () => fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();

function releaseZip(version = "2.0.0", extra = {}, prefix = "") {
  const files = {
    VERSION: `${version}\n`,
    "package.json": JSON.stringify({ name: "woomarket360", version }),
    "server/index.js": `// v${version}\n`,
    "client/index.html": "<!doctype html>\n",
    ...extra,
  };
  return makeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [prefix + k, v])));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const rawText = (res, cb) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (c) => (data += c));
  res.on("end", () => cb(null, data));
};

const parseSse = (text) =>
  text
    .split("\n\n")
    .map((c) => c.trim())
    .filter((c) => c.startsWith("data:"))
    .map((c) => JSON.parse(c.slice(5).trim()));

async function login(role) {
  const agent = request.agent(app);
  const csrf = await agent.get("/api/csrf-token").expect(200);
  const [username, password] = CREDENTIALS[role];
  const res = await agent
    .post("/api/auth/login")
    .set("X-CSRF-Token", csrf.body.token)
    .send({ username, password })
    .expect(200);
  return { agent, csrf: res.body.csrfToken };
}

const upload = (s, buf, name = "release.zip") =>
  s.agent.post("/api/app-update/upload").set("X-CSRF-Token", s.csrf).attach("file", buf, name);

const execute = (s) =>
  s.agent.post("/api/app-update/execute").set("X-CSRF-Token", s.csrf).buffer(true).parse(rawText);

const rollback = (s) => s.agent.post("/api/app-update/rollback").set("X-CSRF-Token", s.csrf);

const status = async (s) => (await s.agent.get("/api/app-update/status").expect(200)).body;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "app-update-test-"));
  writeFile("VERSION", "1.0.0\n");
  writeFile("package.json", JSON.stringify({ name: "woomarket360", version: "1.0.0" }));
  writeFile("server/index.js", "// v1.0.0\n");
  writeFile("client/index.html", "<!-- v1 -->\n");
  writeFile(".env", "SECRET=keep-me\n");
  process.env.APP_UPDATE_ROOT = root;
  __resetUpdateLockForTests();

  // Never run real shell commands or restart anything from the test suite.
  vi.spyOn(__deps, "runCommand").mockImplementation(async (cmd) => (cmd === "which" ? fail("") : ok));
  vi.spyOn(__deps, "scheduleRestart").mockImplementation(() => {});

  app = createApp({ sessionSecret: "test-secret" });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.APP_UPDATE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("auth", () => {
  it("rejects unauthenticated requests with 401", async () => {
    await request(app).get("/api/app-update/status").expect(401);
  });

  it("rejects non-superadmin users with 403", async () => {
    const s = await login("admin");
    await s.agent.get("/api/app-update/status").expect(403);
  });

  it("allows superadmin", async () => {
    const s = await login("superadmin");
    await s.agent.get("/api/app-update/status").expect(200);
  });

  it("redirects a tenant admin away from the /app-update page", async () => {
    const s = await login("admin");
    const res = await s.agent.get("/app-update").expect(302);
    expect(res.headers.location).toBe("/?denied=app-update");
  });
});

describe("csrf", () => {
  for (const endpoint of ["upload", "execute", "rollback"]) {
    it(`rejects ${endpoint} without X-CSRF-Token`, async () => {
      const s = await login("superadmin");
      const res = await s.agent.post(`/api/app-update/${endpoint}`).expect(403);
      expect(res.body.message).toMatch(/CSRF/);
    });
  }
});

describe("status", () => {
  it("reports current VERSION, no backup and lock state", async () => {
    const s = await login("superadmin");
    const body = await status(s);
    expect(body).toMatchObject({ currentVersion: "1.0.0", backup: null, updateInProgress: false, pendingUpload: null });
  });
});

describe("upload — rejections", () => {
  let s;
  beforeEach(async () => {
    s = await login("superadmin");
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
    const zip = makeZip({ "server/index.js": "", "client/index.html": "" });
    const res = await upload(s, zip).expect(400);
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

  it("rejects a symlink that escapes the archive, naming it", async () => {
    const absolute = releaseZip("2.0.0", { "server/escape": { symlink: "/etc" } });
    const res = await upload(s, absolute).expect(400);
    expect(res.body.message).toMatch(/symlink "server\/escape" points outside/);

    const relative = releaseZip("2.0.0", { "client/up": { symlink: "../../.." } });
    const res2 = await upload(s, relative).expect(400);
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
    const s = await login("superadmin");
    const res = await upload(s, releaseZip("2.0.0")).expect(200);
    expect(res.body).toMatchObject({ success: true, newVersion: "2.0.0", currentVersion: "1.0.0" });
    expect(fs.existsSync(path.join(root, ".update-temp", "extracted", "package.json"))).toBe(true);
    expect((await status(s)).pendingUpload.newVersion).toBe("2.0.0");
  });

  it("accepts internal symlinks and a single wrapper directory", async () => {
    const s = await login("superadmin");
    const zip = releaseZip("2.1.0", { "server/link.js": { symlink: "index.js" } }, "woomarket360-2.1.0/");
    const res = await upload(s, zip).expect(200);
    expect(res.body.newVersion).toBe("2.1.0");
  });
});

describe("execute", () => {
  let s;
  beforeEach(async () => {
    s = await login("superadmin");
  });

  it("emits an SSE error when nothing has been uploaded", async () => {
    const res = await execute(s).expect(200);
    const events = parseSse(res.body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error" });
    expect(events[0].message).toMatch(/Upload a release ZIP first/);
    expect((await status(s)).updateInProgress).toBe(false);
  });

  it("runs backup → replace → dependencies → build → database → restart → complete", async () => {
    await upload(s, releaseZip("2.0.0")).expect(200);
    writeFile("stale-file.txt", "removed by the update");

    const events = parseSse((await execute(s).expect(200)).body);
    const order = [...new Set(events.map((e) => e.step))];
    expect(order).toEqual(["backup", "replace", "dependencies", "build", "database", "restart", "complete"]);
    expect(events.find((e) => e.step === "restart").status).toBe("warning");
    expect(events.at(-1)).toMatchObject({ step: "complete", status: "done" });
    expect(events.at(-1).message).toMatch(/Please restart the application manually/);

    // Files replaced, removed files gone, secrets preserved.
    expect(readRootVersion()).toBe("2.0.0");
    expect(fs.existsSync(path.join(root, "stale-file.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toContain("keep-me");

    // Database step runs with the drizzle safeguards.
    expect(__deps.runCommand).toHaveBeenCalledWith(
      "npm",
      ["run", "db:push", "--", "--force"],
      expect.objectContaining({ stdinNewlines: true, timeoutMs: 120000 }),
    );

    const after = await status(s);
    expect(after).toMatchObject({ currentVersion: "2.0.0", updateInProgress: false, pendingUpload: null });
    expect(after.backup.version).toBe("1.0.0");
    expect(after.backup.createdAt).toBeTruthy();
    expect(after.lastRun).toMatchObject({ status: "success", fromVersion: "1.0.0", toVersion: "2.0.0" });
    expect(__deps.scheduleRestart).not.toHaveBeenCalled();
  });

  it("reports 'restarted successfully' and schedules a detached restart when pm2 is present", async () => {
    __deps.runCommand.mockImplementation(async () => ok);
    await upload(s, releaseZip("2.0.0")).expect(200);
    const events = parseSse((await execute(s).expect(200)).body);
    expect(events.find((e) => e.step === "restart").status).toBe("done");
    expect(events.at(-1).message).toMatch(/restarted successfully/);
    expect(__deps.scheduleRestart).toHaveBeenCalledTimes(1);
    expect(latestRun().status).toBe("success");
  });

  it("rolls back when npm install fails and releases the lock", async () => {
    __deps.runCommand.mockImplementation(async (cmd, args) =>
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
    __deps.runCommand.mockImplementation(async (cmd, args) =>
      args?.includes("db:push")
        ? { ok: false, code: null, timedOut: true, output: `\x1b[1m${question}\x1b[0m\n❯ + update_run_events  create table` }
        : cmd === "which" ? fail("") : ok,
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
  let s;
  beforeEach(async () => {
    s = await login("superadmin");
  });

  it("returns 404 when there is no backup", async () => {
    const res = await rollback(s).expect(404);
    expect(res.body.message).toBe("No backup available");
  });

  it("restores the backup and returns restoredVersion", async () => {
    await upload(s, releaseZip("2.0.0")).expect(200);
    await execute(s).expect(200);
    expect(readRootVersion()).toBe("2.0.0");

    const res = await rollback(s).expect(200);
    expect(res.body).toMatchObject({ success: true, restoredVersion: "1.0.0" });
    expect(readRootVersion()).toBe("1.0.0");
    expect(fs.readFileSync(path.join(root, "server/index.js"), "utf8")).toBe("// v1.0.0\n");
    expect((await status(s)).lastRun).toMatchObject({ kind: "rollback", status: "success" });
  });

  it("returns 409 while an update is in progress", async () => {
    await upload(s, releaseZip()).expect(200);
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(__deps, "backupCurrentApp").mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
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

describe("startup reconciler", () => {
  it("marks runs whose target version landed as success, others as interrupted", () => {
    const landed = createRun({ kind: "update", fromVersion: "0.9.0", toVersion: "1.0.0", startedBy: "superadmin" });
    const lost = createRun({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", startedBy: "superadmin" });

    expect(reconcileStaleRuns()).toBe(2);
    const runs = JSON.parse(fs.readFileSync(path.join(root, ".update-runs.json"), "utf8"));
    expect(runs.find((r) => r.id === landed.id)).toMatchObject({ status: "success" });
    expect(runs.find((r) => r.id === landed.id).message).toMatch(/reconciled at startup/);
    expect(runs.find((r) => r.id === lost.id)).toMatchObject({ status: "interrupted" });
    expect(reconcileStaleRuns()).toBe(0);
  });
});

describe("detectDrizzlePrompts", () => {
  it("extracts rename and truncate questions", () => {
    const out = "Pulling schema...\nIs users table created or renamed from another table?\nDo you want to truncate templates table?\n";
    expect(detectDrizzlePrompts(out)).toEqual([
      "Is users table created or renamed from another table?",
      "Do you want to truncate templates table?",
    ]);
  });
});
