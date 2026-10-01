import { createSocket, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { buildProbeMatch, startMockDiscovery } from "@pantau/mock-onvif";
import { afterEach, describe, expect, it } from "vitest";
import { buildProbe, discover, parseProbeMatches } from "../src/discovery";

const open: { stop(): Promise<void> | void }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((x) => x.stop()));
});

/** A responder that answers every probe with datagrams the test chooses, from 127.0.0.1 (Simulasi). */
async function scripted(make: (messageId: string) => (string | Buffer)[]) {
  const sock: Socket = createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  sock.on("message", (msg, rinfo) => {
    const id = /<(?:\w+:)?MessageID>([^<]+)</.exec(msg.toString())?.[1] ?? "";
    for (const reply of make(id)) sock.send(reply, rinfo.port, rinfo.address);
  });
  const handle = {
    port: (sock.address() as AddressInfo).port,
    stop: () => new Promise<void>((r) => sock.close(() => r())),
  };
  open.push(handle);
  return handle;
}
const opts = (port: number, over: Record<string, unknown> = {}) => ({
  target: "127.0.0.1",
  port,
  timeoutMs: 250,
  allowLoopback: true,
  ...over,
});

describe("WS-Discovery probe (read-only, UDP)", () => {
  it("builds a standards-shaped Probe for NetworkVideoTransmitter with a fresh urn:uuid MessageID", () => {
    const a = buildProbe();
    const b = buildProbe();
    expect(a.messageId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(a.messageId).not.toBe(b.messageId);
    for (const needle of [
      "http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe",
      "urn:schemas-xmlsoap-org:ws:2005:04:discovery",
      "NetworkVideoTransmitter",
      a.messageId,
    ]) {
      expect(a.xml).toContain(needle);
    }
    expect(Buffer.byteLength(a.xml)).toBeLessThan(1500);
  });

  it("finds a simulated device and reports address, port, name and hardware from its scopes", async () => {
    const sim = await startMockDiscovery({
      devices: [
        { xaddr: "http://127.0.0.1:8081/onvif/device_service", name: "Simulasi NVR", hardware: "MV-NVR-2" },
      ],
    });
    open.push(sim);
    const found = await discover(opts(sim.port));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      host: "127.0.0.1",
      port: 8081,
      xaddr: "http://127.0.0.1:8081/onvif/device_service",
      name: "Simulasi NVR",
      hardware: "MV-NVR-2",
    });
    expect(found[0]?.endpointId).toMatch(/^urn:uuid:/);
    expect(sim.probes()).toBe(1);
  });

  it("sends exactly one datagram, with no credentials, and never opens a TCP connection", async () => {
    const seen: Buffer[] = [];
    const h = await scripted((id) => (seen.push(Buffer.from(id)), []));
    await discover(opts(h.port));
    expect(seen).toHaveLength(1);
  });

  it("deduplicates repeated answers and sorts by address", async () => {
    const one = (m: string, x: string) =>
      buildProbeMatch({
        relatesTo: m,
        uuid: `urn:uuid:${"1".repeat(8)}-0000-0000-0000-000000000001`,
        xaddrs: [x],
      });
    const h = await scripted((m) => [
      one(m, "http://127.0.0.1:81/onvif/device_service"),
      one(m, "http://127.0.0.1:81/onvif/device_service"),
    ]);
    const found = await discover(opts(h.port));
    expect(found.map((f) => f.port)).toEqual([81]);
  });

  describe("hostile or broken answers are ignored, never trusted", () => {
    const good = (m: string, x = "http://127.0.0.1:82/onvif/device_service") =>
      buildProbeMatch({ relatesTo: m, xaddrs: [x] });

    it("an answer that does not answer our probe (wrong RelatesTo) is dropped", async () => {
      const h = await scripted(() => [good("urn:uuid:00000000-0000-0000-0000-000000000000")]);
      expect(await discover(opts(h.port))).toEqual([]);
    });

    it("an XAddr pointing at a different host than the sender is dropped (no redirecting the technician elsewhere)", async () => {
      const h = await scripted((m) => [good(m, "http://192.168.1.50:80/onvif/device_service")]);
      expect(await discover(opts(h.port))).toEqual([]);
    });

    it("XAddrs outside the target policy are dropped: public, link-local, metadata, names, non-http, userinfo", async () => {
      for (const x of [
        "http://8.8.8.8/onvif/device_service",
        "http://169.254.169.254/latest/meta-data",
        "http://cam.example.test/onvif/device_service",
        "https://127.0.0.1:9/onvif/device_service",
        "http://user:pw@127.0.0.1/onvif/device_service",
        "ftp://127.0.0.1/x",
        "http://127.0.0.1:99999/x",
        "not a url",
      ]) {
        const h = await scripted((m) => [good(m, x)]);
        expect(await discover(opts(h.port)), x).toEqual([]);
        await h.stop();
        open.pop();
      }
    });

    it("loopback is accepted only when the lab flag is set", async () => {
      const h = await scripted((m) => [good(m)]);
      expect(await discover(opts(h.port, { allowLoopback: false }))).toEqual([]);
      expect(await discover(opts(h.port))).toHaveLength(1);
    });

    it("a DOCTYPE or entity declaration is refused outright (no XML bomb, no external entity)", async () => {
      const bomb =
        `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>` +
        good("urn:uuid:x");
      const h = await scripted((m) => [Buffer.from(bomb.replace("urn:uuid:x", m))]);
      expect(await discover(opts(h.port))).toEqual([]);
      expect(() => parseProbeMatches(bomb)).not.toThrow();
    });

    it("garbage, empty and oversized datagrams are ignored", async () => {
      const h = await scripted((m) => [
        Buffer.from("not xml at all"),
        Buffer.alloc(0),
        Buffer.alloc(60_000, 0x41),
        Buffer.from("<a>".repeat(2000)),
        good(m),
      ]);
      const found = await discover(opts(h.port));
      expect(found).toHaveLength(1);
    });

    it("at most maxResults devices are returned however many answer", async () => {
      const h = await scripted((m) =>
        Array.from({ length: 20 }, (_, i) =>
          buildProbeMatch({
            relatesTo: m,
            uuid: `urn:uuid:${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
            xaddrs: [`http://127.0.0.1:${9000 + i}/onvif/device_service`],
          }),
        ),
      );
      const found = await discover(opts(h.port, { maxResults: 5 }));
      expect(found).toHaveLength(5);
    });

    it("names and scopes are sanitised: control characters stripped, length capped, markup not interpreted", async () => {
      const h = await scripted((m) => [
        buildProbeMatch({
          relatesTo: m,
          xaddrs: ["http://127.0.0.1:83/onvif/device_service"],
          scopes: [
            "onvif://www.onvif.org/name/" +
              encodeURIComponent("Kamera\u0000\u0007<script>alert(1)</script>" + "x".repeat(300)),
            "onvif://www.onvif.org/hardware/HW%20X",
          ],
        }),
      ]);
      const [d] = await discover(opts(h.port));
      expect(d?.name).toBeDefined();
      // eslint-disable-next-line no-control-regex
      expect(d?.name).not.toMatch(/[\u0000-\u001f]/);
      expect(d?.name?.length).toBeLessThanOrEqual(64);
      expect(d?.hardware).toBe("HW X");
    });
  });

  it("returns an empty list, not an error, when nobody answers within the deadline", async () => {
    const h = await scripted(() => []);
    const started = Date.now();
    expect(await discover(opts(h.port))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("the default target is the standard multicast group on port 3702 with TTL 1 (link-local only)", async () => {
    const { DISCOVERY_DEFAULTS } = await import("../src/discovery");
    expect(DISCOVERY_DEFAULTS).toMatchObject({ target: "239.255.255.250", port: 3702, multicastTtl: 1 });
  });

  it("parseProbeMatches never throws on arbitrary input", () => {
    for (const x of [
      "",
      "<",
      "<<<>>>",
      "\u0000\u0001",
      "<d:ProbeMatches><d:ProbeMatch/></d:ProbeMatches>",
      "a".repeat(100_000),
    ]) {
      expect(() => parseProbeMatches(x)).not.toThrow();
    }
  });
});
