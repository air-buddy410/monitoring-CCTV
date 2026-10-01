import { randomUUID } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";

/** WS-Discovery responder for tests and the lab demo. Everything it announces is a Simulasi device. */
export interface MockDiscoveryDevice {
  xaddr: string;
  name?: string;
  hardware?: string;
  uuid?: string;
}

const NS =
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"';

export function buildProbeMatch(o: {
  relatesTo: string;
  uuid?: string;
  xaddrs: string[];
  scopes?: string[];
  types?: string;
}): string {
  const uuid = o.uuid ?? `urn:uuid:${randomUUID()}`;
  const scopes = o.scopes ?? ["onvif://www.onvif.org/name/Simulasi", "onvif://www.onvif.org/hardware/SIM"];
  return (
    `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Header>` +
    `<a:MessageID>urn:uuid:${randomUUID()}</a:MessageID><a:RelatesTo>${o.relatesTo}</a:RelatesTo>` +
    `<a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To>` +
    `<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action></s:Header><s:Body>` +
    `<d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>${uuid}</a:Address></a:EndpointReference>` +
    `<d:Types>${o.types ?? "dn:NetworkVideoTransmitter"}</d:Types><d:Scopes>${scopes.join(" ")}</d:Scopes>` +
    `<d:XAddrs>${o.xaddrs.join(" ")}</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`
  );
}

export async function startMockDiscovery(o: {
  devices: MockDiscoveryDevice[];
  host?: string;
  port?: number;
}) {
  const sock: Socket = createSocket("udp4");
  await new Promise<void>((r) => sock.bind(o.port ?? 0, o.host ?? "127.0.0.1", r));
  let probes = 0;
  sock.on("message", (msg, rinfo) => {
    const text = msg.toString();
    if (!text.includes("Probe")) return;
    probes++;
    const relatesTo = /<(?:\w+:)?MessageID>([^<]+)</.exec(text)?.[1] ?? "";
    for (const d of o.devices) {
      const scopes = [
        ...(d.name ? [`onvif://www.onvif.org/name/${encodeURIComponent(d.name)}`] : []),
        ...(d.hardware ? [`onvif://www.onvif.org/hardware/${encodeURIComponent(d.hardware)}`] : []),
      ];
      sock.send(
        buildProbeMatch({ relatesTo, uuid: d.uuid, xaddrs: [d.xaddr], scopes }),
        rinfo.port,
        rinfo.address,
      );
    }
  });
  return {
    port: (sock.address() as AddressInfo).port,
    probes: () => probes,
    stop: () => new Promise<void>((r) => sock.close(() => r())),
  };
}
