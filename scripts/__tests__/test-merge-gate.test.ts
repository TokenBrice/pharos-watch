import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureProcessExit,
  commandTexts,
  executionBatchCommandTexts,
  executionUnitCommandTexts,
  mockCommandRunner,
  mockExecFileSync,
  testEnv,
  type TestEnv,
} from "../test-utils/ci-script-test-helpers";
import {
  buildExecutionBatches,
  buildCommandPlan,
  buildFullCommandPlan,
  fetchBaseRef,
  getChangedFiles,
  getProductionPagesPublicEnv,
  getValidatePrebuildSkipCommands,
  getValidatePrebuildSurface,
  printMergeGateTimingSummary,
  runExecutionBatches,
  runMergeGate,
} from "../maintenance/test-merge-gate.mjs";
import { getCommandEnv } from "../maintenance/test-merge-gate.mjs";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import {
  buildCiValidateCommands,
  buildCiValidateStepPlan,
  buildNoncriticalTestShardCommands,
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  resolveValidatePrebuildTier,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
  VALIDATE_PREBUILD_TIER_ENV,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";
import {
  buildDiscoveryExecutionGroups,
  getDiscoveryCommandEnv,
  resolveDiscoveryMaxParallel,
  runMergeGateDiscovery,
} from "../maintenance/run-merge-gate-discovery.mjs";

const TELEGRAM_LOAD_ADVISORY_COMMAND = "npx tsx scripts/ci/check-telegram-load.ts";
const GATE_BUILD_GENERATED_ARTIFACTS_SKIP = GENERATED_ARTIFACT_REGISTRY.map((artifact) => artifact.id).join(",");

describe("buildCommandPlan", () => {
  it("skips the merge gate when no deploy surfaces changed", () => {
    expect(buildCommandPlan(["docs/testing.md", "docs/process/notes.md"])).toEqual([]);
  });

  it("runs the Pages path without worker typecheck for frontend export changes", () => {
    expect(commandTexts(buildCommandPlan(["src/app/page.tsx"]))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ]);
  });

  it("runs the worker path without build or SEO for worker-only changes", () => {
    expect(
      commandTexts(buildCommandPlan(["worker/src/api/status.ts", "worker/src/cron/sync-yield-data.ts"])),
    ).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("adds the Telegram advisory load guard for Telegram dispatch changes", () => {
    expect(commandTexts(buildCommandPlan(["worker/src/cron/dispatch-telegram-alerts.ts"]))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
    ]);
  });

  it("runs the full path for shared runtime changes", () => {
    expect(commandTexts(buildCommandPlan(["shared/lib/classification.ts"]))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("runs the Pages path only for known Pages-only shared helpers", () => {
    expect(commandTexts(buildCommandPlan(["shared/lib/public-docs.ts"]))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ]);
  });

  it("can force the full deploy validate path when the push base is unavailable", () => {
    expect(commandTexts(buildFullCommandPlan())).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
    ]);
  });

  it("runs all targeted prebuild checks when their files changed", () => {
    const allSkippableFiles = [
      "worker/migrations/0001_init.sql",
      "worker/wrangler.toml",
      "docs/architecture.md",
      "shared/lib/redemption-backstop-configs/usdt.ts",
    ];

    expect(commandTexts(buildCommandPlan(allSkippableFiles))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
    ]);
  });

  it("provides the changed-file set to the local critical coverage command", () => {
    expect(getCommandEnv("npm run coverage:critical", ["worker/src/api/status.ts", "docs/testing.md"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts,docs/testing.md",
      CRITICAL_COVERAGE_RATCHET_ALL: "1",
    });

    expect(
      getCommandEnv("npm run coverage:critical", ["worker/src/api/status.ts"], testEnv({
        CRITICAL_COVERAGE_RATCHET_ALL: "0",
      })),
    ).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts",
    });

    expect(getCommandEnv("npm run test:noncritical", ["worker/src/api/status.ts"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
    });
  });

  it("passes a focused validate:prebuild surface hint for deploy-impacting diffs", () => {
    expect(getValidatePrebuildSurface(["src/app/page.tsx"])).toBe("pages");
    expect(getValidatePrebuildSurface(["worker/src/api/status.ts"])).toBe("worker");
    expect(getValidatePrebuildSurface(["shared/lib/classification.ts"])).toBe("full");
    expect(getValidatePrebuildSurface([])).toBe("full");

    expect(getCommandEnv("npm run validate:prebuild", ["src/app/page.tsx"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
      [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: "npm run audit:deps,npm run audit:pricing-providers",
    });
    expect(getCommandEnv("npm run validate:prebuild", ["worker/src/api/status.ts"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "worker",
      [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: "npm run audit:deps,npm run audit:pricing-providers",
    });
  });

  it("path-gates network-backed prebuild audits in the local merge gate", () => {
    expect(getValidatePrebuildSkipCommands(["src/app/page.tsx"], testEnv())).toEqual([
      "npm run audit:deps",
      "npm run audit:pricing-providers",
    ]);
    expect(getValidatePrebuildSkipCommands(["package-lock.json"], testEnv())).toEqual([
      "npm run audit:pricing-providers",
    ]);
    expect(getValidatePrebuildSkipCommands(["shared/lib/pricing-provider-config.ts"], testEnv())).toEqual([
      "npm run audit:deps",
    ]);
    expect(getValidatePrebuildSkipCommands(["package-lock.json", "shared/lib/pricing-provider-config.ts"], testEnv())).toEqual([]);
    expect(getValidatePrebuildSkipCommands([], testEnv({ MERGE_GATE_FULL_DEPLOY: "1" }))).toEqual([]);
  });

  it("keeps inherited non-full validate:prebuild tiers from weakening the merge gate", () => {
    const commandEnv = getCommandEnv("npm run validate:prebuild", ["src/app/page.tsx"], testEnv({
      [VALIDATE_PREBUILD_TIER_ENV]: "blocking",
    }));

    expect(commandEnv).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
      [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: "npm run audit:deps,npm run audit:pricing-providers",
    });
    expect(resolveValidatePrebuildTier("blocking", { ci: commandEnv.CI }).effectiveTier).toBe("full");
  });

  it("applies the production Pages build env for local static export validation", () => {
    expect(getCommandEnv("npm run build", ["src/app/page.tsx"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      GENERATED_ARTIFACTS_SKIP: GATE_BUILD_GENERATED_ARTIFACTS_SKIP,
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_API_KEY: "",
      PUBLIC_DATASETS_REQUIRE_API: "",
      SMOKE_API_BASE: "",
      API_BASE_URL: "",
    });
  });

  it("keeps Pages public env offline by default for local Pages validation", () => {
    const env = testEnv({
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_UNRELATED: "keep-out",
    });

    expect(getCommandEnv("npm run build", ["src/app/page.tsx"], env)).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      NEXT_PUBLIC_GA_ID: undefined,
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: undefined,
      GENERATED_ARTIFACTS_SKIP: GATE_BUILD_GENERATED_ARTIFACTS_SKIP,
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_API_KEY: "",
      PUBLIC_DATASETS_REQUIRE_API: "",
      SMOKE_API_BASE: "",
      API_BASE_URL: "",
    });
    expect(getCommandEnv("npm run check:feature-flag-inlining", ["src/app/page.tsx"], env)).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      NEXT_PUBLIC_GA_ID: undefined,
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: undefined,
    });
  });

  it("mirrors production Pages public env when the local rehearsal mode is enabled", () => {
    const env = testEnv({
      MERGE_GATE_PRODUCTION_ENV: "1",
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_PHAROS_HERO_VERDICT: "false",
      NEXT_PUBLIC_UNRELATED: "keep-out",
    });

    expect(getProductionPagesPublicEnv(env)).toEqual({
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_PHAROS_HERO_VERDICT: "false",
    });
    expect(getCommandEnv("npm run build", ["src/app/page.tsx"], env)).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_PHAROS_HERO_VERDICT: "false",
      GENERATED_ARTIFACTS_SKIP: GATE_BUILD_GENERATED_ARTIFACTS_SKIP,
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_API_KEY: "",
      PUBLIC_DATASETS_REQUIRE_API: "",
      SMOKE_API_BASE: "",
      API_BASE_URL: "",
    });
    expect(getCommandEnv("npm run check:feature-flag-inlining", ["src/app/page.tsx"], env)).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_PHAROS_HERO_VERDICT: "false",
    });
  });

  it("prints a slowest-first timing summary and warns past the runtime budget", () => {
    const logged: string[] = [];
    const warned: string[] = [];
    const io = { log: (line: string) => logged.push(line), warn: (line: string) => warned.push(line) };

    printMergeGateTimingSummary(
      [
        { cmd: "npm run validate:prebuild", ms: 40_000 },
        { cmd: "npm run build", ms: 193_000 },
      ],
      540_000,
      testEnv(),
      io,
    );

    expect(logged[0]).toBe("[merge-gate] Timing summary (wall-clock 9.0 min):");
    expect(logged[1]).toContain("193.0s");
    expect(logged[1]).toContain("npm run build");
    expect(logged[2]).toContain("npm run validate:prebuild");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("exceeded the 8 min budget");

    warned.length = 0;
    printMergeGateTimingSummary([{ cmd: "npm run build", ms: 540_000 }], 540_000, testEnv({ MERGE_GATE_BUDGET_MINUTES: "0" }), io);
    expect(warned).toHaveLength(0);

    logged.length = 0;
    printMergeGateTimingSummary([], 540_000, testEnv(), io);
    expect(logged).toHaveLength(0);
  });

  it("skips base env injection when MERGE_GATE_NATIVE_ENV=1 is set", () => {
    expect(
      getCommandEnv("npm run coverage:critical", ["worker/src/api/status.ts"], testEnv({ MERGE_GATE_NATIVE_ENV: "1" })),
    ).toEqual({
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts",
      CRITICAL_COVERAGE_RATCHET_ALL: "1",
    });

    expect(
      getCommandEnv("npm run test:noncritical", ["worker/src/api/status.ts"], testEnv({ MERGE_GATE_NATIVE_ENV: "1" })),
    ).toEqual({});
  });

  it("skips local mobile smoke when pages smoke runs for non-UI diffs", () => {
    expect(getCommandEnv("npm run validate:pages-smoke", [".github/workflows/pages-release.yml"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      SMOKE_UI_OVERFLOW_ROUTES:
        "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/,/depeg/",
      SMOKE_UI_OVERFLOW_WORKERS: "6",
      PAGES_SMOKE_INCLUDE_MOBILE: "0",
    });
  });

  it("applies the local mobile canary profile for UI-impacting pages smoke", () => {
    expect(getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      SMOKE_UI_OVERFLOW_ROUTES:
        "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/,/depeg/",
      SMOKE_UI_OVERFLOW_WORKERS: "6",
      PAGES_SMOKE_INCLUDE_MOBILE: "1",
      SMOKE_MOBILE_UI_ROUTES:
        "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/,/depeg/",
      SMOKE_MOBILE_UI_VIEWPORTS: "360x740,390x844",
      SMOKE_MOBILE_UI_SKIP_DESKTOP: "1",
      SMOKE_MOBILE_UI_WORKERS: "3",
      SMOKE_MOBILE_UI_WAIT_MS: "5000",
    });
  });

  it("expects GA during production Pages smoke rehearsal when the production GA id is provided", () => {
    expect(
      getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], testEnv({
        MERGE_GATE_PRODUCTION_ENV: "1",
        NEXT_PUBLIC_GA_ID: "G-PROD",
      })),
    ).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      SMOKE_UI_EXPECT_GA_ID: "G-PROD",
      SMOKE_UI_OVERFLOW_ROUTES:
        "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/,/depeg/",
      SMOKE_UI_OVERFLOW_WORKERS: "6",
      PAGES_SMOKE_INCLUDE_MOBILE: "1",
      SMOKE_MOBILE_UI_ROUTES:
        "/,/stablecoins/,/screener/,/stablecoin/usdt-tether/,/timeline/,/flows/,/liquidity/,/yield/,/depeg/",
      SMOKE_MOBILE_UI_VIEWPORTS: "360x740,390x844",
      SMOKE_MOBILE_UI_SKIP_DESKTOP: "1",
      SMOKE_MOBILE_UI_WORKERS: "3",
      SMOKE_MOBILE_UI_WAIT_MS: "5000",
    });
  });

  it("does not override an explicit GA expectation during Pages smoke", () => {
    expect(
      getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], testEnv({
        MERGE_GATE_PRODUCTION_ENV: "1",
        NEXT_PUBLIC_GA_ID: "G-PROD",
        SMOKE_UI_EXPECT_GA_ID: "G-CUSTOM",
      })),
    ).not.toHaveProperty("SMOKE_UI_EXPECT_GA_ID");
  });

  it("does not override explicit local mobile smoke env overrides", () => {
    expect(
      getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], testEnv({
        SMOKE_UI_OVERFLOW_ROUTES: "/desktop/",
        SMOKE_UI_OVERFLOW_WORKERS: "2",
        SMOKE_MOBILE_UI_ROUTES: "/custom/",
        SMOKE_MOBILE_UI_VIEWPORTS: "412x915",
        SMOKE_MOBILE_UI_SKIP_DESKTOP: "0",
        SMOKE_MOBILE_UI_WORKERS: "5",
        SMOKE_MOBILE_UI_WAIT_MS: "2100",
      })),
    ).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      PAGES_SMOKE_INCLUDE_MOBILE: "1",
    });
  });

  it("defaults local worker smoke to canary API scope", () => {
    expect(getCommandEnv("npm run validate:worker-smoke", ["worker/src/api/status.ts"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      SMOKE_API_SCOPE: "canary",
    });
  });

  it("preserves explicit local worker smoke API scope overrides", () => {
    expect(
      getCommandEnv("npm run validate:worker-smoke", ["worker/src/api/status.ts"], testEnv({ SMOKE_API_SCOPE: "full" })),
    ).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
    });
  });

  it("groups independent post-validate checks for parallel local execution", () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"]);
    expect(
      executionBatchCommandTexts(buildExecutionBatches(plan)),
    ).toEqual([
      [["npm run validate:prebuild"]],
      [
        [
          "npm run build",
          "npm run test:a11y",
          "npm run check:feature-flag-inlining",
          "npm run seo:check",
          "npm run check:phishing-signatures",
          "npm run check:classifier-sensitive-copy",
          "npm run check:build-size",
          "npm run check:build-attribution",
        ],
        ["npm run test:noncritical -- --shard=1/2"],
        ["npm run test:noncritical -- --shard=2/2"],
        ["npm run coverage:critical"],
        ["npm run typecheck:worker"],
        ["npm run validate:worker-scheduled-smoke"],
      ],
    ]);
  });

  it("routes plan items outside the known command groups into the parallel post-validate batch", () => {
    const plan = [
      ...buildCommandPlan(["shared/lib/classification.ts"]),
      { cmd: "npm run check:future-guardrail", reasons: ["test"] },
    ];
    const batches = executionBatchCommandTexts(buildExecutionBatches(plan));

    expect(batches).toHaveLength(2);
    expect(batches[1]).toContainEqual(["npm run check:future-guardrail"]);
  });

  it("aborts sibling parallel groups after the first post-validate failure", async () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"]);
    const calls: string[] = [];
    const aborted: string[] = [];
    let exitStatus: number | undefined;

    await runExecutionBatches(
      plan,
      ["shared/lib/classification.ts"],
      testEnv({ MERGE_GATE_PARALLEL: "1" }),
      {
        exit: captureProcessExit((status) => {
          exitStatus = status;
        }),
        runCommandImpl: mockCommandRunner((cmd, _extraEnv = {}, { signal } = {}) => {
          calls.push(cmd);

          if (cmd === "npm run validate:prebuild") {
            return Promise.resolve({ status: 0, aborted: false });
          }

          if (cmd === "npm run build") {
            return Promise.resolve({ status: 1, aborted: false });
          }

          return new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              aborted.push(cmd);
              resolve({ status: 130, aborted: true });
            });
          });
        }),
      },
    );

    expect(exitStatus).toBe(1);
    expect(calls).toContain("npm run validate:prebuild");
    expect(calls).toContain("npm run build");
    expect(calls).not.toContain("npm run seo:check");
    expect(aborted).toEqual([
      "npm run test:noncritical -- --shard=1/2",
      "npm run test:noncritical -- --shard=2/2",
      "npm run coverage:critical",
      "npm run typecheck:worker",
      "npm run validate:worker-scheduled-smoke",
    ]);
  });

  it("groups merge-gate discovery lanes without enabling smoke by default", () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"], { pagesSmoke: true, workerSmoke: true });
    const groups = buildDiscoveryExecutionGroups(plan);

    expect(executionUnitCommandTexts(groups.prebuildUnits)).toEqual([
      ["npm run validate:prebuild"],
    ]);
    expect(executionUnitCommandTexts(groups.postValidateUnits)).toEqual([
      [
        "npm run build",
        "npm run test:a11y",
        "npm run check:feature-flag-inlining",
        "npm run seo:check",
        "npm run check:phishing-signatures",
        "npm run check:classifier-sensitive-copy",
        "npm run check:build-size",
        "npm run check:build-attribution",
      ],
      ["npm run test:noncritical -- --shard=1/2"],
      ["npm run test:noncritical -- --shard=2/2"],
      ["npm run coverage:critical"],
      ["npm run typecheck:worker"],
      ["npm run validate:worker-scheduled-smoke"],
    ]);
    expect(groups.smokeUnits).toEqual([]);
  });

  it("keeps smoke in a separate discovery phase when explicitly included", () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"], { pagesSmoke: true, workerSmoke: true });
    const groups = buildDiscoveryExecutionGroups(plan, { includeSmoke: true });

    expect(executionUnitCommandTexts(groups.postValidateUnits)).not.toContainEqual([
      "npm run validate:pages-smoke",
    ]);
    expect(executionUnitCommandTexts(groups.smokeUnits)).toEqual([
      ["npm run validate:pages-smoke"],
      ["npm run validate:worker-smoke"],
    ]);
  });

  it("forces validate:prebuild discovery to continue on errors", () => {
    expect(getDiscoveryCommandEnv({ cmd: "npm run validate:prebuild" }, ["src/app/page.tsx"], testEnv())).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
      [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: "npm run audit:deps,npm run audit:pricing-providers",
      VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
    });
    expect(getDiscoveryCommandEnv({ cmd: "npm run build" }, ["src/app/page.tsx"], testEnv())).toEqual(
      getCommandEnv("npm run build", ["src/app/page.tsx"], testEnv()),
    );
  });

  it("bounds discovery parallelism with an explicit override", () => {
    expect(resolveDiscoveryMaxParallel(testEnv(), 16)).toBe(6);
    expect(resolveDiscoveryMaxParallel(testEnv(), 4)).toBe(2);
    expect(resolveDiscoveryMaxParallel(testEnv({ MERGE_GATE_DISCOVERY_MAX_PARALLEL: "3" }), 16)).toBe(3);
  });

  it("passes changed-file env only to coverage during execution", async () => {
    const envByCommand = new Map<string, TestEnv>();

    await runExecutionBatches(
      [
        { cmd: "npm run test:noncritical", reasons: ["test"] },
        { cmd: "npm run coverage:critical", reasons: ["test"] },
      ],
      ["src/app/page.tsx", "worker/src/api/status.ts"],
      testEnv({ MERGE_GATE_SERIAL: "1", MERGE_GATE_NATIVE_ENV: "1" }),
      {
        exit: captureProcessExit(() => {
          throw new Error("unexpected exit");
        }),
        runCommandImpl: mockCommandRunner((cmd, extraEnv = {}) => {
          envByCommand.set(cmd, extraEnv);
          return 0;
        }),
      },
    );

    expect(envByCommand.get("npm run test:noncritical")).toEqual({});
    expect(envByCommand.get("npm run coverage:critical")).toEqual({
      CRITICAL_COVERAGE_CHANGED_FILES: "src/app/page.tsx,worker/src/api/status.ts",
      CRITICAL_COVERAGE_RATCHET_ALL: "1",
    });
  });

  it("passes production rehearsal env through build and feature-flag check execution", async () => {
    const envByCommand = new Map<string, Record<string, string | undefined>>();

    await runExecutionBatches(
      [
        { cmd: "npm run build", reasons: ["test"] },
        { cmd: "npm run check:feature-flag-inlining", reasons: ["test"] },
      ],
      ["src/app/page.tsx"],
      testEnv({
        MERGE_GATE_PRODUCTION_ENV: "1",
        NEXT_PUBLIC_GA_ID: "G-PROD",
        NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      }),
      {
        exit: captureProcessExit(() => {
          throw new Error("unexpected exit");
        }),
        runCommandImpl: mockCommandRunner((cmd, extraEnv = {}) => {
          envByCommand.set(cmd, extraEnv);
          return 0;
        }),
      },
    );

    expect(envByCommand.get("npm run build")).toMatchObject({
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
    });
    expect(envByCommand.get("npm run check:feature-flag-inlining")).toMatchObject({
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
    });
  });
});


