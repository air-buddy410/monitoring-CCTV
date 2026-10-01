import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
