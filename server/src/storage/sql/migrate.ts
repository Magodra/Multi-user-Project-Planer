import type { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import type { AnyDb, SqlDialectName } from "./db.js";
import { getMigrations } from "./migrations/index.js";

export async function migrateToLatest(
  db: Kysely<AnyDb>,
  dialect: SqlDialectName,
): Promise<string[]> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => getMigrations(dialect) },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
