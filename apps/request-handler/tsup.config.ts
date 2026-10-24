/**
 * tsup bundler config: bundles src/index.ts into a single ESM file in dist/,
 * inlining @repo/shared (which ships TypeScript source, not compiled JS).
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  clean: true,
  noExternal: ["@repo/shared"],
});
