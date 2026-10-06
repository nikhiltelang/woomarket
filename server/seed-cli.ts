// `npm run seed`: separate entry so the bundled server never runs this (and never closes the pool).
import { closeDatabase, connectDatabase } from "./db";
import { logger } from "./lib/logger";
import { runSeed } from "./seed";

connectDatabase()
  .then(runSeed)
  .then(() => logger.info("Seed complete"))
  .catch((err) => {
    logger.error({ err }, "Seed failed");
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
