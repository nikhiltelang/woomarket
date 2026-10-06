import { childLogger } from "../lib/logger";
import { getRoot, readVersion } from "./controller";
import { runStore } from "./run-store";

const log = childLogger("app-update");

/**
 * Startup reconciler: settles update_runs rows left at `running` by a process that
 * died before its finaliser ran. If the on-disk VERSION matches the run's target,
 * the install landed and only the completion event was lost.
 */
export async function reconcileStaleRuns(): Promise<number> {
  const store = runStore();
  const running = await store.listRunning();
  const onDisk = readVersion(getRoot());
  for (const run of running) {
    if (run.toVersion && run.toVersion === onDisk) {
      await store.finish(run.id, "success", `Install of v${run.toVersion} completed; reconciled at startup (the completion event was lost when the process restarted).`);
    } else {
      await store.finish(
        run.id,
        "interrupted",
        `Run was interrupted before it finished (server process stopped). On-disk version is v${onDisk}. A fresh upload may be attempted.`,
      );
    }
  }
  log.info(`[app-update] Startup reconciler: settled ${running.length} stale 'running' update_runs row(s).`);
  return running.length;
}
