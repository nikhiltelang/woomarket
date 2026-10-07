/**
 * Entry point. Loads .env, then either starts the application or — on a fresh copy with no
 * database configured — runs the web installer first and starts the application when it finishes.
 * Nothing that reads configuration is imported until we know which path we're on.
 */
import { isInstalled, loadEnvFile } from "./install/state";

process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection", reason));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception — exiting so the process manager restarts the app", err);
  process.exit(1);
});

async function boot() {
  loadEnvFile();
  if (!isInstalled()) {
    const { runInstaller } = await import("./install/installer");
    await runInstaller(); // resolves once installation succeeded and the installer server has closed
  }
  const { start } = await import("./main");
  await start();
}

boot().catch((err) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
