import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkTarget, type DeviceConn } from "@pantau/adapters";
import type { CapabilityMap, InventorySync, ProbeResult } from "@pantau/contracts";
import type { Credentials, FileVault } from "./vault";

export interface LocalCamera {
  channel: string;
  name: string;
  hasPtz: boolean;
  mainCodec: string | null;
  subCodec: string | null;
}
/** Everything the cloud may learn about a device. No credentials, no stream addresses. */
export interface LocalDevice {
  deviceKey: string;
  name: string;
  kind: "nvr" | "ipc";
  brand: string;
  model: string;
  firmware: string;
  adapterId: "onvif-generic";
  host: string;
  port: number;
  capabilities: CapabilityMap;
  cameras: LocalCamera[];
}

export class DeviceError extends Error {
  constructor(readonly code: string) {
    super(`device error: ${code}`);
    this.name = "DeviceError";
  }
}

export interface AddDeviceInput {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RegistryOptions {
  dir: string;
  vault: FileVault;
  probe: (conn: DeviceConn) => Promise<ProbeResult>;
  /** Lab exception for the mock on 127.0.0.1; off in production. */
  allowLoopback: boolean;
  allowCidrs?: readonly string[];
  timeoutMs: number;
}

const FILE = "devices.json";

/** Devices known to this agent: metadata in devices.json, credentials only in the vault. */
export class DeviceRegistry {
  private devices: LocalDevice[];

  constructor(private readonly o: RegistryOptions) {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const path = join(o.dir, FILE);
    this.devices = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LocalDevice[]) : [];
  }

  private save(): void {
    const path = join(this.o.dir, FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  list(): LocalDevice[] {
    return this.devices.map((d) => ({ ...d, cameras: d.cameras.map((c) => ({ ...c })) }));
  }

  credentialsFor(deviceKey: string): Credentials | null {
    return this.o.vault.get(deviceKey);
  }

  async add(input: AddDeviceInput): Promise<LocalDevice> {
    const policy = checkTarget(input.host, {
      allowLoopback: this.o.allowLoopback,
      allowCidrs: this.o.allowCidrs,
    });
    if (!policy.allowed) throw new DeviceError("target_not_allowed");
    if (this.devices.some((d) => d.host === input.host && d.port === input.port))
      throw new DeviceError("device_exists");

    let probed: ProbeResult;
    try {
      probed = await this.o.probe({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        timeoutMs: this.o.timeoutMs,
      });
    } catch (e) {
      // library messages can echo what was sent; only a stable code is passed on
      const code = (e as { code?: unknown } | null)?.code;
      throw new DeviceError(
        typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "device_protocol_error",
      );
    }
    if (probed.channels.length === 0) throw new DeviceError("device_no_channels");

    const deviceKey = `dev-${randomBytes(5).toString("hex")}`;
    const device: LocalDevice = {
      deviceKey,
      name: input.name,
      kind: probed.channels.length > 1 ? "nvr" : "ipc",
      brand: probed.brand,
      model: probed.model,
      firmware: probed.firmware,
      adapterId: "onvif-generic",
      host: input.host,
      port: input.port,
      capabilities: probed.capabilities,
      cameras: probed.channels.map((c) => ({
        channel: c.channel,
        name: c.name,
        hasPtz: c.hasPtz,
        mainCodec: c.mainCodec,
        subCodec: c.subCodec,
      })),
    };
    // vault first: if it fails there is no device row without credentials
    this.o.vault.put(deviceKey, { username: input.username, password: input.password });
    this.devices.push(device);
    this.save();
    return device;
  }

  remove(deviceKey: string): void {
    this.devices = this.devices.filter((d) => d.deviceKey !== deviceKey);
    this.o.vault.delete(deviceKey);
    this.save();
  }

  toInventory(): InventorySync {
    return { devices: this.list() };
  }
}
