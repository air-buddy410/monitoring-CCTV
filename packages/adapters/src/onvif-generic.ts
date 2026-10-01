import type { CapabilityMap, ProbedChannel, ProbeResult } from "@pantau/contracts";
import {
  createOnvifClient,
  type GuardedOnvif,
  OnvifMethodNotAllowedError,
  OnvifTimeoutError,
} from "@pantau/onvif-client";
import { Agent, request } from "undici";
import { AdapterError } from "./errors";
import { buildDigestAuthorization, parseDigestChallenge } from "./http-digest";

export interface DeviceConn {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}

interface ProfileLike {
  token?: string;
  videoSourceConfiguration?: { sourceToken?: string; name?: string };
  videoEncoderConfiguration?: { encoding?: string; resolution?: { width?: number; height?: number } };
  PTZConfiguration?: unknown;
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** Map any library/network failure to a stable adapter code. Library messages are never propagated. */
export function mapError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e;
  if (e instanceof OnvifTimeoutError) return new AdapterError("device_timeout");
  if (e instanceof OnvifMethodNotAllowedError) return new AdapterError("device_protocol_error");
  const msg = e instanceof Error ? e.message : "";
  const code = (e as { code?: string } | null)?.code ?? "";
  if (/not authorized|authentication failed|\b401\b|unauthori[sz]ed/i.test(msg))
    return new AdapterError("device_auth_failed");
  if (/timed? ?out|aborted/i.test(msg) || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return new AdapterError("device_timeout");
  }
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return new AdapterError("device_unreachable");
  }
  return new AdapterError("device_protocol_error");
}

function normalizeBrand(manufacturer: string): string {
  const m = manufacturer.trim().toLowerCase();
  if (m.includes("hik")) return "hikvision";
  if (m.includes("dahua")) return "dahua";
  if (m.includes("axis")) return "axis";
  return m.replace(/[^a-z0-9]+/g, "") || "unknown";
}

function groupChannels(profiles: ProfileLike[]): { channel: ProbedChannel; mainToken: string }[] {
  const bySource = new Map<string, ProfileLike[]>();
  for (const p of profiles) {
    const src = p.videoSourceConfiguration?.sourceToken;
    if (!src || !p.token) continue;
    bySource.set(src, [...(bySource.get(src) ?? []), p]);
  }
  const area = (p: ProfileLike) =>
    (p.videoEncoderConfiguration?.resolution?.width ?? 0) *
    (p.videoEncoderConfiguration?.resolution?.height ?? 0);
  return [...bySource.entries()].map(([source, list], i) => {
    const sorted = [...list].sort((a, b) => area(b) - area(a));
    const main = sorted[0] as ProfileLike;
    const sub = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;
    return {
      mainToken: main.token as string,
      channel: {
        channel: source,
        name: main.videoSourceConfiguration?.name || `Channel ${i + 1}`,
        hasPtz: list.some((p) => p.PTZConfiguration != null),
        mainCodec: main.videoEncoderConfiguration?.encoding ?? null,
        subCodec: sub?.videoEncoderConfiguration?.encoding ?? null,
      },
    };
  });
}

async function connected(conn: DeviceConn): Promise<GuardedOnvif> {
  const client = createOnvifClient({
    host: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    timeoutMs: conn.timeoutMs,
  });
  await client.connect();
  return client;
}

/** Probe brand/model/firmware, channels and capabilities. Only whitelisted read operations are used. */
export async function probe(conn: DeviceConn): Promise<ProbeResult> {
  try {
    const client = await connected(conn);
    const info = await client.getDeviceInformation();
    const raw = client.raw as unknown as {
      profiles?: ProfileLike[];
      uri: Record<string, unknown>;
      media: {
        getStreamUri(a: object): Promise<unknown>;
        getSnapshotUri(a: object): Promise<unknown>;
      };
    };
    const grouped = groupChannels(raw.profiles ?? []);
    const first = grouped[0]?.mainToken;

    const tryOp = async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (e) {
        if (e instanceof OnvifTimeoutError) throw e;
        return false;
      }
    };
    const live = first ? await tryOp(() => raw.media.getStreamUri({ profileToken: first })) : false;
    const snapshot = first ? await tryOp(() => raw.media.getSnapshotUri({ profileToken: first })) : false;
    const hasPtz = grouped.some((g) => g.channel.hasPtz) || raw.uri.PTZ != null || raw.uri.ptz != null;

    // Only claim what was exercised: 'ya' = verified by a call, 'belum-diuji' = advertised but untested.
    const capabilities: CapabilityMap = {
      live: live ? "ya" : "tidak",
      snapshot: snapshot ? "ya" : "tidak",
      ptz: hasPtz ? "ya" : "tidak",
      "ptz.preset": hasPtz ? "belum-diuji" : "tidak",
      "events.motion": raw.uri.events != null ? "belum-diuji" : "tidak",
      "playback.search": raw.uri.search != null ? "belum-diuji" : "tidak",
      "playback.stream": raw.uri.replay != null ? "belum-diuji" : "tidak",
      health: "belum-diuji",
    };
    return {
      brand: normalizeBrand(info.manufacturer),
      manufacturer: info.manufacturer,
      model: info.model,
      firmware: info.firmwareVersion,
      channels: grouped.map((g) => g.channel),
      capabilities,
    };
  } catch (e) {
    throw mapError(e);
  }
}

