import { startMockOnvif } from "./index";

// Runner khusus container compose AC1. Tidak mengubah cli.ts (yang dipakai manual/README).
// Host dan port dibaca dari env supaya container bisa bind ke 127.0.0.1 dengan port tetap,
// sehingga API yang juga di network_mode host bisa menjangkau alamat IP literal (kebijakan target).
const host = process.env.MOCK_HOST ?? "127.0.0.1";
const port = Number(process.env.MOCK_PORT ?? 18081);

const m = await startMockOnvif({
  host,
  port,
  username: process.env.MOCK_USER ?? "dummy-admin",
  password: process.env.MOCK_PASSWORD ?? "dummy-password",
  channels: Number(process.env.MOCK_CHANNELS ?? 2),
  ptzChannels: [0],
});
console.log(`mock ONVIF device listening on ${m.host}:${m.port}`);

const stop = async () => {
  await m.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
