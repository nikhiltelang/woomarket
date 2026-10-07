import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/** The .env file the app reads and the installer writes (ENV_FILE overrides the default ./.env). */
export const envFilePath = () => path.resolve(process.env.ENV_FILE || path.join(process.cwd(), ".env"));

/** Loads .env into process.env without overriding variables already set by the environment. */
export function loadEnvFile(): void {
  const file = envFilePath();
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

/**
 * The app counts as installed once it has a database to talk to. Deployments that pass
 * DATABASE_URL through the environment (Docker, PM2) therefore never see the installer.
 */
export const isInstalled = () => Boolean(process.env.DATABASE_URL?.trim());
