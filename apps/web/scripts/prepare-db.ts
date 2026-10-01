import { execFileSync } from "node:child_process";
import pg from "pg";

const ADMIN_URL =
  process.env.PANTAU_TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const PW = "pantau_dev_pw"; // dummy, local only
const OWNER = "pantau_owner";
const APP = "pantau_app";

const withDb = (url: string, user?: string, db?: string) => {
  const u = new URL(url);
  if (user) {
    u.username = user;
    u.password = PW;
  }
  if (db) u.pathname = `/${db}`;
  return u.toString();
};

export interface PreparedDb {
  appUrl: string;
  adminUrl: string;
}

/** Fresh database with roles and migrations, for browser tests and the local demo. */
export async function prepareDb(dbName: string): Promise<PreparedDb> {
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error("invalid database name");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const role of [OWNER, APP]) {
    const r = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
    if (r.rowCount === 0) {
      const extra = role === OWNER ? "CREATEDB" : "NOSUPERUSER NOBYPASSRLS";
      await admin.query(`create role ${role} login password '${PW}' ${extra}`);
    }
  }
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName} owner ${OWNER}`);
  await admin.end();
  execFileSync("pnpm", ["--filter", "@pantau/db", "migrate"], {
    env: { ...process.env, MIGRATION_DATABASE_URL: withDb(ADMIN_URL, OWNER, dbName), APP_DB_ROLE: APP },
    stdio: "inherit",
  });
  return { appUrl: withDb(ADMIN_URL, APP, dbName), adminUrl: withDb(ADMIN_URL, undefined, dbName) };
}

if (process.argv[1]?.endsWith("prepare-db.ts")) {
  const db = process.argv[2] ?? "pantau_e2e";
  prepareDb(db).then(() => console.log(`database ${db} ready`));
}
