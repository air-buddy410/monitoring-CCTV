import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Root-level on purpose: inside a project this flag is ignored, and the integration files share one database.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/**/*.unit.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["{apps,packages}/**/*.int.test.ts"],
          environment: "node",
          globalSetup: ["./apps/api/test/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
