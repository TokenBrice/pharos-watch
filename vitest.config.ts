import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import path from "path";
import { EXECUTABLE_TEST_PROJECTS, ISOLATED_NODE_TESTS, THREADED_WORKER_TESTS } from "./scripts/lib/critical-ownership.mts";

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

const baseTestExcludes = [
  ...configDefaults.exclude,
  ...worktreeExcludes,
  ".claude/**",
  "agents/**",
  ".next/**",
  "out/**",
  "coverage/**",
  "tests/visual/**",
];

// These node-root suites depend on per-file process isolation (module-level
// registry/env state); they run in the node-isolated project below instead of
// forcing isolation back on for the other ~200 functions/scripts/shared files.
const isolationDependentNodeTests = ISOLATED_NODE_TESTS;

// V8 coverage can leave the full-registry native pipeline fork waiting during
// teardown after its assertions pass. Keep only this CPU-heavy, state-local
// suite on a thread worker; the rest of worker/ retains process isolation.
const threadBackedWorkerTests = THREADED_WORKER_TESTS;

export default defineConfig({
  plugins: [wasmStubPlugin()],
  test: {
    execArgv: nodeExecArgv,
    // Vitest's 5s default is below what several honest suites need on a
    // two-core CI runner: full-registry scoring, workerd rendering, migrated
    // SQLite fixtures and whole-tree AST scans all cost seconds of real work.
    // 20s still fails a genuine hang while removing that false-failure class;
    // individually budgeted tests keep their own larger explicit timeouts.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    exclude: baseTestExcludes,
    // The gitignored stablecoin catalog artifacts are static imports in many
    // suites; a stale local copy fails them with misleading validation errors.
    // The setup regenerates them when cached input/output metadata changes
    // (inherited by every project via extends).
    // Absolute path: vitest resolves relative setup paths against the
    // invocation cwd, which may be worker/.
    globalSetup: [path.resolve(__dirname, "scripts/test/ensure-fresh-stablecoin-artifacts.ts")],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: EXECUTABLE_TEST_PROJECTS.find((project) => project.name === "node")!.include,
          // Project-level exclude replaces the inherited root list, so the
          // base excludes must be spread here explicitly.
          exclude: [...baseTestExcludes, ...isolationDependentNodeTests],
          // These pure-node suites don't need per-file process isolation;
          // reusing workers skips ~200 fork setup/teardown cycles per run.
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: "node-isolated",
          include: isolationDependentNodeTests,
        },
      },
      {
        // Worker suites lean on module-level state (circuit breakers, caches,
        // D1 stubs) and fail without per-file isolation — verified 2026-07-02
        // (263 test failures under isolate:false). Keep default isolation.
        extends: true,
        test: {
          name: "worker",
          include: EXECUTABLE_TEST_PROJECTS.find((project) => project.name === "worker")!.include,
          exclude: [...baseTestExcludes, ...threadBackedWorkerTests],
        },
      },
      {
        extends: true,
        test: {
          name: "worker-threads",
          include: threadBackedWorkerTests,
          pool: "threads",
        },
      },
      {
        extends: true,
        test: {
          name: "src",
          include: EXECUTABLE_TEST_PROJECTS.find((project) => project.name === "src")!.include,
          setupFiles: [path.resolve(__dirname, "src/test/setup.ts")],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        ...configDefaults.exclude,
        ...worktreeExcludes,
        ".claude/**",
        "agents/**",
        ".next/**",
        "out/**",
        "coverage/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@data": path.resolve(__dirname, "data"),
      // Workerd provides this scheme in production; Node-based Vitest needs a
      // runtime-only stand-in without changing the Worker bundle specifier.
      "cloudflare:workers": path.resolve(
        __dirname,
        "worker/src/__mocks__/cloudflare-workers.ts",
      ),
      // Stub WASM-dependent packages for vitest (Node can't handle Worker WASM imports)
      "satori/standalone": path.resolve(__dirname, "worker/src/__mocks__/satori-stub.ts"),
      "satori/yoga.wasm": path.resolve(__dirname, "worker/src/__mocks__/wasm-module-stub.ts"),
      "@cf-wasm/resvg/workerd": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
      "@resvg/resvg-wasm": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
    },
  },
});
