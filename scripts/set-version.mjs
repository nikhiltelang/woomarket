#!/usr/bin/env node
// Usage: npm run version:set -- 3.7.3
// Updates VERSION, package.json and the root version entries of package-lock.json
// in lockstep. Dependency version strings are left untouched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run version:set -- <major.minor.patch>");
  process.exit(1);
}

const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

fs.writeFileSync(path.join(root, "VERSION"), `${version}\n`);
console.log(`VERSION           → ${version}`);

const pkgFile = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
pkg.version = version;
writeJson(pkgFile, pkg);
console.log(`package.json      → ${version}`);

const lockFile = path.join(root, "package-lock.json");
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeJson(lockFile, lock);
  console.log(`package-lock.json → ${version}`);
}
