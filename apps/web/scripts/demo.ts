import { type ChildProcess, spawn } from "node:child_process";
import { loadDemoFrames, startMockOnvif } from "@pantau/mock-onvif";
import { prepareDb } from "./prepare-db";

// Local "Simulasi" stack: PostgreSQL (must already run), two mock ONVIF devices, the real API and the web app.
// Everything binds to localhost and uses dummy credentials. No physical camera is involved.
const WEB = 3100;
const API = 3101;
const MOCK_NVR = 4101;
const MOCK_SINGLE = 4102;
const DEMO_EMAIL = "demo@pantau.test";
const DEMO_PASSWORD = "Dummy-Demo-Pass-123";
const origin = `http://localhost:${WEB}`;

const children: ChildProcess[] = [];
const run = (cmd: string, args: string[], env: Record<string, string>) => {
  const c = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  children.push(c);
  return c;
};
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function waitFor(url: string) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

const frames = loadDemoFrames();
await startMockOnvif({
  username: "dummy-admin",
  password: "dummy-password",
  port: MOCK_NVR,
  channels: 2,
  ptzChannels: [0],
  manufacturer: "Simulasi",
  model: "SIM-NVR-2",
  firmware: "sim-1.0",
  snapshotFrames: [frames[0] as Buffer, frames[1] as Buffer],
});
await startMockOnvif({
  username: "dummy-admin",
  password: "dummy-password",
  port: MOCK_SINGLE,
  channels: 1,
  manufacturer: "Simulasi",
  model: "SIM-CAM-1",
  firmware: "sim-0.9",
  snapshotFrames: [frames[2] as Buffer],
});

const db = await prepareDb("pantau_demo");
const demoEnv = {
  NEXT_PUBLIC_DEMO: "1",
  NEXT_PUBLIC_DEMO_MOCKS: JSON.stringify([
    { label: "Simulasi NVR 2 kanal", port: MOCK_NVR },
    { label: "Simulasi kamera tunggal", port: MOCK_SINGLE },
  ]),
  PANTAU_API_ORIGIN: `http://127.0.0.1:${API}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

run("pnpm", ["--filter", "@pantau/api", "exec", "tsx", "src/server.ts"], {
  NODE_ENV: "development",
  PORT: String(API),
  DATABASE_URL: db.appUrl,
  BASE_URL: origin,
  AUTH_SECRET: "demo-secret-demo-secret-demo-secret-123456",
  VAULT_KEY: Buffer.alloc(32, 9).toString("base64"),
  ALLOW_LOOPBACK_TARGETS: "true",
  LOG_LEVEL: "warn",
});
await waitFor(`http://localhost:${API}/healthz`);

// Seed one demo user and organization through the real API.
const json = { "content-type": "application/json", origin };
const up = await fetch(`http://localhost:${API}/api/auth/sign-up/email`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD, name: "Operator Simulasi" }),
});
const cookie = up.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const org = (await (
  await fetch(`http://localhost:${API}/api/auth/organization/create`, {
    method: "POST",
    headers: { ...json, cookie },
    body: JSON.stringify({ name: "Lab Simulasi", slug: "lab-simulasi" }),
  })
).json()) as { id: string };
console.log(`seeded user ${DEMO_EMAIL} and organization ${org.id}`);

const build = spawn("pnpm", ["exec", "next", "build"], {
  stdio: "inherit",
  env: { ...process.env, ...demoEnv },
});
await new Promise<void>((resolve, reject) =>
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("next build failed")))),
);
run("pnpm", ["exec", "next", "start", "-p", String(WEB)], demoEnv);
await waitFor(`${origin}/login`);
console.log(
  `\nPANTAU (Simulasi) siap: ${origin}\nAkun dummy: ${DEMO_EMAIL} / ${DEMO_PASSWORD}\nTekan Ctrl+C untuk berhenti.\n`,
);
