import { migrate } from "./migrate";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL is required (connect as the schema owner role)");
  process.exit(1);
}
const applied = await migrate(url, { appRole: process.env.APP_DB_ROLE ?? "pantau_app" });
console.log(applied.length ? `applied: ${applied.join(", ")}` : "no pending migrations");
