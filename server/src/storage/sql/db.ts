import { Kysely, MssqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import type { Dialect } from "kysely";
import Database from "better-sqlite3";
import pg from "pg";
import * as tarn from "tarn";
import * as tedious from "tedious";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SqlDialectName = "postgres" | "sqlite" | "mssql";

/** Tables are addressed dynamically (see tables.ts), so the schema type is open. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

export interface SqlConnectionConfig {
  dialect: SqlDialectName;
  connectionString: string;
}

export function createKysely(config: SqlConnectionConfig): Kysely<AnyDb> {
  return new Kysely<AnyDb>({ dialect: createDialect(config) });
}

function createDialect({ dialect, connectionString }: SqlConnectionConfig): Dialect {
  switch (dialect) {
    case "sqlite": {
      const file = sqlitePath(connectionString);
      if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      const database = new Database(file);
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      return new SqliteDialect({ database });
    }
    case "postgres":
      return new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) });
    case "mssql": {
      const options = parseMssqlUrl(connectionString);
      return new MssqlDialect({
        tarn: { ...tarn, options: { min: 0, max: 10 } },
        tedious: {
          ...tedious,
          connectionFactory: () => new tedious.Connection(options),
        },
      });
    }
  }
}

/** Accepts "sqlite:./data/planning.db", "file:./x.db", a plain path or ":memory:". */
export function sqlitePath(connectionString: string): string {
  return connectionString.replace(/^(sqlite|file):(\/\/)?/, "") || ":memory:";
}

/**
 * Parse "mssql://user:pass@host:1433/database?encrypt=true&trustServerCertificate=true".
 */
export function parseMssqlUrl(connectionString: string): tedious.ConnectionConfiguration {
  const url = new URL(connectionString);
  if (url.protocol !== "mssql:" && url.protocol !== "sqlserver:") {
    throw new Error("SQL Server connection string must be a mssql:// URL");
  }
  const flag = (name: string, fallback: boolean) => {
    const v = url.searchParams.get(name);
    return v === null ? fallback : v === "true";
  };
  return {
    server: url.hostname,
    authentication: {
      type: "default",
      options: {
        userName: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      },
    },
    options: {
      port: url.port ? Number(url.port) : 1433,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
      encrypt: flag("encrypt", true),
      trustServerCertificate: flag("trustServerCertificate", false),
    },
  };
}