describe("getChangedFiles", () => {
  it("passes the base and head refs to git diff as a single range argument", () => {
    const calls: unknown[] = [];
    const execFile = mockExecFileSync((cmd, args) => {
      calls.push([cmd, args]);
      return "worker/src/api/status.ts\n";
    });

    expect(
      getChangedFiles({
        baseRef: "origin/main; touch /tmp/should-not-run",
        execFile,
        headRef: "HEAD && echo injected",
      }),
    ).toEqual(["worker/src/api/status.ts"]);
    expect(calls).toEqual([
      ["git", ["diff", "--name-only", "origin/main; touch /tmp/should-not-run...HEAD && echo injected"]],
    ]);
  });

  it("uses argument arrays for staged diffs", () => {
    const calls: unknown[] = [];
    const execFile = mockExecFileSync((cmd, args) => {
      calls.push([cmd, args]);
      return "src/app/page.tsx\n";
    });

    expect(getChangedFiles({ stagedMode: true, execFile })).toEqual(["src/app/page.tsx"]);
    expect(calls).toEqual([["git", ["diff", "--name-only", "--cached"]]]);
  });

  it("rejects empty push bases unless the full deploy gate is requested by the caller", () => {
    expect(() => getChangedFiles({ baseRef: "0000000000000000000000000000000000000000" } as never)).toThrow(
      "MERGE_GATE_FULL_DEPLOY=1",
    );
  });
});

