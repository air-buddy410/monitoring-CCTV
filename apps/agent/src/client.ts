import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AgentOutbound,
  type InventorySync,
  MAX_FRAME_BYTES,
  parseEnvelope,
  REQUEST_TIMEOUT_MS,
  type StatusReport,
} from "@pantau/contracts";
import { WebSocket } from "ws";
import { backoffDelay } from "./backoff";
import type { Logger } from "./logger";

type CommandType = "ptz.command" | "snapshot.request";
export interface CommandResult {
  ok: boolean;
  code?: string;
}
export type Handlers = Partial<
  Record<CommandType, (payload: Record<string, unknown>) => Promise<CommandResult>>
>;

export interface ClientOptions {
  /** ws:// or wss:// origin of the API. The path /agent is added here. */
  url: string;
  token: string;
  hello: () => { agentVersion: string; go2rtcVersion: string | null; hostname: string };
  inventory: () => InventorySync;
  status: () => Promise<StatusReport>;
  logger: Logger;
  statusIntervalMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  ackTimeoutMs?: number;
  backoff?: (attempt: number) => number;
  handlers?: Handlers;
  requestTimeouts?: Record<"ptz.command" | "snapshot.request" | "recordings.search", number>;
}

export type ClientState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "backoff"
  | "unauthorized"
  | "stopped";

class ProtocolError extends Error {
  constructor(readonly code: string) {
    super(`server refused: ${code}`);
    this.name = "ProtocolError";
  }
}

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The agent's side of PRD 9.2: connect outward with `Authorization: Agent <token>`, say hello, sync the inventory,
 * report status, answer commands within their timeouts, and come back after any drop with exponential backoff.
 * A 401 or a 4401 close means the token was revoked, so the client stops instead of hammering the server.
 */
export class AgentClient extends EventEmitter {
  readonly settings: Required<
    Pick<
      ClientOptions,
      "statusIntervalMs" | "pingIntervalMs" | "pongTimeoutMs" | "ackTimeoutMs" | "requestTimeouts"
    >
  >;
  state: ClientState = "idle";
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly backoff: (attempt: number) => number;

  constructor(private readonly o: ClientOptions) {
    super();
    this.settings = {
      statusIntervalMs: o.statusIntervalMs ?? 30_000,
      pingIntervalMs: o.pingIntervalMs ?? 20_000,
      pongTimeoutMs: o.pongTimeoutMs ?? 10_000,
      ackTimeoutMs: o.ackTimeoutMs ?? 5_000,
      requestTimeouts: o.requestTimeouts ?? { ...REQUEST_TIMEOUT_MS },
    };
    this.backoff = o.backoff ?? ((n) => backoffDelay(n));
  }

