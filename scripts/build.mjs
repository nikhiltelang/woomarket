#!/usr/bin/env node
// `npm run build`: the app ships as plain ES modules, so the build step
// syntax-checks every server, script and client module and fails on the first error.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["server", "scripts", "client/assets"];

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(m?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => collect(path.join(root, d)));
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`✕ ${path.relative(root, file)}\n${err.stderr?.toString() || err.message}`);
  }
}

if (failed) {
  console.error(`Build failed: ${failed} file(s) with syntax errors.`);
  process.exit(1);
}
console.log(`Build OK: ${files.length} module(s) checked.`);
