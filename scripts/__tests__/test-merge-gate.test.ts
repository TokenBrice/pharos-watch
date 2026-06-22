import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExecutionBatches,
  buildCommandPlan,
  buildFullCommandPlan,
  fetchBaseRef,
  getChangedFiles,
  getProductionPagesPublicEnv,
  getValidatePrebuildSurface,
  runExecutionBatches,
  runMergeGate,
} from "../maintenance/test-merge-gate.mjs";
import { getCommandEnv } from "../maintenance/test-merge-gate.mjs";
import {
  buildValidatePrebuildCommands,
  buildValidatePrebuildCommandsForSurface,
  buildValidatePrebuildCommandsForSurfaceAndTier,
  buildCiValidateCommands,
  buildCiValidateStepPlan,
  buildNoncriticalTestShardCommands,
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  COMMON_VALIDATE_PREBUILD_COMMANDS,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  resolveValidatePrebuildTier,
  VALIDATE_PREBUILD_COMMANDS,
  VALIDATE_PREBUILD_SURFACE_ENV,
  VALIDATE_PREBUILD_TIER_ENV,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validate-contract.mjs";
import {
  buildValidatePrebuildExecutionUnits,
  printValidatePrebuildCommandPlan,
  runValidatePrebuild,
} from "../maintenance/run-validate-prebuild.mjs";
import {
  buildDiscoveryExecutionGroups,
  getDiscoveryCommandEnv,
  resolveDiscoveryMaxParallel,
  runMergeGateDiscovery,
} from "../maintenance/run-merge-gate-discovery.mjs";

const TELEGRAM_LOAD_ADVISORY_COMMAND = "npx tsx scripts/ci/check-telegram-load.ts";

describe("buildCommandPlan", () => {
  it("skips the merge gate when no deploy surfaces changed", () => {
    expect(buildCommandPlan(["docs/testing.md", "docs/process/notes.md"])).toEqual([]);
  });

  it("runs the Pages path without worker typecheck for frontend export changes", () => {
    expect(buildCommandPlan(["src/app/page.tsx"]).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ]);
  });

  it("runs the worker path without build or SEO for worker-only changes", () => {
    expect(
      buildCommandPlan(["worker/src/api/status.ts", "worker/src/cron/sync-yield-data.ts"]).map((item) => item.cmd),
    ).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("adds the Telegram advisory load guard for Telegram dispatch changes", () => {
    expect(buildCommandPlan(["worker/src/cron/dispatch-telegram-alerts.ts"]).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
    ]);
  });

  it("runs the full path for shared runtime changes", () => {
    expect(buildCommandPlan(["shared/lib/classification.ts"]).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("runs the Pages path only for known Pages-only shared helpers", () => {
    expect(buildCommandPlan(["shared/lib/public-docs.ts"]).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
    ]);
  });

  it("can force the full deploy validate path when the push base is unavailable", () => {
    expect(buildFullCommandPlan().map((item) => item.cmd)).toEqual([
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

    expect(buildCommandPlan(allSkippableFiles).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      TELEGRAM_LOAD_ADVISORY_COMMAND,
    ]);
  });

  it("provides the changed-file set to the local critical coverage command", () => {
    expect(getCommandEnv("npm run coverage:critical", ["worker/src/api/status.ts", "docs/testing.md"], {})).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts,docs/testing.md",
    });

    expect(getCommandEnv("npm run test:noncritical", ["worker/src/api/status.ts"], {})).toEqual({
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

    expect(getCommandEnv("npm run validate:prebuild", ["src/app/page.tsx"], {})).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
    });
    expect(getCommandEnv("npm run validate:prebuild", ["worker/src/api/status.ts"], {})).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "worker",
    });
  });

  it("keeps inherited non-full validate:prebuild tiers from weakening the merge gate", () => {
    const commandEnv = getCommandEnv("npm run validate:prebuild", ["src/app/page.tsx"], {
      [VALIDATE_PREBUILD_TIER_ENV]: "blocking",
    });

    expect(commandEnv).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
    });
    expect(resolveValidatePrebuildTier("blocking", { ci: commandEnv.CI }).effectiveTier).toBe("full");
  });

  it("applies the production Pages build env for local static export validation", () => {
    expect(getCommandEnv("npm run build", ["src/app/page.tsx"], {})).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      NEXT_PUBLIC_FORCE_SITE_DATA_PROXY: "true",
      PUBLIC_DATASETS_API_URL: "",
      PUBLIC_DATASETS_API_KEY: "",
      PUBLIC_DATASETS_REQUIRE_API: "",
      SMOKE_API_BASE: "",
      API_BASE_URL: "",
    });
  });

  it("keeps Pages public env offline by default for local Pages validation", () => {
    const env = {
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_UNRELATED: "keep-out",
    };

    expect(getCommandEnv("npm run build", ["src/app/page.tsx"], env)).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      NEXT_PUBLIC_GA_ID: undefined,
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: undefined,
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
    const env = {
      MERGE_GATE_PRODUCTION_ENV: "1",
      NEXT_PUBLIC_GA_ID: "G-PROD",
      NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      NEXT_PUBLIC_PHAROS_HERO_VERDICT: "false",
      NEXT_PUBLIC_UNRELATED: "keep-out",
    };

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

  it("skips base env injection when MERGE_GATE_NATIVE_ENV=1 is set", () => {
    expect(
      getCommandEnv("npm run coverage:critical", ["worker/src/api/status.ts"], { MERGE_GATE_NATIVE_ENV: "1" }),
    ).toEqual({
      CRITICAL_COVERAGE_CHANGED_FILES: "worker/src/api/status.ts",
    });

    expect(
      getCommandEnv("npm run test:noncritical", ["worker/src/api/status.ts"], { MERGE_GATE_NATIVE_ENV: "1" }),
    ).toEqual({});
  });

  it("skips local mobile smoke when pages smoke runs for non-UI diffs", () => {
    expect(getCommandEnv("npm run validate:pages-smoke", [".github/workflows/pages-release.yml"], {})).toEqual({
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
    expect(getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], {})).toEqual({
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
      getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], {
        MERGE_GATE_PRODUCTION_ENV: "1",
        NEXT_PUBLIC_GA_ID: "G-PROD",
      }),
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
      getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], {
        MERGE_GATE_PRODUCTION_ENV: "1",
        NEXT_PUBLIC_GA_ID: "G-PROD",
        SMOKE_UI_EXPECT_GA_ID: "G-CUSTOM",
      }),
    ).not.toHaveProperty("SMOKE_UI_EXPECT_GA_ID");
  });

  it("does not override explicit local mobile smoke env overrides", () => {
    expect(
      getCommandEnv("npm run validate:pages-smoke", ["src/app/page.tsx"], {
        SMOKE_UI_OVERFLOW_ROUTES: "/desktop/",
        SMOKE_UI_OVERFLOW_WORKERS: "2",
        SMOKE_MOBILE_UI_ROUTES: "/custom/",
        SMOKE_MOBILE_UI_VIEWPORTS: "412x915",
        SMOKE_MOBILE_UI_SKIP_DESKTOP: "0",
        SMOKE_MOBILE_UI_WORKERS: "5",
        SMOKE_MOBILE_UI_WAIT_MS: "2100",
      }),
    ).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      PAGES_SMOKE_INCLUDE_MOBILE: "1",
    });
  });

  it("defaults local worker smoke to canary API scope", () => {
    expect(getCommandEnv("npm run validate:worker-smoke", ["worker/src/api/status.ts"], {})).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      SMOKE_API_SCOPE: "canary",
    });
  });

  it("preserves explicit local worker smoke API scope overrides", () => {
    expect(
      getCommandEnv("npm run validate:worker-smoke", ["worker/src/api/status.ts"], { SMOKE_API_SCOPE: "full" }),
    ).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
    });
  });

  it("groups independent post-validate checks for parallel local execution", () => {
    const plan = buildCommandPlan(["shared/lib/classification.ts"]);
    expect(
      buildExecutionBatches(plan).map((batch) => batch.map((unit) => unit.commands.map((item) => item.cmd))),
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
    const batches = buildExecutionBatches(plan).map((batch) =>
      batch.map((unit) => unit.commands.map((item) => item.cmd)),
    );

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
      { MERGE_GATE_PARALLEL: "1" },
      {
        exit: (status) => {
          exitStatus = status;
        },
        runCommandImpl: (cmd, _extraEnv, { signal } = {}) => {
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
        },
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

    expect(groups.prebuildUnits.map((unit) => unit.commands.map((item) => item.cmd))).toEqual([
      ["npm run validate:prebuild"],
    ]);
    expect(groups.postValidateUnits.map((unit) => unit.commands.map((item) => item.cmd))).toEqual([
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

    expect(groups.postValidateUnits.map((unit) => unit.commands.map((item) => item.cmd))).not.toContainEqual([
      "npm run validate:pages-smoke",
    ]);
    expect(groups.smokeUnits.map((unit) => unit.commands.map((item) => item.cmd))).toEqual([
      ["npm run validate:pages-smoke"],
      ["npm run validate:worker-smoke"],
    ]);
  });

  it("forces validate:prebuild discovery to continue on errors", () => {
    expect(getDiscoveryCommandEnv({ cmd: "npm run validate:prebuild" }, ["src/app/page.tsx"], {})).toEqual({
      TZ: "UTC",
      LANG: "C.UTF-8",
      CI: "true",
      [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
      VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
    });
    expect(getDiscoveryCommandEnv({ cmd: "npm run build" }, ["src/app/page.tsx"], {})).toEqual(
      getCommandEnv("npm run build", ["src/app/page.tsx"], {}),
    );
  });

  it("bounds discovery parallelism with an explicit override", () => {
    expect(resolveDiscoveryMaxParallel({}, 16)).toBe(6);
    expect(resolveDiscoveryMaxParallel({}, 4)).toBe(2);
    expect(resolveDiscoveryMaxParallel({ MERGE_GATE_DISCOVERY_MAX_PARALLEL: "3" }, 16)).toBe(3);
  });

  it("passes changed-file env only to coverage during execution", async () => {
    const envByCommand = new Map<string, Record<string, string>>();

    await runExecutionBatches(
      [
        { cmd: "npm run test:noncritical", reasons: ["test"] },
        { cmd: "npm run coverage:critical", reasons: ["test"] },
      ],
      ["src/app/page.tsx", "worker/src/api/status.ts"],
      { MERGE_GATE_SERIAL: "1", MERGE_GATE_NATIVE_ENV: "1" },
      {
        exit: () => {
          throw new Error("unexpected exit");
        },
        runCommandImpl: (cmd, extraEnv) => {
          envByCommand.set(cmd, extraEnv);
          return 0;
        },
      },
    );

    expect(envByCommand.get("npm run test:noncritical")).toEqual({});
    expect(envByCommand.get("npm run coverage:critical")).toEqual({
      CRITICAL_COVERAGE_CHANGED_FILES: "src/app/page.tsx,worker/src/api/status.ts",
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
      {
        MERGE_GATE_PRODUCTION_ENV: "1",
        NEXT_PUBLIC_GA_ID: "G-PROD",
        NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER: "true",
      },
      {
        exit: () => {
          throw new Error("unexpected exit");
        },
        runCommandImpl: (cmd, extraEnv) => {
          envByCommand.set(cmd, extraEnv);
          return 0;
        },
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

describe("validate:prebuild surface filtering", () => {
  it("keeps validation-only and full checks while skipping worker-only checks for pages-only hints", () => {
    const commands = buildValidatePrebuildCommandsForSurface("pages");

    expect(commands).toContain("npm run audit:deps");
    expect(commands).toContain("npm run audit:pricing-providers");
    expect(commands).toContain("npm run check:provider-resilience");
    expect(commands).toContain("npm run check:dependency-coverage");
    expect(commands).toContain("npm run check:generated-artifacts");
    expect(commands).toContain("npm run check:world-map");
    expect(commands).not.toContain("npm run check:migrations");
    expect(commands).not.toContain("npm run check:sql-safety");
  });

  it("keeps validation-only and full checks while skipping pages-only checks for worker-only hints", () => {
    const commands = buildValidatePrebuildCommandsForSurface("worker");

    expect(commands).toContain("npm run audit:deps");
    expect(commands).toContain("npm run audit:pricing-providers");
    expect(commands).toContain("npm run check:provider-resilience");
    expect(commands).toContain("npm run check:dependency-coverage");
    expect(commands).toContain("npm run check:migrations");
    expect(commands).toContain("npm run check:sql-safety");
    expect(commands).not.toContain("npm run check:generated-artifacts");
    expect(commands).not.toContain("npm run check:world-map");
  });

  it("keeps the full prebuild set when the hint is full or absent", () => {
    expect(buildValidatePrebuildCommandsForSurface("full")).toEqual(VALIDATE_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommandsForSurface(undefined)).toEqual(VALIDATE_PREBUILD_COMMANDS);
  });

  it("keeps full tier as the existing surface-filtered command set", () => {
    expect(buildValidatePrebuildCommands({ surface: "full", tier: "full" })).toEqual(VALIDATE_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands({ surface: "worker", tier: "full" })).toEqual(
      buildValidatePrebuildCommandsForSurface("worker"),
    );
  });

  it("builds the blocking tier from the initial blocking command classification", () => {
    expect(buildValidatePrebuildCommandsForSurfaceAndTier("full", "blocking")).toEqual([
      "npm run lint",
      "npm run lint:typed",
      "npm run typecheck",
      "npm run check:client-registry-imports",
      "npm run check:cron-connections",
      "npm run check:cron-sync",
      "npm run check:env-contract",
      "npm run check:generated-artifacts",
      "npm run check:migrations",
      "npm run check:site-csp-sync",
      "npm run check:sql-safety",
      "npm run check:stablecoin-data",
      "npm run check:supply-helper-usage",
      "npm run check:worker-boundary",
    ]);
  });

  it("keeps the surface tier stronger than blocking while excluding full-only advisory checks", () => {
    const blockingCommands = buildValidatePrebuildCommandsForSurfaceAndTier("full", "blocking");
    const surfaceCommands = buildValidatePrebuildCommandsForSurfaceAndTier("full", "surface");

    expect(surfaceCommands).toEqual(expect.arrayContaining(blockingCommands));
    expect(surfaceCommands).toEqual(
      expect.arrayContaining([
        "npm run audit:pricing-providers",
        "npm run check:provider-resilience",
        "npm run check:attestor-tier-coverage",
        "npm run check:hook-polling-window",
        "npm run check:oracle-risk-coverage:enforce",
      ]),
    );
    expect(surfaceCommands).not.toContain("npm run check:agent-doc-sync");
    expect(surfaceCommands).not.toContain("npm run check:dependency-coverage");
    expect(surfaceCommands).not.toContain("npm run check:unused-code");
  });

  it("composes non-full tiers with deploy-impact surface filtering", () => {
    const workerSurfaceCommands = buildValidatePrebuildCommandsForSurfaceAndTier("worker", "surface");

    expect(workerSurfaceCommands).toContain("npm run check:migrations");
    expect(workerSurfaceCommands).toContain("npm run check:sql-safety");
    expect(workerSurfaceCommands).toContain("npm run check:hook-polling-window");
    expect(workerSurfaceCommands).not.toContain("npm run check:generated-artifacts");
    expect(workerSurfaceCommands).not.toContain("npm run check:mechanism-archetype-coverage");
    expect(workerSurfaceCommands).not.toContain("npm run check:world-map");
  });

  it("normalizes unknown or absent validate:prebuild tiers to full", () => {
    expect(resolveValidatePrebuildTier(undefined, { ci: undefined })).toEqual({
      ciOverride: false,
      effectiveTier: "full",
      requestedTier: "full",
    });
    expect(resolveValidatePrebuildTier("unexpected", { ci: undefined })).toEqual({
      ciOverride: false,
      effectiveTier: "full",
      requestedTier: "full",
    });
  });

  it("ignores non-full validate:prebuild tiers under CI=true", () => {
    expect(resolveValidatePrebuildTier("blocking", { ci: "true" })).toEqual({
      ciOverride: true,
      effectiveTier: "full",
      requestedTier: "blocking",
    });
    expect(resolveValidatePrebuildTier("surface", { ci: "true" })).toEqual({
      ciOverride: true,
      effectiveTier: "full",
      requestedTier: "surface",
    });
    expect(resolveValidatePrebuildTier("full", { ci: "true" })).toEqual({
      ciOverride: false,
      effectiveTier: "full",
      requestedTier: "full",
    });
  });

  it("builds runner units from the filtered surface command set", () => {
    expect(buildValidatePrebuildExecutionUnits("worker").map((unit) => unit.commands[0])).toEqual(
      buildValidatePrebuildCommandsForSurface("worker"),
    );
  });

  it("prints the exact prebuild command plan", () => {
    const logs: string[] = [];
    printValidatePrebuildCommandPlan(buildValidatePrebuildExecutionUnits("pages"), {
      log: (line) => logs.push(line),
    });

    expect(logs).toEqual([
      "[validate:prebuild] Command plan:",
      ...buildValidatePrebuildCommandsForSurface("pages").map((cmd, index) => `${index + 1}. ${cmd}`),
    ]);
  });

  it("prints a dry-run plan without executing prebuild units", async () => {
    const logs: string[] = [];
    let executed = false;

    const result = await runValidatePrebuild({
      argv: ["--dry-run"],
      env: {
        [VALIDATE_PREBUILD_SURFACE_ENV]: "worker",
      },
      log: (line) => logs.push(line),
      runExecutionUnits: () => {
        executed = true;
        throw new Error("dry-run must not execute");
      },
    });

    const expectedCommands = buildValidatePrebuildCommandsForSurface("worker");
    expect(expectedCommands).toContain("npm run check:migrations");
    expect(expectedCommands).not.toContain("npm run check:generated-artifacts");
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(executed).toBe(false);
    expect(logs).toEqual([
      `[validate:prebuild] Surface hint: worker; tier: full; dry-run plan has ${expectedCommands.length} prebuild command(s).`,
      "[validate:prebuild] Command plan:",
      ...expectedCommands.map((cmd, index) => `${index + 1}. ${cmd}`),
      "[validate:prebuild] Dry run enabled; commands not executed.",
    ]);
  });

  it("prints a tiered dry-run plan without executing prebuild units", async () => {
    const logs: string[] = [];
    let executed = false;

    const result = await runValidatePrebuild({
      argv: ["--dry-run"],
      env: {
        [VALIDATE_PREBUILD_TIER_ENV]: "blocking",
      },
      log: (line) => logs.push(line),
      runExecutionUnits: () => {
        executed = true;
        throw new Error("dry-run must not execute");
      },
    });

    const expectedCommands = buildValidatePrebuildCommandsForSurfaceAndTier("full", "blocking");
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(executed).toBe(false);
    expect(logs).toEqual([
      `[validate:prebuild] Surface hint: full; tier: blocking; dry-run plan has ${expectedCommands.length} prebuild command(s).`,
      "[validate:prebuild] Command plan:",
      ...expectedCommands.map((cmd, index) => `${index + 1}. ${cmd}`),
      "[validate:prebuild] Dry run enabled; commands not executed.",
    ]);
  });

  it("prints the CI tier override in dry-run plans", async () => {
    const logs: string[] = [];

    await runValidatePrebuild({
      argv: ["--dry-run"],
      env: {
        CI: "true",
        [VALIDATE_PREBUILD_SURFACE_ENV]: "worker",
        [VALIDATE_PREBUILD_TIER_ENV]: "blocking",
      },
      log: (line) => logs.push(line),
      runExecutionUnits: () => {
        throw new Error("dry-run must not execute");
      },
    });

    const expectedCommands = buildValidatePrebuildCommandsForSurface("worker");
    expect(logs).toEqual([
      `[validate:prebuild] Surface hint: worker; tier: full (requested blocking ignored because CI=true); dry-run plan has ${expectedCommands.length} prebuild command(s).`,
      "[validate:prebuild] Command plan:",
      ...expectedCommands.map((cmd, index) => `${index + 1}. ${cmd}`),
      "[validate:prebuild] Dry run enabled; commands not executed.",
    ]);
  });

  it("uses the full prebuild command set by default in non-dry-run mode", async () => {
    let receivedUnits: Array<{ commands: string[] }> = [];
    let receivedOptions: { continueOnError?: boolean; label?: string; maxParallel?: number } | undefined;

    await runValidatePrebuild({
      argv: [],
      env: {},
      log: () => {},
      runExecutionUnits: (units, options) => {
        receivedUnits = units;
        receivedOptions = options;
        return Promise.resolve({ status: 0, failedCmd: null, aborted: false });
      },
    });

    expect(receivedUnits.map((unit) => unit.commands[0])).toEqual(VALIDATE_PREBUILD_COMMANDS);
    expect(receivedOptions).toMatchObject({
      continueOnError: false,
      label: "validate:prebuild",
    });
  });

  it("passes filtered runner units and continue-on-error through the prebuild runner", async () => {
    let receivedUnits: Array<{ commands: string[] }> = [];
    let receivedOptions: { continueOnError?: boolean; label?: string; maxParallel?: number } | undefined;

    await runValidatePrebuild({
      argv: [],
      env: {
        [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
        [VALIDATE_PREBUILD_TIER_ENV]: "surface",
        VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
      },
      runExecutionUnits: (units, options) => {
        receivedUnits = units;
        receivedOptions = options;
        return Promise.resolve({ status: 0, failedCmd: null, aborted: false });
      },
    });

    expect(receivedUnits.map((unit) => unit.commands[0])).toEqual(
      buildValidatePrebuildCommandsForSurfaceAndTier("pages", "surface"),
    );
    expect(receivedOptions).toMatchObject({
      continueOnError: true,
      label: "validate:prebuild",
    });
  });
});

describe("getChangedFiles", () => {
  it("passes the base and head refs to git diff as a single range argument", () => {
    const calls: unknown[] = [];
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "worker/src/api/status.ts\n";
    };

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
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "src/app/page.tsx\n";
    };

    expect(getChangedFiles({ stagedMode: true, execFile })).toEqual(["src/app/page.tsx"]);
    expect(calls).toEqual([["git", ["diff", "--name-only", "--cached"]]]);
  });

  it("rejects empty push bases unless the full deploy gate is requested by the caller", () => {
    expect(() => getChangedFiles({ baseRef: "0000000000000000000000000000000000000000" })).toThrow(
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
    expect(buildCommandPlan(["src/app/page.tsx"], { pagesSmoke: true }).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...PAGES_VALIDATE_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...PAGES_SMOKE_VALIDATE_COMMANDS,
    ]);
  });

  it("does not append Pages smoke for worker-only changes", () => {
    expect(buildCommandPlan(["worker/src/api/status.ts"], { pagesSmoke: true }).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
    ]);
  });

  it("appends worker smoke after worker typechecks when MERGE_GATE_WORKER_SMOKE is requested", () => {
    expect(buildCommandPlan(["worker/src/api/status.ts"], { workerSmoke: true }).map((item) => item.cmd)).toEqual([
      ...COMMON_VALIDATE_PREBUILD_COMMANDS,
      ...COMMON_VALIDATE_POSTBUILD_COMMANDS,
      ...WORKER_VALIDATE_COMMANDS,
      ...WORKER_SMOKE_VALIDATE_COMMANDS,
    ]);
  });

  it("appends both smokes in buildFullCommandPlan when requested", () => {
    expect(buildFullCommandPlan("forced", { pagesSmoke: true, workerSmoke: true }).map((item) => item.cmd)).toEqual([
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
      buildExecutionBatches(plan).map((batch) => batch.map((unit) => unit.commands.map((item) => item.cmd))),
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
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "";
    };

    fetchBaseRef({ baseRef: "origin/main", execFile });
    expect(calls).toEqual([["git", ["fetch", "--quiet", "origin", "main"]]]);
  });

  it("skips non-origin base refs", () => {
    const calls: unknown[] = [];
    const execFile = (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "";
    };

    fetchBaseRef({ baseRef: "abc123", execFile });
    expect(calls).toEqual([]);
  });

  it("warns but does not throw when the fetch fails", () => {
    const execFile = () => {
      throw new Error("network down");
    };

    expect(() => fetchBaseRef({ baseRef: "origin/main", execFile })).not.toThrow();
  });
});

describe("runMergeGate fetch and node_modules wiring", () => {
  function makeStubs() {
    const fetchCalls: string[][] = [];
    const execFile = (cmd: string, args: string[], options?: { encoding?: string }) => {
      if (args[0] === "fetch") {
        fetchCalls.push(args);
        return "";
      }
      if (args[0] === "diff") {
        if (options?.encoding === "utf8") {
          return "";
        }
        return Buffer.from("");
      }
      return "";
    };
    const runCommandCalls: string[] = [];
    const runCommandImpl = (cmd: string) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    };
    return { fetchCalls, execFile, runCommandCalls, runCommandImpl };
  }

  it("runs git fetch when no MERGE_GATE_BASE_REF is set and not in staged or full-deploy mode", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({ argv: [], env: {}, runCommandImpl, execFile });
    expect(fetchCalls).toEqual([["fetch", "--quiet", "origin", "main"]]);
  });

  it("skips the fetch when MERGE_GATE_BASE_REF is explicitly set (pre-push hook case)", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({
      argv: [],
      env: { MERGE_GATE_BASE_REF: "abc123", MERGE_GATE_HEAD_REF: "def456" },
      runCommandImpl,
      execFile,
    });
    expect(fetchCalls).toEqual([]);
  });

  it("skips the fetch when MERGE_GATE_NO_FETCH=1 is set", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({
      argv: [],
      env: { MERGE_GATE_NO_FETCH: "1" },
      runCommandImpl,
      execFile,
    });
    expect(fetchCalls).toEqual([]);
  });

  it("skips the fetch in --staged mode", async () => {
    const { fetchCalls, execFile, runCommandImpl } = makeStubs();
    await runMergeGate({ argv: ["--staged"], env: {}, runCommandImpl, execFile });
    expect(fetchCalls).toEqual([]);
  });

  it("invokes the node_modules drift check before executing validation commands", async () => {
    const { execFile: baseExecFile, runCommandImpl, runCommandCalls } = makeStubs();
    const execFile = (cmd: string, args: string[], options?: { encoding?: string }) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return baseExecFile(cmd, args, options);
    };
    await runMergeGate({ argv: [], env: {}, runCommandImpl, execFile });
    expect(runCommandCalls[0]).toBe("node scripts/ci/check-node-modules-fresh.mjs --strict");
    expect(runCommandCalls[1]).toBe("npm run validate:prebuild");
  });

  it("prints the dry-run plan without requiring a node_modules freshness check", async () => {
    const execFile = (_cmd: string, args: string[], options?: { encoding?: string }) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return "";
    };
    const runCommandCalls: string[] = [];
    const runCommandImpl = (cmd: string) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    };

    await runMergeGate({
      argv: [],
      env: { MERGE_GATE_DRY_RUN: "1", MERGE_GATE_NO_FETCH: "1" },
      runCommandImpl,
      execFile,
    });

    expect(runCommandCalls).toEqual([]);
  });

  it("runs merge-gate discovery after prebuild failures and reports the final nonzero status", async () => {
    const execFile = (_cmd: string, args: string[], options?: { encoding?: string }) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "shared/lib/classification.ts\n";
      }
      return "";
    };
    const runCommandCalls: string[] = [];
    let exitStatus: number | undefined;
    const runCommandImpl = (cmd: string) => {
      runCommandCalls.push(cmd);
      if (cmd === "npm run validate:prebuild") {
        return Promise.resolve({ status: 7, aborted: false });
      }
      if (cmd === "npm run test:noncritical -- --shard=1/2") {
        return Promise.resolve({ status: 9, aborted: false });
      }
      return Promise.resolve({ status: 0, aborted: false });
    };

    const result = await runMergeGateDiscovery({
      argv: [],
      env: { MERGE_GATE_NO_FETCH: "1", MERGE_GATE_DISCOVERY_MAX_PARALLEL: "3" },
      runCommandImpl,
      execFile,
      exit: (status) => {
        exitStatus = status;
      },
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
    const execFile = (cmd: string, args: string[], options?: { encoding?: string }) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return "";
    };
    const runCommandCalls: string[] = [];
    const runCommandImpl = (cmd: string) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    };

    await runMergeGate({ argv: [], env: { MERGE_GATE_NO_FETCH: "1" }, runCommandImpl, execFile });

    expect(runCommandCalls).toContain("npm run validate:pages-smoke");
  });

  it("allows Pages smoke to be disabled explicitly", async () => {
    const execFile = (_cmd: string, args: string[], options?: { encoding?: string }) => {
      if (args[0] === "diff" && options?.encoding === "utf8") {
        return "src/app/page.tsx\n";
      }
      return "";
    };
    const runCommandCalls: string[] = [];
    const runCommandImpl = (cmd: string) => {
      runCommandCalls.push(cmd);
      return Promise.resolve({ status: 0, aborted: false });
    };

    await runMergeGate({
      argv: [],
      env: { MERGE_GATE_NO_FETCH: "1", MERGE_GATE_PAGES_SMOKE: "0" },
      runCommandImpl,
      execFile,
    });

    expect(runCommandCalls).not.toContain("npm run validate:pages-smoke");
  });
});
