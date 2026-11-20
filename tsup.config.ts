import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", types: "src/types.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  splitting: false,
  outDir: "dist",
  // Bundled CommonJS dependencies (postcss, …) call require() on Node built-ins;
  // give the ESM bundle a real `require`.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
