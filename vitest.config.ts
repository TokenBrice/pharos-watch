import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ".worktrees/**",
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
    },
  },
});
