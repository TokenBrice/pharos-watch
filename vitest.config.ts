import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import path from "path";

const normalizedRoot = path.resolve(__dirname).replaceAll("\\", "/");
const isWorktreeCheckout = normalizedRoot.includes("/.worktrees/") || normalizedRoot.includes("/worktrees/");
const worktreeExcludes = isWorktreeCheckout ? [] : [".worktrees/**", "worktrees/**"];
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const nodeExecArgv = nodeMajor >= 25 ? ["--no-experimental-webstorage"] : [];

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
    execArgv: nodeExecArgv,
    exclude: [
      ...configDefaults.exclude,
      ...worktreeExcludes,
      ".claude/**",
      ".next/**",
      "out/**",
      "coverage/**",
      "tests/visual/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        ...configDefaults.exclude,
        ...worktreeExcludes,
        ".claude/**",
        ".next/**",
        "out/**",
        "coverage/**",
      ],
      thresholds: {
        lines: 66,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
      // Stub WASM-dependent packages for vitest (Node can't handle Worker WASM imports)
      "satori/standalone": path.resolve(__dirname, "worker/src/__mocks__/satori-stub.ts"),
      "satori/yoga.wasm": path.resolve(__dirname, "worker/src/__mocks__/wasm-module-stub.ts"),
      "@cf-wasm/resvg/workerd": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
      "@resvg/resvg-wasm": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
    },
  },
});
