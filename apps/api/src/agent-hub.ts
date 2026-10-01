import { randomUUID } from "node:crypto";
import { AGENT_TIMEOUTS_MS, AgentEnvelope, type AgentRequestKind } from "@pantau/contracts";

/** Exponential backoff with jitter: 1 s doubling to a 60 s ceiling (PRD section 9.2). */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt), 60_000);
  // full jitter over the lower half keeps a fleet from reconnecting in lockstep while still backing off
  return Math.max(1, Math.round(base / 2 + (base / 2) * random()));
}

export interface AgentConnection {
  agentId: string;
  orgId: string;
  siteId: string;
  /** Returns false when the socket is already gone, so callers can fail fast. */
  send(frame: string): boolean;
  close(code: number, reason?: string): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentNotConnectedError extends Error {
  constructor(readonly agentId: string) {
    super(`agent ${agentId} is not connected`);
    this.name = "AgentNotConnectedError";
  }
}

/**
 * In-process registry of live agent sockets, plus the request/response correlation that PRD section 9.2
 * requires (every request has a deadline; a missing reply must not hang a request handler).
 */
export class AgentHub {
  private readonly byAgent = new Map<string, AgentConnection>();
  private readonly pending = new Map<string, Pending>();

  /**
   * Register a connection, evicting any previous socket for the same agent: an agent that reconnects
   * after a network drop must not leave a zombie that still counts as online.
   */
  attach(conn: AgentConnection): void {
    const previous = this.byAgent.get(conn.agentId);
    if (previous && previous !== conn) previous.close(1000, "replaced by a newer connection");
    this.byAgent.set(conn.agentId, conn);
  }

  detach(conn: AgentConnection): void {
    // only remove it if it is still the current connection, so a slow detach cannot evict its successor
    if (this.byAgent.get(conn.agentId) === conn) this.byAgent.delete(conn.agentId);
  }

  get(agentId: string): AgentConnection | undefined {
    return this.byAgent.get(agentId);
  }

  isConnected(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  size(): number {
    return this.byAgent.size;
  }

  /** Resolve a `*.result` frame that answers a request sent by `request()`. Returns true if it matched. */
  settle(envelope: { id: string; type: string }): boolean {
    const waiter = this.pending.get(envelope.id);
    if (!waiter) return false;
    this.pending.delete(envelope.id);
    clearTimeout(waiter.timer);
    waiter.resolve(envelope);
    return true;
  }

  /**
   * Send one request and wait for the agent's reply with the same envelope id, up to the deadline for
   * that request kind. Rejects rather than hanging when the agent is absent, gone, or silent.
   */
  request(
    agentId: string,
    kind: AgentRequestKind,
    payload: unknown,
    timeoutMs: number = AGENT_TIMEOUTS_MS[kind],
  ): Promise<unknown> {
    const conn = this.byAgent.get(agentId);
    if (!conn) return Promise.reject(new AgentNotConnectedError(agentId));
    const id = `req_${randomUUID().replaceAll("-", "")}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agent request ${kind} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const frame = JSON.stringify({
        id,
        type: kind === "ptz" ? "ptz.command" : kind === "snapshot" ? "snapshot.request" : "recordings.search",
        ts: new Date().toISOString(),
        payload,
      });
      if (!conn.send(frame)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentNotConnectedError(agentId));
      }
    });
  }

  /** Close every socket (shutdown) and reject outstanding requests so callers do not wait for a dead hub. */
  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const conn of this.byAgent.values()) conn.close(code, reason);
    this.byAgent.clear();
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("agent hub is shutting down"));
    }
    this.pending.clear();
  }
}

/** Validate one inbound envelope; returns null for anything that is not a well-formed message. */
export function parseEnvelope(raw: string): AgentEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = AgentEnvelope.safeParse(json);
  return r.success ? r.data : null;
}
