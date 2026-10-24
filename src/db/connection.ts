import Database from "better-sqlite3";
import { migrate, SCHEMA } from "./schema";

/**
 * Opens the gateway database (file or `:memory:`) and applies the schema
 * idempotently. WAL mode + busy_timeout keep the read-mostly HITL polling safe
 * under the single-writer model.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
