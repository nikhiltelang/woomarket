// `npm run db:migrate`: applies the SQL migrations in ./migrations.
import path from "node:path";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { closeDatabase, connectDatabase, db } from "./db";
import { logger } from "./lib/logger";

connectDatabase()
  .then(() => migrate(db, { migrationsFolder: path.resolve(process.cwd(), "migrations") }))
  .then(() => logger.info("Migrations applied"))
  .catch((err) => {
    logger.error({ err }, "Migration failed");
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
