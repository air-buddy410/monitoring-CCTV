import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Forward-only SQL migrations applied in filename order, each in its own transaction. */
export async function migrate(connectionString: string, opts: { appRole: string }): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(opts.appRole)) throw new Error("invalid APP_DB_ROLE");
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727001)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8").replaceAll("{{APP_ROLE}}", opts.appRole);
      await client.query("begin");
      try {
        await client.query(text);
        await client.query("insert into schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        applied.push(f);
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    await client.end();
  }
  return applied;
}
