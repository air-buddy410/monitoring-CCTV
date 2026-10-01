import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  // workspace packages are TypeScript sources: bundle them; npm dependencies stay external
  noExternal: [/^@pantau\//],
});