  start(): void {
    if (this.state !== "idle" && this.state !== "stopped") return;
    this.attempt = 0;
    this.connect();
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.clearTimers();
    this.failPending(new Error("client stopped"));
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => (ws.terminate(), resolve()), 300);
      ws.once("close", () => (clearTimeout(t), resolve()));
      try {
        ws.close(1000, "agent stopping");
      } catch {
        ws.terminate();
      }
    });
  }

  /** Send the inventory again on the live connection (after a local device change). */
  async syncInventory(): Promise<void> {
    if (this.state !== "ready" || !this.ws) throw new Error("not connected");
    await this.request("inventory.sync", this.o.inventory() as unknown as Record<string, unknown>);
  }

  // ---- connection ----
  private connect(): void {
    if (this.state === "stopped" || this.state === "unauthorized") return;
    this.state = "connecting";
    const ws = new WebSocket(`${this.o.url.replace(/\/+$/, "")}/agent`, {
      headers: { authorization: `Agent ${this.o.token}` },
      handshakeTimeout: 10_000,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.ws = ws;
    let finished = false;
    const finish = (fatal: boolean) => {
      if (finished) return;
      finished = true;
      this.clearTimers();
      this.failPending(new Error("connection closed"));
      if (this.ws === ws) this.ws = null;
      if (this.state === "stopped") return;
      if (fatal) {
        this.state = "unauthorized";
        this.o.logger.error(
          { event: "agent.unauthorized" },
          "the server refused this agent's token; not retrying",
        );
        this.emit("unauthorized");
        return;
      }
      this.schedule();
    };

    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      const fatal = res.statusCode === 401 || res.statusCode === 403;
      this.o.logger.warn({ event: "agent.handshake_refused", status: res.statusCode }, "handshake refused");
      ws.terminate();
      finish(fatal);
    });
    ws.on("open", () => {
      this.state = "handshaking";
      this.startHeartbeat(ws);
      void this.handshake(ws);
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.onFrame(ws, data.toString());
    });
    ws.on("pong", () => {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    });
    ws.on("error", () => undefined);
    ws.on("close", (code) => {
      if (this.state !== "connecting" && this.state !== "stopped") this.emit("disconnected", { code });
      finish(code === 4401);
    });
  }

  private schedule(): void {
    if (this.state === "stopped" || this.state === "unauthorized") return;
    this.state = "backoff";
    const delayMs = this.backoff(this.attempt++);
    this.emit("retry", { attempt: this.attempt, delayMs });
    this.retryTimer = setTimeout(() => this.connect(), delayMs);
  }

  private async handshake(ws: WebSocket): Promise<void> {
    try {
      await this.request("hello", this.o.hello());
      try {
        await this.request("inventory.sync", this.o.inventory() as unknown as Record<string, unknown>);
      } catch (e) {
        // a refused inventory is reported, but status and commands are still worth having
        if (!(e instanceof ProtocolError)) throw e;
      }
      if (this.ws !== ws || this.state === "stopped") return;
      this.state = "ready";
      this.attempt = 0;
      this.emit("ready");
      void this.sendStatus();
      this.statusTimer = setInterval(() => void this.sendStatus(), this.settings.statusIntervalMs);
    } catch (e) {
      if (e instanceof ProtocolError)
        this.o.logger.warn({ event: "agent.hello_refused", code: e.code }, "server refused hello");
      else this.o.logger.warn({ event: "agent.handshake_failed" }, "handshake did not complete");
      ws.terminate();
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      this.pongTimer ??= setTimeout(() => {
        this.o.logger.warn(
          { event: "agent.pong_timeout" },
          "no pong from the server; dropping the connection",
        );
        ws.terminate();
      }, this.settings.pongTimeoutMs);
    }, this.settings.pingIntervalMs);
  }

  private clearTimers(): void {
    clearTimeout(this.retryTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.retryTimer = this.statusTimer = this.pingTimer = this.pongTimer = undefined;
  }

  // ---- frames ----
  private send(type: string, payload: unknown, id: string = randomUUID()): string {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ id, type, ts: new Date().toISOString(), payload }));
    }
    return id;
  }

  private request(type: "hello" | "inventory.sync", payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no ack for ${type}`));
      }, this.settings.ackTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(type, payload, id);
    });
  }

  private failPending(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private async sendStatus(): Promise<void> {
    try {
      this.send("status", await this.o.status());
    } catch {
      this.o.logger.warn({ event: "agent.status_failed" }, "could not build the status report");
    }
  }

  private onFrame(ws: WebSocket, raw: string): void {
    const env = parseEnvelope(raw);
    if (!env.ok)
      return void this.o.logger.warn(
        { event: "agent.bad_frame", reason: env.reason },
        "ignored a malformed frame",
      );
    const msg = AgentOutbound.safeParse(env.value);
    if (!msg.success)
      return void this.o.logger.warn(
        { event: "agent.bad_frame", type: env.value.type },
        "ignored an unknown or invalid frame",
      );
    const m = msg.data;
    switch (m.type) {
      case "ack": {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          p.resolve();
        }
        return;
      }
      case "error": {
        this.emit("protocol-error", { code: m.payload.code, message: m.payload.message, id: m.id });
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          p.reject(new ProtocolError(m.payload.code));
        }
        return;
      }
      default:
        void this.runCommand(ws, m.type, m.id, m.payload as unknown as Record<string, unknown>);
    }
  }

  private async runCommand(
    ws: WebSocket,
    type: CommandType,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const reply = (r: CommandResult) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ id, type: `${type}.result`, ts: new Date().toISOString(), payload: r }));
    };
    const handler = this.o.handlers?.[type];
    if (!handler) return reply({ ok: false, code: "unsupported" });
    let timer: NodeJS.Timeout | undefined;
    try {
      const out = await Promise.race([
        handler(payload),
        new Promise<CommandResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ ok: false, code: "timeout" }),
            this.settings.requestTimeouts[type],
          );
        }),
      ]);
      reply({ ok: out.ok, ...(out.code ? { code: out.code } : {}) });
    } catch {
      // the handler's message may carry device details; only a fixed code goes back
      reply({ ok: false, code: "failed" });
    } finally {
      clearTimeout(timer);
    }
  }
}
