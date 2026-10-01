import { hostname } from "node:os";
import { join } from "node:path";
import { onvifGenericAdapter } from "@pantau/adapters";
import { AgentClient, type ClientOptions } from "./client";
import { DeviceRegistry } from "./devices";
import { EnrollError, enroll, type Identity, loadIdentity } from "./identity";
import { createLogger, type Logger } from "./logger";
import { collectStatus, systemProbes, tcpReachable } from "./status";
import { FileVault } from "./vault";

export const AGENT_VERSION = "0.1.0";

export interface AgentConfig {
  /** HTTP(S) origin of the API, used for enrollment. */
  apiUrl: string;
  /** WebSocket origin when it differs from apiUrl (default: apiUrl with http becoming ws). */
  wsUrl?: string;
  dataDir: string;
  /** Lab exception for a simulator on 127.0.0.1. Never set in production. */
  allowLoopback?: boolean;
  /** Allow http:// and ws:// to a non-loopback host. Lab only; PRD requires wss. */
  allowInsecure?: boolean;
  logger?: Logger;
  /** Timing overrides, for tests. */
  client?: Partial<
    Pick<ClientOptions, "statusIntervalMs" | "pingIntervalMs" | "pongTimeoutMs" | "ackTimeoutMs" | "backoff">
  >;
  probeTimeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertSecure(url: string, allowInsecure: boolean | undefined): void {
  if (allowInsecure) return;
  const u = new URL(url);
  if (u.protocol === "https:" || u.protocol === "wss:") return;
  if (LOOPBACK_HOSTS.has(u.hostname)) return;
  throw new EnrollError("insecure_api_url");
}

const toWs = (url: string) => url.replace(/^http/i, "ws").replace(/\/+$/, "");

/** The on-site agent: identity, local device registry with its credential vault, and the cloud connection. */
export class Agent {
  readonly client: AgentClient;
  readonly registry: DeviceRegistry;
  readonly vault: FileVault;

  private constructor(
    readonly identity: Identity,
    private readonly cfg: AgentConfig,
  ) {
    const logger = cfg.logger ?? createLogger();
    this.vault = FileVault.open(join(cfg.dataDir, "vault"));
    this.registry = new DeviceRegistry({
      dir: cfg.dataDir,
      vault: this.vault,
      probe: (conn) => onvifGenericAdapter.probe(conn),
      allowLoopback: cfg.allowLoopback ?? false,
      timeoutMs: cfg.probeTimeoutMs ?? 5000,
    });
    const probes = systemProbes(cfg.dataDir);
    const reachable = tcpReachable();
    this.client = new AgentClient({
      url: cfg.wsUrl ?? toWs(identity.apiUrl),
      token: identity.agentToken,
      hello: () => ({ agentVersion: AGENT_VERSION, go2rtcVersion: null, hostname: hostname() }),
      inventory: () => this.registry.toInventory(),
      status: () => collectStatus({ devices: this.registry.list(), reachable, ...probes }),
      logger,
      ...cfg.client,
    });
  }

  /** First start: register with the one-time token and keep the long-lived one. */
  static async enroll(cfg: AgentConfig & { enrollToken: string; name: string }): Promise<Agent> {
    assertSecure(cfg.apiUrl, cfg.allowInsecure);
    if (cfg.wsUrl) assertSecure(cfg.wsUrl, cfg.allowInsecure);
    const identity = await enroll({
      apiUrl: cfg.apiUrl,
      enrollToken: cfg.enrollToken,
      name: cfg.name,
      dir: cfg.dataDir,
      hostname: hostname(),
      agentVersion: AGENT_VERSION,
    });
    return new Agent(identity, cfg);
  }

  /** Later starts: the identity is already on disk. */
  static load(cfg: AgentConfig): Agent {
    const identity = loadIdentity(cfg.dataDir);
    if (!identity) throw new EnrollError("not_enrolled");
    assertSecure(identity.apiUrl, cfg.allowInsecure);
    return new Agent(identity, cfg);
  }

  start(): void {
    this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  /** Probe a device on the LAN, keep its credentials in the vault, and tell the cloud its metadata. */
  async addDevice(input: Parameters<DeviceRegistry["add"]>[0]) {
    const device = await this.registry.add(input);
    if (this.client.state === "ready") await this.client.syncInventory().catch(() => undefined);
    return device;
  }
}
