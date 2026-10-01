import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export { migrate } from "./migrate";
export * from "./schema";
export { schema };

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDb(connectionString: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { pool, db, close: () => pool.end() };
}

/**
 * Run `fn` inside a transaction scoped to one tenant. `app.org_id` is set with
 * transaction-local scope, so it can never leak to another request on a pooled connection.
 */
export async function withTenant<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Transaction scoped to the one row whose token hash was presented. Used before the tenant is known (agent
 * authentication and enrollment); the RLS policy `token_lookup` exposes only that row, read-only.
 */
export async function withTokenHash<T>(db: Db, tokenHash: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.token_hash', ${tokenHash}, true)`);
    return fn(tx);
  });
}

/** Within a token-hash transaction, switch to the tenant that the found row belongs to. */
export async function enterTenant(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
}

export function newId(prefix: "site" | "dev" | "cam" | "aud" | "grt" | "agt" | "enr"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
