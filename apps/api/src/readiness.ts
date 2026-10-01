export type ReadinessCheck = () => Promise<void>;

export interface Readiness {
  register(name: string, check: ReadinessCheck): void;
  /** Runs every check under a shared deadline. Failure details are never returned, only the check names. */
  run(): Promise<{ ok: boolean; checks: string[]; failed: string[] }>;
}

/** Checks registered by name. The database is built in; pg-boss registers itself here once the worker exists. */
export function createReadiness(timeoutMs: number): Readiness {
  const checks = new Map<string, ReadinessCheck>();
  return {
    register(name, check) {
      checks.set(name, check);
    },
    async run() {
      const names = [...checks.keys()];
      const outcomes = await Promise.all(
        names.map(async (name) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              (checks.get(name) as ReadinessCheck)(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
              }),
            ]);
            return { name, ok: true };
          } catch {
            return { name, ok: false };
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      const failed = outcomes.filter((o) => !o.ok).map((o) => o.name);
      return { ok: failed.length === 0, checks: names, failed };
    },
  };
}
