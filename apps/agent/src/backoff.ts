export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the delay that may be added or removed at random (0.2 = plus or minus 20 percent). */
  jitter?: number;
}

/** Exponential reconnect delay, 1 s up to 60 s (PRD 9.2), spread by jitter so a fleet does not reconnect in step. */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = {},
  rand: () => number = Math.random,
): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 60_000;
  const jitter = opts.jitter ?? 0.2;
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  // 2 ** n overflows to Infinity for huge n; Math.min keeps that at the cap
  const raw = Math.min(max, base * 2 ** n);
  const factor = 1 + (rand() * 2 - 1) * jitter;
  return Math.min(max, Math.max(base, Math.round(raw * factor)));
}
