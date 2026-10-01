import { ProblemSchema } from "@pantau/contracts";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSec?: number,
    readonly detail?: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

let redirecting = false;

/** A 401 on an authenticated API call means the session ended: go back to login, remembering where we were. */
function sessionEnded() {
  if (redirecting || typeof window === "undefined") return;
  redirecting = true;
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?expired=1&next=${encodeURIComponent(here)}`);
}

async function toError(res: Response): Promise<ApiError> {
  const retry = Number(res.headers.get("retry-after"));
  const retryAfterSec = Number.isFinite(retry) && retry > 0 ? retry : undefined;
  try {
    const body: unknown = await res.json();
    const problem = ProblemSchema.safeParse(body);
    if (problem.success) return new ApiError(res.status, problem.data.code, retryAfterSec, problem.data.detail);
    // Better Auth answers with { code, message } instead of problem+json.
    const loose = body as { code?: unknown };
    if (typeof loose?.code === "string") return new ApiError(res.status, loose.code, retryAfterSec);
  } catch {
    // non-JSON error body
  }
  return new ApiError(res.status, `http_${res.status}`, retryAfterSec);
}

async function send(path: string, init: RequestInit & { json?: unknown }): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (!res.ok) {
    const err = await toError(res);
    if (err.status === 401 && path.startsWith("/v1/")) sessionEnded();
    throw err;
  }
  return res;
}

export async function getJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await send(path, { method: "GET" });
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new ApiError(res.status, "contract_mismatch");
  return parsed.data;
}

export async function postJson<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.infer<S>> {
  const res = await send(path, { method: "POST", json: body });
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new ApiError(res.status, "contract_mismatch");
  return parsed.data;
}

/** For Better Auth calls whose response body this app does not read. */
export async function postVoid(path: string, body: unknown): Promise<void> {
  await send(path, { method: "POST", json: body ?? {} });
}

export interface Frame {
  url: string;
  bytes: number;
  receivedAt: Date;
}

/** Snapshot: the response must be a JPEG, otherwise it is an error, never a picture. */
export async function postSnapshot(path: string): Promise<Frame> {
  const res = await send(path, { method: "POST" });
  const type = res.headers.get("content-type") ?? "";
  const blob = await res.blob();
  if (!type.startsWith("image/jpeg") || blob.size === 0) throw new ApiError(res.status, "snapshot_not_jpeg");
  return { url: URL.createObjectURL(blob), bytes: blob.size, receivedAt: new Date() };
}
