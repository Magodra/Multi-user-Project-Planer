/**
 * Migration registry. Migrations are imported statically (no file scanning),
 * so they work the same from tsx, tsc output and tests.
 * `npm run migrate:make <name>` appends new entries here.
 */
import type { Migration } from "kysely/migration";
import type { SqlDialectName } from "../db.js";
import { migration as m0001 } from "./0001_initial.js";
import { migration as m0002 } from "./0002_oauth_client.js";

export function getMigrations(dialect: SqlDialectName): Record<string, Migration> {
  return {
    "0001_initial": m0001(dialect),
    "0002_oauth_client": m0002(dialect),
  };
}
