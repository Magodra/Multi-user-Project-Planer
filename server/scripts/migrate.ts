/** `npm run migrate`: run Kysely migrations against the configured SQL database. */
import { loadConfig } from "../src/config/config.js";
import { createKysely } from "../src/storage/sql/db.js";
import { migrateToLatest } from "../src/storage/sql/migrate.js";

const config = loadConfig();
if (config.backend !== "sql") {
  console.log("backend is 'file' — nothing to migrate");
  process.exit(0);
}
const db = createKysely(config.sql);
try {
  const applied = await migrateToLatest(db, config.sql.dialect);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await db.destroy();
}
