import { describe, expect, it } from "vitest";
import { type CameraT, type DeviceT, EMPTY_FILTERS, filterDevices, isFiltering } from "../src/lib/filters";

const dev = (o: Partial<DeviceT>): DeviceT => ({
  id: "dev_1",
  siteId: "site_a",
  name: "Gudang",
  kind: "ipc",
  brand: "hikvision",
  model: "DS-2CD",
  firmware: "V5.7.1",
  adapterId: "onvif-generic",
  host: "10.0.0.5",
  port: 80,
  capabilities: { snapshot: "ya", ptz: "tidak" },
  status: "online",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...o,
});
const devices = [
  dev({ id: "d1", name: "Gudang" }),
  dev({
    id: "d2",
    name: "Lobi",
    brand: "dahua",
    model: "IPC-HDW",
    host: "10.0.0.9",
    siteId: "site_b",
    kind: "nvr",
    capabilities: { snapshot: "ya", ptz: "ya" },
  }),
  dev({
    id: "d3",
    name: "Parkir",
    brand: "axis",
    host: "192.168.1.3",
    capabilities: { snapshot: "tidak", ptz: "belum-diuji" },
  }),
];
const cams = new Map<string, CameraT[]>([
  [
    "d2",
    [
      {
        id: "c1",
        deviceId: "d2",
        siteId: "site_b",
        channel: "VS_0",
        name: "Pintu Barat",
        hasPtz: true,
        mainCodec: "H264",
        subCodec: null,
        status: "online",
        sortOrder: 0,
      },
    ],
  ],
]);
const ids = (r: DeviceT[]) => r.map((d) => d.id);

describe("filterDevices", () => {
  it("returns everything without filters", () => {
    expect(ids(filterDevices(devices, EMPTY_FILTERS, cams))).toEqual(["d1", "d2", "d3"]);
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
  });
  it("searches name, brand, model, host and camera names, case-insensitive, all words must match", () => {
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, q: "LOBI" }, cams))).toEqual(["d2"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, q: "dahua ipc" }, cams))).toEqual(["d2"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, q: "10.0.0.5" }, cams))).toEqual(["d1"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, q: "pintu" }, cams))).toEqual(["d2"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, q: "dahua gudang" }, cams))).toEqual([]);
  });
  it("filters by site, kind and proven capability only", () => {
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, siteId: "site_b" }, cams))).toEqual(["d2"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, kind: "nvr" }, cams))).toEqual(["d2"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, cap: "ptz" }, cams))).toEqual(["d2"]);
    expect(ids(filterDevices(devices, { ...EMPTY_FILTERS, cap: "snapshot" }, cams))).toEqual(["d1", "d2"]);
  });
  it("combines filters and reports no results", () => {
    expect(filterDevices(devices, { q: "axis", siteId: "site_b", kind: "", cap: "" }, cams)).toEqual([]);
    expect(isFiltering({ ...EMPTY_FILTERS, q: " x " })).toBe(true);
  });
});
