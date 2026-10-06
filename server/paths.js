import fs from "node:fs";
import path from "node:path";

/** Project root managed by the updater. `APP_UPDATE_ROOT` lets tests point it at a tmpdir. */
export function getRoot() {
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
    backupRoot,
    backupDir: path.join(backupRoot, "latest"),
    backupMetaFile: path.join(backupRoot, "latest.json"),
    runsFile: path.join(root, ".update-runs.json"),
  };
}

/** Reads `VERSION`, falling back to `package.json` version. */
export function readVersion(dir) {
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