describe("pre-push hook", () => {
  it("passes exact main push refs into the local merge gate and defaults Pages smoke on", () => {
    const hook = readFileSync(resolve(process.cwd(), ".githooks/pre-push"), "utf8");

    expect(hook).toContain('pages_smoke_flag="${MERGE_GATE_PAGES_SMOKE:-1}"');
    expect(hook).toContain('remote_ref" != "refs/heads/main"');
    expect(hook).toContain(
      'MERGE_GATE_PAGES_SMOKE="$pages_smoke_flag" MERGE_GATE_BASE_REF="$remote_sha" MERGE_GATE_HEAD_REF="$local_sha"',
    );
    expect(hook).toContain(
      'MERGE_GATE_PAGES_SMOKE="$pages_smoke_flag" MERGE_GATE_FULL_DEPLOY=1 MERGE_GATE_HEAD_REF="$local_sha"',
    );
    expect(hook).toContain('MERGE_GATE_PAGES_SMOKE="$pages_smoke_flag" npm run test:merge-gate');
  });
});

describe("validate workflow command model", () => {
  it("builds the expected full validate command sequence", () => {
    expect(buildCiValidateCommands()).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...buildNoncriticalTestShardCommands(),
      "npm run coverage:critical",
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("marks Pages and worker steps as conditional", () => {
    expect(buildCiValidateStepPlan()).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS.map((cmd) => ({ cmd, condition: null })),
      ...PAGES_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: "pages_changed && run_pages_build_and_seo" })),
      ...buildNoncriticalTestShardCommands().map((cmd) => ({ cmd, condition: null })),
      { cmd: "npm run coverage:critical", condition: null },
      ...WORKER_VALIDATE_COMMANDS.map((cmd) => ({ cmd, condition: "worker_changed" })),
    ]);
  });
});

