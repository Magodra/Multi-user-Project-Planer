/**
 * OAuth clients registered for MCP (dynamic client registration). Never
 * modify this file once it has been run — add a new migration instead.
 */
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import type { SqlDialectName } from "../db.js";

export function migration(dialect: SqlDialectName): Migration {
  const jsonType = dialect === "mssql" ? sql`nvarchar(max)` : sql`text`;
  return {
    async up(db) {
      await db.schema
        .createTable("oauth_client")
        .addColumn("id", "varchar(64)", (c) => c.primaryKey())
        .addColumn("version", "integer", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .addColumn("data", jsonType, (c) => c.notNull())
        .execute();
    },
    async down(db) {
      await db.schema.dropTable("oauth_client").execute();
    },
  };
}
