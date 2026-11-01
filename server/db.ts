import "dotenv/config";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Pool } from "pg";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export interface Sql {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
}
export interface Database extends Sql {
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(path?: string): Promise<Database> {
  let db: Database;
  if (process.env.DATABASE_URL && path === undefined) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 3000 });
    db = {
      query: async (s, p) => (await pool.query(s, p)).rows,
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT pg_advisory_xact_lock(724113)");
          const result = await fn({
            query: async (s, p) => (await c.query(s, p)).rows,
          });
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const dataDir =
      path === ":memory:"
        ? undefined
        : (path ?? process.env.DATA_DIR ?? ".data/database");
    if (dataDir) await mkdir(dirname(dataDir), { recursive: true });
    const pg = new PGlite({ dataDir, extensions: { btree_gist } });
    await pg.waitReady;
    let tail: Promise<any> = Promise.resolve();
    let pending = 0;
    // Every operation joins one queue: reads must not run inside another request's transaction.
    const queued = <T>(fn: () => Promise<T>): Promise<T> => {
      if (pending >= 64) return Promise.reject(Object.assign(new Error("Database queue is full"), { code: "DB_BUSY" }));
      pending++;
      const result = tail.then(fn);
      const settled = result.finally(() => { pending--; });
      tail = settled.catch(() => {});
      return settled;
    };
    db = {
      query: (s, p) => queued(async () => (await pg.query(s, p)).rows as any),
      tx: (fn) =>
        queued(() =>
          pg.transaction((t) =>
            fn({ query: async (s, p) => (await t.query(s, p)).rows as any }),
          ),
        ),
      close: async () => {
        await tail;
        await pg.close();
      },
    };
  }
  const schema = await readFile(
    new URL("./schema.sql", import.meta.url),
    "utf8",
  );
  // Advisory lock serializes migrations across API instances using a real PostgreSQL server.
  await db.tx(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(724112)");
    for (const statement of schema.split("-- statement")) {
      if (statement.trim()) await sql.query(statement);
    }
  });
  return db;
}