describe("opt-in smoke wiring", () => {
  it("appends Pages smoke after Pages build when MERGE_GATE_PAGES_SMOKE is requested", () => {
    expect(commandTexts(buildCommandPlan(["src/app/page.tsx"], { pagesSmoke: true }))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...PAGES_SMOKE_VALIDATE_COMMANDS,
    ]);
  });

  it("does not append Pages smoke for worker-only changes", () => {
    expect(commandTexts(buildCommandPlan(["worker/src/api/status.ts"], { pagesSmoke: true }))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("appends worker smoke after worker typechecks when MERGE_GATE_WORKER_SMOKE is requested", () => {
    expect(commandTexts(buildCommandPlan(["worker/src/api/status.ts"], { workerSmoke: true }))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      ...WORKER_SMOKE_VALIDATE_COMMANDS,
    ]);
  });

  it("appends both smokes in buildFullCommandPlan when requested", () => {
    expect(commandTexts(buildFullCommandPlan("forced", { pagesSmoke: true, workerSmoke: true }))).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
      ...PAGES_SMOKE_VALIDATE_COMMANDS,
      ...WORKER_SMOKE_VALIDATE_COMMANDS,
    ]);
  });

  it("sequences smoke commands in a third batch after the parallel post-validate batch", () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"], { pagesSmoke: true, workerSmoke: true });
    expect(
      executionBatchCommandTexts(buildExecutionBatches(plan)),
    ).toEqual([
      [["npm run validate:prebuild"]],
      [
        [
          "npm run build",
          "npm run test:a11y",
          "npm run check:feature-flag-inlining",
          "npm run seo:check",
          "npm run check:phishing-signatures",
          "npm run check:classifier-sensitive-copy",
          "npm run check:build-size",
          "npm run check:build-attribution",
        ],
        ["npm run test:noncritical -- --shard=1/2"],
        ["npm run test:noncritical -- --shard=2/2"],
        ["npm run coverage:critical"],
        ["npm run typecheck:worker"],
        ["npm run validate:worker-scheduled-smoke"],
      ],
      [["npm run validate:pages-smoke"], ["npm run validate:worker-smoke"]],
    ]);
  });
});

