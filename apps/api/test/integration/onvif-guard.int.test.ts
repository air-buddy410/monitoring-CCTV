import { createOnvifClient } from "@pantau/onvif-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestEnv, createTestEnv, DEVICE_PASSWORD, DEVICE_USERNAME } from "../helpers";

describe("ONVIF whitelist enforced at transport level against the mock", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => env.close());

  async function client() {
    const mock = await env.startMock();
    const c = createOnvifClient({
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
      timeoutMs: 1500,
    });
    await c.connect();
    return { c, mock };
  }

  it("allows read-only operations (GetDeviceInformation reaches the device)", async () => {
    const { c, mock } = await client();
    const info = await c.getDeviceInformation();
    expect(info.manufacturer).toBeTruthy();
    expect(mock.requests().map((r) => r.operation)).toContain("GetDeviceInformation");
  });

  it.each([
    ["SystemReboot", (c: Awaited<ReturnType<typeof client>>["c"]) => c.raw.device.systemReboot()],
    [
      "SetSystemDateAndTime",
      (c: Awaited<ReturnType<typeof client>>["c"]) =>
        c.raw.device.setSystemDateAndTime({ dateTimeType: "Manual", daylightSavings: false } as never),
    ],
    [
      "CreateUsers",
      (c: Awaited<ReturnType<typeof client>>["c"]) =>
        c.raw.device.createUsers({ user: [{ username: "x", password: "y", userLevel: "Administrator" }] } as never),
    ],
    ["DeleteUsers", (c: Awaited<ReturnType<typeof client>>["c"]) => c.raw.device.deleteUsers({ username: ["x"] } as never)],
    [
      "StartFirmwareUpgrade",
      (c: Awaited<ReturnType<typeof client>>["c"]) => c.raw.device.startFirmwareUpgrade(),
    ],
    [
      "SetHostname",
      (c: Awaited<ReturnType<typeof client>>["c"]) => c.raw.device.setHostname({ name: "pwned" } as never),
    ],
  ])("rejects %s before it is sent: the mock never sees it", async (op, run) => {
    const { c, mock } = await client();
    await expect(run(c)).rejects.toMatchObject({ code: "onvif_method_not_allowed" });
    expect(mock.requests().map((r) => r.operation)).not.toContain(op);
  });

  it("rejects an arbitrary hand-built SOAP envelope for a non-whitelisted operation", async () => {
    const { c, mock } = await client();
    await expect(
      c.raw.request({ service: "device", body: { SystemReboot: { $: { xmlns: "http://www.onvif.org/ver10/device/wsdl" } } } }),
    ).rejects.toMatchObject({ code: "onvif_method_not_allowed" });
    expect(mock.requests().map((r) => r.operation)).not.toContain("SystemReboot");
  });

  it("enforces a deadline when the device hangs", async () => {
    const mock = await env.startMock({ hangOperations: ["GetDeviceInformation"] });
    const c = createOnvifClient({
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
      timeoutMs: 700,
    });
    await c.connect();
    const t0 = Date.now();
    await expect(c.getDeviceInformation()).rejects.toMatchObject({ code: "onvif_timeout" });
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
