import type { AdapterErrorCode } from "@pantau/contracts";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, `${what}_not_found`, "Not Found");

export function fromAdapterCode(code: AdapterErrorCode): AppError {
  switch (code) {
    case "device_auth_failed":
      return new AppError(422, code, "Device rejected the credentials");
    case "device_timeout":
      return new AppError(504, code, "Device did not respond in time");
    case "device_unreachable":
      return new AppError(502, code, "Device is unreachable");
    case "snapshot_channel_not_found":
      return new AppError(502, code, "Channel no longer exists on the device");
    case "snapshot_uri_host_mismatch":
      return new AppError(502, code, "Device advertised a snapshot address on a different host; refused");
    case "snapshot_invalid_image":
      return new AppError(502, code, "Device did not return a valid JPEG");
    default:
      return new AppError(502, code, "Device returned an unexpected response");
  }
}