describe("fetchBaseRef", () => {
  it("runs git fetch for the branch suffix of origin-prefixed base refs", () => {
    const calls: unknown[] = [];
    const execFile = mockExecFileSync((cmd, args) => {
      calls.push([cmd, args]);
      return "";
    });

    fetchBaseRef({ baseRef: "origin/main", execFile } as never);
    expect(calls).toEqual([["git", ["fetch", "--quiet", "origin", "main"]]]);
  });

  it("skips non-origin base refs", () => {
    const calls: unknown[] = [];
    const execFile = mockExecFileSync((cmd, args) => {
      calls.push([cmd, args]);
      return "";
    });

    fetchBaseRef({ baseRef: "abc123", execFile } as never);
    expect(calls).toEqual([]);
  });

  it("warns but does not throw when the fetch fails", () => {
    const execFile = mockExecFileSync(() => {
      throw new Error("network down");
    });

    expect(() => fetchBaseRef({ baseRef: "origin/main", execFile } as never)).not.toThrow();
  });
});

describe("runMergeGate fetch and node_modules wiring", () => {
  function makeStubs() {
    const fetchCalls: string[][] = [];
    const execFile = mockExecFileSync((_cmd, args, options) => {
      if (args[0] === "fetch") {
        fetchCalls.push([...args]);
        return "";
      }
      if (args[0] === "diff") {
        if (options?.encoding === "utf8") {
          return "";
        }
        return Buffer.from("");
      }
      return "";
    });
    const runCommandCalls: string[] = [];
    const runCommandImpl = mockCommandRunner((cmd) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    });
    return { fetchCalls, execFile, runCommandCalls, runCommandImpl };
  }

  it("runs git fetch when no MERGE_GATE_BASE_REF is set and not in staged or full-deploy mode", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({ argv: [], env: testEnv(), runCommandImpl, execFile });
    expect(fetchCalls).toEqual([["fetch", "--quiet", "origin", "main"]]);
  });

  it("skips the fetch when MERGE_GATE_BASE_REF is explicitly set (pre-push hook case)", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({
      argv: [],
      env: testEnv({ MERGE_GATE_BASE_REF: "abc123", MERGE_GATE_HEAD_REF: "def456" }),
      runCommandImpl,
      execFile,
    });
    expect(fetchCalls).toEqual([]);
  });

  it("skips the fetch when MERGE_GATE_NO_FETCH=1 is set", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({
      argv: [],
      env: testEnv({ MERGE_GATE_NO_FETCH: "1" }),
      runCommandImpl,
      execFile,
    });
    expect(fetchCalls).toEqual([]);
  });

  it("skips the fetch in --staged mode", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({ argv: ["--staged"], env: testEnv(), runCommandImpl, execFile });
    expect(fetchCalls).toEqual([]);
  });

  it("invokes the node_modules drift check before executing validation commands", async () => {
    const { execFile: baseExecFile, runCommandImpl, runCommandCalls } = makeStubs();
    const execFile = mockExecFileSync((cmd, args, options) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return baseExecFile(cmd, args, options);
    });
    await runMergeGate({ argv: [], env: testEnv(), runCommandImpl, execFile });
    expect(runCommandCalls[0]).toBe("node scripts/ci/check-node-modules-fresh.mjs --strict");
    expect(runCommandCalls[1]).toBe("npm run validate:prebuild");
  });

  it("prints the dry-run plan without requiring a node_modules freshness check", async () => {
    const execFile = mockExecFileSync((_cmd, args, options) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return "";
    });
    const runCommandCalls: string[] = [];
    const runCommandImpl = mockCommandRunner((cmd) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    });

    await runMergeGate({
      argv: [],
      env: testEnv({ MERGE_GATE_DRY_RUN: "1", MERGE_GATE_NO_FETCH: "1" }),
      runCommandImpl,
      execFile,
    });

    expect(runCommandCalls).toEqual([]);
  });

  it("runs merge-gate discovery after prebuild failures and reports the final nonzero status", async () => {
    const execFile = mockExecFileSync((_cmd, args, options) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "shared/lib/classification.ts\n";
      }
      return "";
    });
    const runCommandCalls: string[] = [];
    let exitStatus: number | undefined;
    const runCommandImpl = mockCommandRunner((cmd) => {
      runCommandCalls.push(cmd);
      if (cmd === "npm run validate:prebuild") {
        return Promise.resolve({ status: 7, aborted: false });
      }
      if (cmd === "npm run test:noncritical -- --shard=1/2") {
        return Promise.resolve({ status: 9, aborted: false });
      }
      return Promise.resolve({ status: 0, aborted: false });
    });

    const result = await runMergeGateDiscovery({
      argv: [],
      env: testEnv({ MERGE_GATE_NO_FETCH: "1", MERGE_GATE_DISCOVERY_MAX_PARALLEL: "3" }),
      runCommandImpl,
      execFile,
      exit: captureProcessExit((status) => {
        exitStatus = status;
      }),
    });

    expect(result).toEqual({ status: 7 });
    expect(exitStatus).toBe(7);
    expect(runCommandCalls.slice(0, 2)).toEqual([
      "node scripts/ci/check-node-modules-fresh.mjs --strict",
      "npm run validate:prebuild",
    ]);
    expect(new Set(runCommandCalls)).toEqual(
      new Set([
        "node scripts/ci/check-node-modules-fresh.mjs --strict",
        "npm run validate:prebuild",
        "npm run build",
        "npm run test:noncritical -- --shard=1/2",
        "npm run test:noncritical -- --shard=2/2",
        "npm run coverage:critical",
        "npm run typecheck:worker",
        "npm run validate:worker-scheduled-smoke",
        "npm run test:a11y",
        "npm run check:feature-flag-inlining",
        "npm run seo:check",
        "npm run check:phishing-signatures",
        "npm run check:classifier-sensitive-copy",
        "npm run check:build-size",
        "npm run check:build-attribution",
      ]),
    );
    expect(runCommandCalls).not.toContain("npm run validate:pages-smoke");
  });

  it("defaults Pages smoke on for the normal local merge gate", async () => {
    const execFile = mockExecFileSync((_cmd, args, options) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return "";
    });
    const runCommandCalls: string[] = [];
    const runCommandImpl = mockCommandRunner((cmd) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    });

    await runMergeGate({ argv: [], env: testEnv({ MERGE_GATE_NO_FETCH: "1" }), runCommandImpl, execFile });

    expect(runCommandCalls).toContain("npm run validate:pages-smoke");
  });

  it("allows Pages smoke to be disabled explicitly", async () => {
    const execFile = mockExecFileSync((_cmd, args, options) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return "";
    });
    const runCommandCalls: string[] = [];
    const runCommandImpl = mockCommandRunner((cmd) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    });

    await runMergeGate({
      argv: [],
      env: testEnv({ MERGE_GATE_NO_FETCH: "1", MERGE_GATE_PAGES_SMOKE: "0" }),
      runCommandImpl,
      execFile,
    });

    expect(runCommandCalls).not.toContain("npm run validate:pages-smoke");
  });
});
