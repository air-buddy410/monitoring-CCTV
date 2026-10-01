import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app";
import { loadConfig } from "./config";

// Builds the app with throw-away dummy config (no database connection is made) and dumps the OpenAPI document.
const config = loadConfig({
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  BASE_URL: "http://localhost:3000",
  AUTH_SECRET: "x".repeat(40),
  VAULT_KEY: Buffer.alloc(32).toString("base64"),
  LOG_LEVEL: "silent",
});
const { app, close } = await buildApp({ config });
await app.ready();
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/openapi.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await close();
console.log(`wrote ${out}`);
