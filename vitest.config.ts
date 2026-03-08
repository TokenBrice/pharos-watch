import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import path from "path";

// Stub .wasm imports so vitest doesn't try to load WebAssembly modules
function wasmStubPlugin(): Plugin {
  return {
    name: "wasm-stub",
    load(id) {
      if (id.endsWith(".wasm")) {
        return "export default new ArrayBuffer(0);";
      }
    },
  };
}

export default defineConfig({
  plugins: [wasmStubPlugin()],
  test: {
    exclude: [
      ...configDefaults.exclude,
      ".worktrees/**",
      "worktrees/**",
      ".next/**",
      "out/**",
      "coverage/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        ...configDefaults.exclude,
        ".worktrees/**",
        "worktrees/**",
        ".next/**",
        "out/**",
        "coverage/**",
      ],
      thresholds: {
        lines: 55,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
      // Stub resvg to prevent WASM loading in vitest (Node can't handle Worker WASM imports)
      "@cf-wasm/resvg/workerd": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
      "@resvg/resvg-wasm": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
    },
  },
});
