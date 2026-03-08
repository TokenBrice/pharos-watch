import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
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
      // Stub resvg-wasm to prevent WASM loading in vitest (Node can't resolve wbg imports)
      "@resvg/resvg-wasm/index_bg.wasm": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
      "@resvg/resvg-wasm": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
    },
  },
});
