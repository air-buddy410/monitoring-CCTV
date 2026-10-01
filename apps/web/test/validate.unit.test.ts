import { describe, expect, it } from "vitest";
import { safeNext } from "../src/lib/format";
import { isIpLiteral, NEW_SITE, validateDeviceForm } from "../src/lib/validate";

describe("isIpLiteral", () => {
  it("accepts canonical IPv4 and IPv6, rejects names and odd spellings", () => {
    for (const ok of ["192.168.1.20", "10.0.0.1", "255.255.255.255", "::1", "fd12:3456::1"])
      expect(isIpLiteral(ok), ok).toBe(true);
    for (const bad of [
      "camera.local",
      "localhost",
      "0177.0.0.1",
      "2130706433",
      "127.1",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      " 10.0.0.1",
      "",
    ]) {
      expect(isIpLiteral(bad), bad).toBe(false);
    }
  });
});

const ok = {
  siteId: "site_1",
  newSiteName: "",
  name: "Gudang",
  host: "192.168.1.20",
  port: "80",
  username: "u",
  password: "p",
};

describe("validateDeviceForm", () => {
  it("passes a complete form", () => expect(validateDeviceForm(ok)).toEqual({}));
  it("reports every missing field in Indonesian", () => {
    const e = validateDeviceForm({
      siteId: "",
      newSiteName: "",
      name: "",
      host: "",
      port: "",
      username: "",
      password: "",
    });
    expect(Object.keys(e).sort()).toEqual(["host", "name", "password", "port", "siteId", "username"]);
  });
  it("requires a name for a new site", () => {
    expect(validateDeviceForm({ ...ok, siteId: NEW_SITE }).newSiteName).toMatch(/lokasi baru/);
  });
  it("rejects hostnames and out-of-range ports", () => {
    expect(validateDeviceForm({ ...ok, host: "cam.example.test" }).host).toMatch(/alamat IP/);
    expect(validateDeviceForm({ ...ok, port: "70000" }).port).toMatch(/1 sampai 65535/);
    expect(validateDeviceForm({ ...ok, port: "8x" }).port).toBeDefined();
  });
});

describe("safeNext (no open redirect)", () => {
  it("keeps same-site paths and rejects everything else", () => {
    expect(safeNext("/audit")).toBe("/audit");
    expect(safeNext("/perangkat?d=dev_1")).toBe("/perangkat?d=dev_1");
    for (const bad of [
      "//evil.test",
      "https://evil.test",
      "/\\evil.test",
      "javascript:alert(1)",
      "",
      null,
      undefined,
    ]) {
      expect(safeNext(bad as string | null | undefined), String(bad)).toBe("/perangkat");
    }
  });
});
