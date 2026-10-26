import fs from "node:fs";
import path from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { applyBootstrap } from "./bootstrap";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database;
}

/** Open (and bootstrap) a database at the given path — used by tests too. */
export function openDatabase(filePath: string): DbHandle {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const sqlite = new BetterSqlite3(filePath);
  applyBootstrap(sqlite);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export function dataDir(): string {
  return process.env.BOOK_WRITER_DATA_DIR ?? path.join(process.cwd(), "data");
}

// Cached on globalThis so Next.js dev-mode HMR reuses one connection.
const globalForDb = globalThis as unknown as { __bookWriterDb?: DbHandle };

export function getDbHandle(): DbHandle {
  if (!globalForDb.__bookWriterDb) {
    globalForDb.__bookWriterDb = openDatabase(
      path.join(dataDir(), "book-writer.db"),
    );
  }
  return globalForDb.__bookWriterDb;
}

export function getDb(): Db {
  return getDbHandle().db;
}
