#!/usr/bin/env node
// Builds the customer-ready release ZIP: dist-release/woomarket360-<version>-prod.zip
// The staged tree is verified to contain zero symlinks and zero replit-named
// entries before zipping; either check failing exits non-zero.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const outDir = path.join(root, "dist-release");
const stageDir = path.join(outDir, `stage-${version}`);
const zipFile = path.join(outDir, `woomarket360-${version}-prod.zip`);

// Excluded only at the project root.
const EXCLUDE_TOP = new Set([
  ".github", ".cache", ".upm", ".config", ".local", ".agents", ".claude", ".vscode", ".idea",
  ".update-backups", ".update-temp", ".update-runs.json", ".update-runs.json.tmp",
  "dist", "build", "dist-release", "coverage",
  "attached_assets", "uploads",
  ".replit", "replit.nix", "replit.md",
]);
// Excluded at any depth.
const EXCLUDE_ANYWHERE = new Set(["node_modules", ".git", ".DS_Store"]);

function excluded(name, isTop) {
  if (EXCLUDE_ANYWHERE.has(name)) return true;
  if (isTop && EXCLUDE_TOP.has(name)) return true;
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

function stage(src, dest, isTop) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (excluded(entry.name, isTop)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d); // copied as-is so verification catches it
    else if (entry.isDirectory()) stage(s, d, false);
    else fs.copyFileSync(s, d);
  }
}

function verify(dir) {
  const problems = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isSymbolicLink()) problems.push(`symlink: ${rel}`);
      if (/replit/i.test(entry.name)) problems.push(`replit entry: ${rel}`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  };
  walk(dir);
  return problems;
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(zipFile, { force: true });

try {
  stage(root, stageDir, true);

  const problems = verify(stageDir);
  if (problems.length) {
    console.error("Refusing to build release ZIP; the staged tree contains:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    execFileSync("zip", ["-r", "-q", "-X", zipFile, "."], { cwd: stageDir, stdio: "inherit" });
    const size = (fs.statSync(zipFile).size / 1024).toFixed(1);
    console.log(`Built ${path.relative(root, zipFile)} (${size} KiB)`);
  }
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
