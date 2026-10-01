import type { WebSocket } from "ws";

export class AgentTimeoutError extends Error {
  constructor(readonly type: string) {
    super(`agent did not answer ${type} in time`);
    this.name = "AgentTimeoutError";
  }
}
export class AgentOfflineError extends Error {
  constructor() {
    super("agent is not connected");
    this.name = "AgentOfflineError";
  }
}

interface Pending {
  type: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
interface Conn {
  socket: WebSocket;
  orgId: string;
  pending: Map<string, Pending>;
}

/** Live agent connections of this process, and request/response over them. */
export class AgentHub {
  private readonly conns = new Map<string, Conn>();

  /** A newer connection replaces the older one; the older socket is closed. */
  add(agentId: string, orgId: string, socket: WebSocket): void {
    const old = this.conns.get(agentId);
    this.conns.set(agentId, { socket, orgId, pending: new Map() });
    if (old) this.drop(old, 4409, "replaced by a newer connection");
  }

  /** Returns true when `socket` was the registered connection (so the caller marks the agent offline). */
  remove(agentId: string, socket: WebSocket): boolean {
    const c = this.conns.get(agentId);
    if (!c || c.socket !== socket) return false;
    this.conns.delete(agentId);
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentOfflineError());
    }
    c.pending.clear();
    return true;
  }

  isOnline(agentId: string): boolean {
    return this.conns.get(agentId)?.socket.readyState === 1;
  }

  count(): number {
    return this.conns.size;
  }

  /** Close an agent's connection (revocation). The close handler marks it offline. */
  disconnect(agentId: string, code = 4401, reason = "revoked"): void {
    const c = this.conns.get(agentId);
    if (c) this.drop(c, code, reason);
  }

  private drop(c: Conn, code: number, reason: string): void {
    try {
      c.socket.close(code, reason);
    } catch {
      c.socket.terminate();
    }
  }

  /** Send an envelope and wait for the agent's answer carrying the same id. Rejects on timeout or disconnect. */
  request(
    agentId: string,
    envelope: { id: string; type: string; ts: string; payload: Record<string, unknown> },
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const c = this.conns.get(agentId);
    if (!c || c.socket.readyState !== 1) return Promise.reject(new AgentOfflineError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(envelope.id);
        reject(new AgentTimeoutError(envelope.type));
      }, timeoutMs);
      c.pending.set(envelope.id, { type: envelope.type, resolve, reject, timer });
      c.socket.send(JSON.stringify(envelope), (err) => {
        if (err) {
          clearTimeout(timer);
          c.pending.delete(envelope.id);
          reject(err);
        }
      });
    });
  }

  /** Called by the connection reader for `*.result` messages. Returns false when nobody was waiting. */
  settle(agentId: string, id: string, payload: Record<string, unknown>): boolean {
    const c = this.conns.get(agentId);
    const p = c?.pending.get(id);
    if (!c || !p) return false;
    c.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(payload);
    return true;
  }

  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const c of this.conns.values()) this.drop(c, code, reason);
  }
}
