import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import path from "path";
import {
  EXECUTABLE_TEST_PROJECTS,
  ISOLATED_NODE_TESTS,
  THREADED_WORKER_TESTS,
  WORKER_SHARED_TEST_FILES,
} from "./scripts/lib/critical-ownership.mts";
import {
  VITEST_GLOBAL_SETUP_FILES,
  VITEST_PROJECT_SETUP_FILES,
} from "./scripts/lib/vitest-setup-files.mts";

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
];

// These node-root suites depend on per-file process isolation (module-level
// registry/env state); they run in the node-isolated project below instead of
// forcing isolation back on for the other ~200 functions/scripts/shared files.
const isolationDependentNodeTests = ISOLATED_NODE_TESTS;

// V8 coverage can leave the full-registry native pipeline fork waiting during
// teardown after its assertions pass. Keep only this CPU-heavy, state-local
// suite on a thread worker; the rest of worker/ retains process isolation.
const threadBackedWorkerTests = THREADED_WORKER_TESTS;

// Non-isolated worker project: `worker/src/{cron,lib}` files that
// `critical-ownership.mts` classifies as state-safe share one module cache per
// fork; everything else stays in the isolated `worker` project.
const workerSharedTests = WORKER_SHARED_TEST_FILES;

export default defineConfig({
  plugins: [wasmStubPlugin()],
  // Keep large evidence JSON on Vite's JSON-specific SSR path. "auto" with
  // named exports builds per-character JS source maps larger than the catalog.
  json: { stringify: true, namedExports: false },
  test: {
    execArgv: nodeExecArgv,
    // Nightly-tier tag vocabulary (`scripts/lib/nightly-test-tier.mts`). The
    // PR runner passes `--tagsFilter=!nightly`; every other invocation keeps
    // the tagged cases. `strictTags` turns a misspelled tag into a collection
    // error instead of a silent tier change.
    tags: [
      {
        name: "nightly",
        description: "Nightly full-suite tier: excluded from PR test selection.",
      },
    ],
    strictTags: true,
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
    // (inherited by every project via extends). The second entry builds the
    // migrated SQLite template once per run; fixture processes deserialize it
    // or replay migrations when it is unavailable.
    // Absolute path: vitest resolves relative setup paths against the
    // invocation cwd, which may be worker/.
    // The critical coverage runner sets PHAROS_CRITICAL_COVERAGE_FILTER to
    // persist only enrolled sources' V8 results (scripts/lib/critical-coverage-filter.mts).
    globalSetup: [
      ...VITEST_GLOBAL_SETUP_FILES,
      ...(process.env.PHAROS_CRITICAL_COVERAGE_FILTER === "1" ? ["scripts/lib/critical-coverage-filter.mts"] : []),
    ].map((file) => path.resolve(__dirname, file)),
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
        // (263 test failures under isolate:false). Keep default isolation,
        // except for the classified `worker-shared` project below.
        extends: true,
        test: {
          name: "worker",
          include: EXECUTABLE_TEST_PROJECTS.find((project) => project.name === "worker")!.include,
          exclude: [...baseTestExcludes, ...threadBackedWorkerTests, ...workerSharedTests],
        },
      },
      ...(workerSharedTests.length > 0
        ? [{
            extends: true as const,
            test: {
              name: "worker-shared",
              include: workerSharedTests,
              // The eligibility scan above (no vi.mock/hoisted module factories,
              // no unrestored global/env stubs, no env writes, no stateful
              // support module without a reset hook) is what makes this safe;
              // central setup restores mocks and module state after every test.
              // A file that fails shuffled runs moves back to the isolated
              // `worker` project.
              isolate: false,
              pool: "forks" as const,
              setupFiles: VITEST_PROJECT_SETUP_FILES["worker-shared"].map((file) => path.resolve(__dirname, file)),
            },
          }]
        : []),
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
          setupFiles: VITEST_PROJECT_SETUP_FILES.src.map((file) => path.resolve(__dirname, file)),
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Coverage matches absolute paths; ancestor agents/worktrees directories are not repo scratch.
      exclude: baseTestExcludes.map((pattern) => pattern.startsWith("**/") ? pattern : `${normalizedRoot}/${pattern}`),
    },
  },
  resolve: {
    alias: {
      // Match Wrangler's Text module without a runtime-specific loader branch.
      "@shared/data/stablecoins/coins.worker-full.generated.json":
        `${path.resolve(__dirname, "shared/data/stablecoins/coins.worker-full.generated.json")}?raw`,
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@data": path.resolve(__dirname, "data"),
      // Stub WASM-dependent packages for vitest (Node can't handle Worker WASM imports)
      "satori/standalone": path.resolve(__dirname, "worker/src/__mocks__/satori-stub.ts"),
      "satori/yoga.wasm": path.resolve(__dirname, "worker/src/__mocks__/wasm-module-stub.ts"),
      "@cf-wasm/resvg/workerd": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
      "@resvg/resvg-wasm": path.resolve(__dirname, "worker/src/__mocks__/resvg-stub.ts"),
    },
  },
});
