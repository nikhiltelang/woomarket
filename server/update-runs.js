import fs from "node:fs";
import crypto from "node:crypto";
import { getRoot, readVersion, updatePaths } from "./paths.js";

// `update_runs` persistence. Stored as a JSON file in the project root
// (preserved across updates/rollbacks) so the panel can hydrate the last
// run after a refresh or process restart.

const MAX_RUNS = 20;
const MAX_EVENTS_PER_RUN = 500;

function load() {
  try {
    const runs = JSON.parse(fs.readFileSync(updatePaths().runsFile, "utf8"));
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

function save(runs) {
  const file = updatePaths().runsFile;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(runs.slice(-MAX_RUNS), null, 2));
  fs.renameSync(tmp, file);
}

function mutate(id, fn) {
  const runs = load();
  const run = runs.find((r) => r.id === id);
  if (!run) return null;
  fn(run);
  save(runs);
  return run;
}

export function createRun({ kind, fromVersion, toVersion, startedBy }) {
  const runs = load();
  const run = {
    id: crypto.randomUUID(),
    kind,
    status: "running",
    fromVersion,
    toVersion,
    startedBy,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: null,
    events: [],
  };
  runs.push(run);
  save(runs);
  return run;
}

export function appendEvent(id, event) {
  return mutate(id, (run) => {
    if (run.events.length < MAX_EVENTS_PER_RUN) run.events.push(event);
  });
}

export function finishRun(id, status, message = null) {
  return mutate(id, (run) => {
    run.status = status;
    run.message = message;
    run.finishedAt = new Date().toISOString();
  });
}

export function latestRun() {
  const runs = load();
  return runs.length ? runs[runs.length - 1] : null;
}

/**
 * Startup reconciler: settles rows left at `running` by a process that died
 * before its finaliser ran. Returns the number of rows settled.
 */
export function reconcileStaleRuns() {
  const runs = load();
  const onDiskVersion = readVersion(getRoot());
  let settled = 0;
  for (const run of runs) {
    if (run.status !== "running") continue;
    settled++;
    run.finishedAt = new Date().toISOString();
    if (run.toVersion && run.toVersion === onDiskVersion) {
      run.status = "success";
      run.message = `Install of v${run.toVersion} completed; reconciled at startup (the completion event was lost when the process restarted).`;
    } else {
      run.status = "interrupted";
      run.message = `Run was interrupted before it finished (server process stopped). On-disk version is v${onDiskVersion}. A fresh upload may be attempted.`;
    }
  }
  if (settled) save(runs);
  return settled;
}
