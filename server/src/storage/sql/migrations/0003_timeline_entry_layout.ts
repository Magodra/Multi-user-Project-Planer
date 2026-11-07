/**
 * Timeline entries get a placement (callout above, bar on, callout below) and
 * a line. Nullable: older rows are normalized when read. Never modify this
 * file once it has been run — add a new migration instead.
 */
import type { Migration } from "kysely/migration";
import type { SqlDialectName } from "../db.js";

export function migration(_dialect: SqlDialectName): Migration {
  return {
    async up(db) {
      await db.schema.alterTable("timeline_entry").addColumn("placement", "varchar(16)").execute();
      await db.schema.alterTable("timeline_entry").addColumn("line", "integer").execute();
    },
    async down(db) {
      await db.schema.alterTable("timeline_entry").dropColumn("line").execute();
      await db.schema.alterTable("timeline_entry").dropColumn("placement").execute();
    },
  };
}
