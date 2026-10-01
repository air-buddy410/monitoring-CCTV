import { startMockOnvif } from "./index";

// Standalone mock for manual demos. Dummy credentials only.
const m = await startMockOnvif({
  username: process.env.MOCK_USER ?? "dummy-admin",
  password: process.env.MOCK_PASSWORD ?? "dummy-password",
  channels: Number(process.env.MOCK_CHANNELS ?? 2),
  ptzChannels: [0],
});
console.log(`mock ONVIF device listening on ${m.host}:${m.port}`);
process.on("SIGINT", () => void m.stop().then(() => process.exit(0)));
