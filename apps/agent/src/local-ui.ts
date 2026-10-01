import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { checkTarget } from "@pantau/adapters";
import { z } from "zod";
import { DeviceError, type DeviceRegistry } from "./devices";
import type { Candidate } from "./discovery";
import { renderPage } from "./local-ui-page";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_SESSIONS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_FAILURES = 5;
const COOKIE = "pantau_local";

export interface LocalUiOptions {
  registry: DeviceRegistry;
  /** Digits only, printed once on the agent console. It is the only way in. */
  pin: string;
  discover: () => Promise<Candidate[]>;
  /** Loopback by default. A LAN address must be named explicitly; wildcard and public addresses are refused. */
  bindHost?: string;
  port?: number;
  /** Required for any non-loopback bind: the PIN and the device password must never cross the LAN in plaintext. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  lockMs?: number;
  /** Called after a device was added or removed, so the cloud inventory can be synced. */
  onChange?: () => void | Promise<void>;
}
export interface LocalUi {
  url: string;
  close(): Promise<void>;
}

const AddBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    host: z.string().trim().min(1).max(64),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(256),
  })
  .strict();
const LoginBody = z.object({ pin: z.string().max(32) }).strict();

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError(415, "unsupported_media_type");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "invalid_request");
  }
}

/** Local setup page of the agent. Cameras are added here so their passwords go from the browser straight to the vault, never to the cloud. */
export async function startLocalUi(o: LocalUiOptions): Promise<LocalUi> {
  const bindHost = o.bindHost ?? "127.0.0.1";
  if (!checkTarget(bindHost, { allowLoopback: true }).allowed)
    throw new Error("bind address must be loopback or a private LAN address");
  const loopbackBind = bindHost === "::1" || bindHost.startsWith("127.");
  if (!loopbackBind && !o.tls)
    throw new Error("bind beyond loopback needs TLS; use a secure tunnel to the loopback address instead");
  const scheme = o.tls ? "https" : "http";
  if (!/^\d{6,12}$/.test(o.pin)) throw new Error("pin must be 6 to 12 digits");
  const lockMs = o.lockMs ?? 60_000;

  const sessions = new Map<string, { csrf: string; exp: number }>();
  let failures = 0;
  let lockedUntil = 0;
  let discovering = false;
  let port = 0;

  const send = (
    res: ServerResponse,
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    res.writeHead(status, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(payload ? { "content-type": "application/json; charset=utf-8" } : {}),
      ...headers,
    });
    res.end(payload);
  };

  const hostOk = (h: string | undefined) => {
    if (!h) return false;
    const ok = new Set([`${bindHost.includes(":") ? `[${bindHost}]` : bindHost}:${port}`]);
    if (bindHost === "127.0.0.1") ok.add(`localhost:${port}`);
    return ok.has(h.toLowerCase());
  };

  const sessionOf = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)pantau_local=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie ?? "")?.[1];
    const s = sid ? sessions.get(sid) : undefined;
    if (!sid || !s) return null;
    if (s.exp < Date.now()) {
      sessions.delete(sid);
      return null;
    }
    return s;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostOk(req.headers.host)) throw new HttpError(421, "misdirected_request");
    const url = new URL(req.url ?? "/", `${scheme}://${req.headers.host}`);
    const method = req.method ?? "GET";
    const isWrite = method !== "GET" && method !== "HEAD";

    if (method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(renderPage(nonce));
      return;
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not_found");

    if (isWrite && req.headers.origin !== `${scheme}://${req.headers.host}`)
      throw new HttpError(403, "origin_not_allowed");

    if (method === "POST" && url.pathname === "/api/login") {
      const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (wait > 0) throw new HttpError(429, "locked", { "retry-after": String(wait) });
      const parsed = LoginBody.safeParse(await readJson(req));
      if (!parsed.success || !sameSecret(parsed.data.pin, o.pin)) {
        if (++failures >= MAX_FAILURES) {
          failures = 0;
          lockedUntil = Date.now() + lockMs;
        }
        throw new HttpError(401, "invalid_pin");
      }
      failures = 0;
      for (const [k, v] of sessions) if (v.exp < Date.now()) sessions.delete(k);
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
      const sid = randomBytes(24).toString("base64url");
      const csrf = randomBytes(24).toString("base64url");
      sessions.set(sid, { csrf, exp: Date.now() + SESSION_TTL_MS });
      send(
        res,
        200,
        { csrf },
        {
          "set-cookie": `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${o.tls ? "; Secure" : ""}`,
        },
      );
      return;
    }

    const session = sessionOf(req);
    if (!session) throw new HttpError(401, "unauthorized");
    if (isWrite && !sameSecret(String(req.headers["x-csrf-token"] ?? ""), session.csrf))
      throw new HttpError(403, "csrf_failed");

    if (method === "GET" && url.pathname === "/api/state") {
      send(res, 200, { devices: o.registry.list() });
      return;
    }
    if (method === "POST" && url.pathname === "/api/discover") {
      await readJson(req);
      if (discovering) throw new HttpError(429, "discovery_running");
      discovering = true;
      try {
        send(res, 200, { candidates: await o.discover() });
      } finally {
        discovering = false;
      }
      return;
    }
    if (method === "POST" && url.pathname === "/api/devices") {
      const body = AddBody.safeParse(await readJson(req));
      // never echo the input: it holds the device password
      if (!body.success) throw new HttpError(400, "invalid_request");
      try {
        const device = await o.registry.add(body.data);
        await o.onChange?.();
        send(res, 201, { device });
      } catch (e) {
        if (e instanceof DeviceError) throw new HttpError(e.code === "device_exists" ? 409 : 422, e.code);
        throw e;
      }
      return;
    }
    const del = /^\/api\/devices\/(dev-[a-z0-9]{4,32})$/.exec(url.pathname);
    if (method === "DELETE" && del) {
      const key = del[1] as string;
      if (!o.registry.list().some((d) => d.deviceKey === key)) throw new HttpError(404, "not_found");
      o.registry.remove(key);
      await o.onChange?.();
      send(res, 204);
      return;
    }
    throw new HttpError(404, "not_found");
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { code: e.code }, e.headers);
      // internal detail stays out of the response: it can hold request data
      send(res, 500, { code: "internal_error" });
    });
  };
  const server: Server = o.tls ? createTlsServer(o.tls, listener) : createServer(listener);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, bindHost, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const shown = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
  return {
    url: `${scheme}://${shown}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
