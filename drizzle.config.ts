import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { MANAGED_TABLES } from "./shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure it.");
}

export default defineConfig({
  dialect: "mysql",
  schema: "./shared/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL },
  // Only manage the tables this codebase defines, so tables created from the
  // full schema script (Appendix A) for modules not yet implemented are never dropped.
  tablesFilter: [...MANAGED_TABLES],
  strict: false,
  verbose: true,
});
