import { Onvif } from "onvif";

/**
 * Whitelist of ONVIF operations (PRD section 7): read-only `Get*`/`Find*`, pull-point event
 * handling, and the three PTZ operations. Everything else (Set*, Create*User, SystemReboot,
 * firmware, ...) is refused in code before any bytes leave this process.
 */
const ALLOWED_PATTERNS: readonly RegExp[] = [
  /^Get[A-Za-z0-9]+$/,
  /^Find[A-Za-z0-9]+$/,
  /^CreatePullPointSubscription$/,
  /^PullMessages$/,
  /^Unsubscribe$/,
  /^ContinuousMove$/,
  /^Stop$/,
  /^GotoPreset$/,
];

export class OnvifMethodNotAllowedError extends Error {
  readonly code = "onvif_method_not_allowed";
  constructor(readonly operation: string) {
    super(`ONVIF operation not allowed: ${JSON.stringify(operation.slice(0, 64))}`);
    this.name = "OnvifMethodNotAllowedError";
  }
}
export class OnvifTimeoutError extends Error {
  readonly code = "onvif_timeout";
  constructor() {
    super("ONVIF request timed out");
    this.name = "OnvifTimeoutError";
  }
}
export class OnvifTargetError extends Error {
  readonly code = "onvif_target_not_allowed";
  constructor() {
    super("ONVIF request to a host other than the configured device was refused");
    this.name = "OnvifTargetError";
  }
}

export function isOperationAllowed(operation: string): boolean {
  return ALLOWED_PATTERNS.some((p) => p.test(operation));
}
export function assertOperationAllowed(operation: string): void {
  if (!isOperationAllowed(operation)) throw new OnvifMethodNotAllowedError(operation);
}

/** Local name of the first child of the SOAP Body, or null if it cannot be determined (fail closed). */
export function extractSoapOperation(xml: string): string | null {
  const m = /<(?:[A-Za-z0-9_-]+:)?Body\b[^>]*>\s*<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_]+)/.exec(xml);
  return m?.[1] ?? null;
}

export interface OnvifClientOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
}

interface RawRequestOptions {
  body: string;
  url?: URL;
  [key: string]: unknown;
}
type RawRequest = (options: RawRequestOptions) => Promise<unknown>;

export interface GuardedOnvif {
  /** The underlying client. Its only network egress (`rawRequest`) is guarded, so anything
   *  called on it is subject to the whitelist, host pinning and deadline. */
  raw: Onvif;
  connect(): Promise<void>;
  getDeviceInformation(): Promise<{
    manufacturer: string;
    model: string;
    firmwareVersion: string;
    serialNumber: string;
    hardwareId: string;
  }>;
}

/**
 * Create an ONVIF client whose single HTTP egress point enforces:
 *  1. operation whitelist (unknown/unparsable operation => refused),
 *  2. host pinning (service URLs advertised by the device cannot redirect us elsewhere),
 *  3. a hard per-request deadline.
 */
export function createOnvifClient(opts: OnvifClientOptions): GuardedOnvif {
  const raw = new Onvif({
    hostname: opts.host,
    port: opts.port,
    username: opts.username,
    password: opts.password,
    timeout: opts.timeoutMs,
    preserveAddress: true,
    autoConnect: false,
  });

  const self = raw as unknown as { rawRequest: RawRequest };
  const original = self.rawRequest.bind(raw);
  self.rawRequest = async (options) => {
    const operation = extractSoapOperation(options.body);
    if (operation === null) throw new OnvifMethodNotAllowedError("<unparsable>");
    assertOperationAllowed(operation);
    if (options.url && options.url.hostname !== opts.host) throw new OnvifTargetError();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const work = original({ ...options, signal: controller.signal });
      const deadline = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new OnvifTimeoutError()), { once: true });
      });
      work.catch(() => undefined); // avoid unhandled rejection if the deadline wins
      return await Promise.race([work, deadline]);
    } catch (e) {
      if (controller.signal.aborted && !(e instanceof OnvifTimeoutError)) throw new OnvifTimeoutError();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    raw,
    async connect() {
      await raw.connect();
    },
    async getDeviceInformation() {
      const info = await raw.device.getDeviceInformation();
      return {
        manufacturer: String(info.manufacturer ?? ""),
        model: String(info.model ?? ""),
        firmwareVersion: String(info.firmwareVersion ?? ""),
        serialNumber: String(info.serialNumber ?? ""),
        hardwareId: String(info.hardwareId ?? ""),
      };
    },
  };
}
