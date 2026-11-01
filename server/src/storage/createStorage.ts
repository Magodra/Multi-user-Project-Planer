import type { AppConfig } from "../config/config.js";
import { FileAdapter } from "./file/FileAdapter.js";
import { SqlAdapter } from "./sql/SqlAdapter.js";
import { createKysely } from "./sql/db.js";
import type { StorageAdapter } from "./StorageAdapter.js";

/** Pick the backend from config. Nothing outside /storage knows which one is used. */
export async function createStorage(
  config: Pick<AppConfig, "backend" | "file" | "sql">,
): Promise<StorageAdapter> {
  if (config.backend === "file") {
    return new FileAdapter(config.file.path);
  }
  return SqlAdapter.open(createKysely(config.sql), config.sql.dialect);
}