function sameHost(a: string, b: string): boolean {
  const strip = (h: string) => h.replace(/^\[|\]$/g, "").toLowerCase();
  return strip(a) === strip(b);
}

/** Fetch a JPEG snapshot for a channel. The snapshot URI must point at the device we dialed. */
export async function snapshot(conn: DeviceConn, channel: string): Promise<Buffer> {
  try {
    const client = await connected(conn);
    const raw = client.raw as unknown as {
      profiles?: ProfileLike[];
      media: { getSnapshotUri(a: object): Promise<{ mediaUri?: { uri?: string } }> };
    };
    const target = groupChannels(raw.profiles ?? []).find((g) => g.channel.channel === channel);
    if (!target) throw new AdapterError("snapshot_channel_not_found");
    const res = await raw.media.getSnapshotUri({ profileToken: target.mainToken });
    const uriText = res.mediaUri?.uri;
    if (!uriText) throw new AdapterError("snapshot_failed");
    let uri: URL;
    try {
      uri = new URL(uriText);
    } catch {
      throw new AdapterError("snapshot_failed");
    }
    if (!["http:", "https:"].includes(uri.protocol) || !sameHost(uri.hostname, conn.host)) {
      throw new AdapterError("snapshot_uri_host_mismatch");
    }
    // Same host only, and only the web ports (or the ONVIF port the operator already chose).
    const port = uri.port ? Number(uri.port) : uri.protocol === "https:" ? 443 : 80;
    if (![80, 443, conn.port].includes(port)) throw new AdapterError("snapshot_uri_port_not_allowed");
    return await fetchJpeg(uri, conn);
  } catch (e) {
    throw mapError(e);
  }
}

async function fetchJpeg(uri: URL, conn: DeviceConn): Promise<Buffer> {
  const dispatcher = new Agent({ connect: { timeout: conn.timeoutMs } });
  const doRequest = async (authorization?: string) => {
    const signal = AbortSignal.timeout(conn.timeoutMs);
    return request(uri, {
      method: "GET",
      dispatcher,
      signal,
      headersTimeout: conn.timeoutMs,
      bodyTimeout: conn.timeoutMs,
      headers: authorization ? { authorization } : {},
    });
  };
  try {
    let res = await doRequest();
    if (res.statusCode === 401) {
      const header = res.headers["www-authenticate"];
      await res.body.dump();
      const challenge = parseDigestChallenge(Array.isArray(header) ? (header[0] ?? "") : (header ?? ""));
      res = await doRequest(
        buildDigestAuthorization({
          challenge,
          username: conn.username,
          password: conn.password,
          method: "GET",
          uri: `${uri.pathname}${uri.search}`,
        }),
      );
      if (res.statusCode === 401) {
        await res.body.dump();
        throw new AdapterError("device_auth_failed");
      }
    }
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new AdapterError("snapshot_failed");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += (chunk as Buffer).length;
      if (size > MAX_SNAPSHOT_BYTES) throw new AdapterError("snapshot_invalid_image");
      chunks.push(chunk as Buffer);
    }
    const buf = Buffer.concat(chunks);
    const isJpeg =
      buf.length > 4 &&
      buf[0] === 0xff &&
      buf[1] === 0xd8 &&
      buf[buf.length - 2] === 0xff &&
      buf[buf.length - 1] === 0xd9;
    if (!isJpeg) throw new AdapterError("snapshot_invalid_image");
    return buf;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

export const onvifGenericAdapter = { id: "onvif-generic" as const, probe, snapshot };
