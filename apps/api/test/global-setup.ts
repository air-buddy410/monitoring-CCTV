import { execFileSync } from "node:child_process";
import pg from "pg";
import type { TestProject } from "vitest/node";

const ADMIN_URL =
  process.env.PANTAU_TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const DB = "pantau_test";
const OWNER = "pantau_owner";
const APP = "pantau_app";
const PW = "pantau_dev_pw"; // dummy local-only password

declare module "vitest" {
  export interface ProvidedContext {
    dbUrls: { admin: string; owner: string; app: string };
  }
}

function withDb(url: string, user?: string, db?: string): string {
  const u = new URL(url);
  if (user) {
    u.username = user;
    u.password = PW;
  }
  if (db) u.pathname = `/${db}`;
  return u.toString();
}

export default async function setup(project: TestProject) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const role of [OWNER, APP]) {
    const r = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
    if (r.rowCount === 0) {
      const extra = role === OWNER ? "CREATEDB" : "NOSUPERUSER NOBYPASSRLS";
      await admin.query(`create role ${role} login password '${PW}' ${extra}`);
    }
  }
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB} owner ${OWNER}`);
  await admin.end();

  const owner = withDb(ADMIN_URL, OWNER, DB);
  execFileSync("pnpm", ["--filter", "@pantau/db", "migrate"], {
    env: { ...process.env, MIGRATION_DATABASE_URL: owner, APP_DB_ROLE: APP },
    stdio: "inherit",
  });

  project.provide("dbUrls", {
    admin: withDb(ADMIN_URL, undefined, DB),
    owner,
    app: withDb(ADMIN_URL, APP, DB),
  });
}
