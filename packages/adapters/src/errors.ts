import type { AdapterErrorCode } from "@pantau/contracts";

/** Adapter failures carry a stable code only; messages never include credentials or device output. */
export class AdapterError extends Error {
  constructor(readonly code: AdapterErrorCode) {
    super(code);
    this.name = "AdapterError";
  }
}
