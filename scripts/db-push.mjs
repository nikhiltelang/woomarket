#!/usr/bin/env node
// `npm run db:push [-- --force]`: runs `drizzle-kit push` when the project has a
// drizzle config; otherwise there is no database schema to push and this is a no-op.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs"].find((f) => fs.existsSync(path.join(root, f)));

if (!config) {
  console.log("No drizzle config found; skipping database schema push.");
  process.exit(0);
}

const child = spawn("npx", ["drizzle-kit", "push", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
