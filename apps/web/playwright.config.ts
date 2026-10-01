import { defineConfig, devices } from "@playwright/test";

const WEB = 3100;
const API = 3101;
const DB = process.env.PANTAU_E2E_DB ?? "pantau_e2e";
const ADMIN = process.env.PANTAU_TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

const appUrl = (() => {
  const u = new URL(ADMIN);
  u.username = "pantau_app";
  u.password = "pantau_dev_pw";
  u.pathname = `/${DB}`;
  return u.toString();
})();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: "off",
    screenshot: "off",
    locale: "id-ID",
    timezoneId: "Asia/Makassar",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Real backend. Rate limits are small on purpose so 429 handling is exercised against the real API.
      command: "pnpm --filter @pantau/api exec tsx src/server.ts",
      url: `http://localhost:${API}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "development",
        PORT: String(API),
        DATABASE_URL: appUrl,
        BASE_URL: `http://localhost:${WEB}`,
        AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-123456",
        VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
        ALLOW_LOOPBACK_TARGETS: "true",
        ONVIF_TIMEOUT_MS: "1500",
        SNAPSHOT_TIMEOUT_MS: "1500",
        LOG_LEVEL: "info",
        RATE_LIMIT_PROBE_PER_MIN: "6",
        RATE_LIMIT_SNAPSHOT_PER_MIN: "6",
        RATE_LIMIT_AUTH_PER_MIN: "1000",
      },
    },
    {
      // Production build of the web app. Build first with PANTAU_API_ORIGIN set (see docs/DEMO.md).
      command: `pnpm exec next start -p ${WEB}`,
      url: `http://localhost:${WEB}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
