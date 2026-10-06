import { createApp } from "./app.js";
import { usingDefaultCredentials } from "./auth.js";
import { reconcileStaleRuns } from "./update-runs.js";
import { getRoot, readVersion } from "./paths.js";

const settled = reconcileStaleRuns();
console.log(`[app-update] Startup reconciler: settled ${settled} stale 'running' update_runs row(s).`);

if (process.env.NODE_ENV === "production") {
  if (!process.env.SESSION_SECRET) console.warn("[server] SESSION_SECRET is not set; sessions will reset on every restart.");
  if (usingDefaultCredentials()) console.warn("[server] Using default demo credentials. Set SUPERADMIN_PASSWORD and ADMIN_PASSWORD.");
}

const port = Number(process.env.PORT) || 5001;
createApp().listen(port, () => {
  console.log(`[server] WooMarket360 v${readVersion(getRoot())} listening on http://localhost:${port}`);
});
