// Minimal async facade over node:sqlite with the expo-sqlite methods lib/doc-store.ts uses.
import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlValue } from "../lib/doc-store.ts";

type Bind = Exclude<SqlValue, boolean> | bigint;
const bind = (params: SqlValue[]): Bind[] => params.map((p) => (typeof p === "boolean" ? Number(p) : p));

export function fakeSql(path = ":memory:"): Sql & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    async execAsync(source) {
      db.exec(source);
    },
    async runAsync(source, params) {
      return db.prepare(source).run(...bind(params));
    },
    async getAllAsync<T>(source: string, params: SqlValue[]) {
      return db.prepare(source).all(...bind(params)) as T[];
    },
    async getFirstAsync<T>(source: string, params: SqlValue[]) {
      return (db.prepare(source).get(...bind(params)) as T | undefined) ?? null;
    },
    async withTransactionAsync(task) {
      db.exec("BEGIN");
      try {
        await task();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => db.close(),
  };
}
