import { describe, expect, it } from "vitest";
import {
  buildNoncriticalTestShardCommands,
  buildValidatePrebuildCommands,
  COMMON_VALIDATE_POSTBUILD_COMMANDS,
  flattenValidationImpactPaths,
  PAGES_SMOKE_VALIDATE_COMMANDS,
  PAGES_VALIDATE_COMMANDS,
  VALIDATE_PREBUILD_COMMANDS,
  VALIDATION_IMPACT_PATHS,
  VALIDATION_LANES,
  validateValidationLanes,
  WORKER_SMOKE_VALIDATE_COMMANDS,
  WORKER_VALIDATE_COMMANDS,
} from "../lib/validation-lanes.mjs";
import { CRITICAL_TEST_FILES } from "../lib/critical-test-files.mjs";
import { getValidationPhaseCommands, runValidationPhase } from "../maintenance/run-validation-phase.mjs";

const WORKER_SCHEDULED_TEST = "worker/src/__tests__/index.scheduled.test.ts";

const EXPECTED_PREBUILD_COMMANDS = [
  "npm run audit:deps",
  "npm run audit:pricing-providers",
  "npm run check:provider-resilience",
  "npm run check:fetch-body-timeouts",
  "npm run lint",
  "npm run lint:typed",
  "npm run typecheck",
  "npm run typecheck:tests",
  "npm run check:agent-doc-sync",
  "npm run check:agent-skill-symlinks",
  "npm run check:client-registry-imports",
  "npm run check:cli-args-policy",
  "npm run check:cron-abort-contract",
  "npm run check:cron-console-usage",
  "npm run check:json-parse-ratchet",
  "npm run check:cron-connections",
  "npm run check:cron-sync",
  "npm run check:worker-config",
  "npm run check:doc-counts",
  "npm run check:doc-source-paths",
  "npm run check:doc-sync",
  "npm run check:env-contract",
  "npm run check:frozen-invariants",
  "npm run check:generated-artifacts",
  "npm run check:hook-polling-window",
  "npm run check:hotspot-ratchet",
  "npm run check:migrations",
  "npm run check:redemption-backstops",
  "npm run check:site-csp-sync",
  "npm run check:script-entrypoints",
  "npm run check:shared-cycles",
  "npm run check:shared-types-imports",
  "npm run check:sql-safety",
  "npm run check:stale-flags",
  "npm run check:stablecoin-data",
  "npm run check:oracle-risk-coverage:enforce",
  "npm run check:supply-helper-usage",
  "npm run check:unused-code",
  "npm run check:verified-doc-links",
  "npm run check:worker-boundary",
  "npm run check:dependency-coverage",
  "npm run check:mechanism-archetype-coverage",
];

describe("validation lane authority", () => {
  it("assigns all current descriptor commands to exactly ten unique lanes", () => {
    validateValidationLanes();
    expect(VALIDATION_LANES).toHaveLength(10);
    expect(VALIDATION_LANES.map((lane) => lane.id)).toEqual([
      "format-and-lint",
      "root-and-worker-typecheck",
      "unit-and-domain-tests",
      "d1-migration-and-runtime-safety",
      "catalog-schema-and-data",
      "generated-output-build-and-seo",
      "browser-and-accessibility",
      "security-dependencies-and-repository-policy",
      "worker-preview-and-smoke",
      "deploy-promotion-and-rollback",
    ]);

    expect(VALIDATION_LANES.flatMap((lane) => lane.leaves)).toHaveLength(58);
  });

  it("keeps the exact prebuild command order and surface selection", () => {
    expect(VALIDATE_PREBUILD_COMMANDS).toEqual(EXPECTED_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands()).toEqual(EXPECTED_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands({ surface: "full" })).toEqual(EXPECTED_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands({ surface: "full" })).toHaveLength(42);
    expect(buildValidatePrebuildCommands({ surface: "pages" })).toHaveLength(37);
    expect(buildValidatePrebuildCommands({ surface: "worker" })).toHaveLength(40);
    expect(buildValidatePrebuildCommands({ surface: "pages" })).toContain("npm run check:dependency-coverage");
    expect(buildValidatePrebuildCommands({ surface: "worker" })).toContain("npm run check:dependency-coverage");
    expect(buildValidatePrebuildCommands({ surface: "pages" })).not.toContain("npm run check:migrations");
    expect(buildValidatePrebuildCommands({ surface: "worker" })).not.toContain("npm run check:generated-artifacts");

    const skipCommands = ["npm run audit:deps", "npm run check:generated-artifacts"];
    expect(buildValidatePrebuildCommands({ surface: "pages", skipCommands })).not.toEqual(
      buildValidatePrebuildCommands({ surface: "pages" }),
    );
    expect(buildValidatePrebuildCommands({ surface: "pages", skipCommands })).not.toContain("npm run audit:deps");
  });

  it("keeps Pages, postbuild, Worker, smoke, and shard plans exact", () => {
    expect(PAGES_VALIDATE_COMMANDS).toEqual([
      "npm run build",
      "npm run test:a11y",
      "npm run check:feature-flag-inlining",
      "npm run seo:check",
      "npm run check:phishing-signatures",
      "npm run check:classifier-sensitive-copy",
      "npm run check:build-size",
      "npm run check:build-attribution",
    ]);
    expect(COMMON_VALIDATE_POSTBUILD_COMMANDS).toEqual([
      "npm run test:noncritical -- --shard=1/2",
      "npm run test:noncritical -- --shard=2/2",
      "npm run coverage:critical",
    ]);
    expect(WORKER_VALIDATE_COMMANDS).toEqual(["npm run typecheck:worker"]);
    expect(CRITICAL_TEST_FILES).toContain(WORKER_SCHEDULED_TEST);
    expect(WORKER_VALIDATE_COMMANDS).not.toContain("npm run validate:worker-scheduled-smoke");
    expect(PAGES_SMOKE_VALIDATE_COMMANDS).toEqual(["npm run validate:pages-smoke"]);
    expect(WORKER_SMOKE_VALIDATE_COMMANDS).toEqual(["npm run validate:worker-smoke"]);
    expect(buildNoncriticalTestShardCommands()).toEqual(COMMON_VALIDATE_POSTBUILD_COMMANDS.slice(0, 2));
  });

  it("keeps lane-owned impact path buckets", () => {
    expect(VALIDATION_IMPACT_PATHS.full).toHaveLength(37);
    expect(VALIDATION_IMPACT_PATHS["validation-only"]).toHaveLength(19);
    expect(VALIDATION_IMPACT_PATHS.pages).toHaveLength(11);
    expect(VALIDATION_IMPACT_PATHS.worker).toHaveLength(8);
    expect(VALIDATION_IMPACT_PATHS.full).toEqual(flattenValidationImpactPaths("full"));
    expect(VALIDATION_IMPACT_PATHS.full).toEqual(
      expect.arrayContaining([
        "scripts/maintenance/generate-dependency-coverage-audit.ts",
        "scripts/maintenance/generate-redemption-coverage-audit.ts",
        "scripts/maintenance/run-validation-phase.mjs",
        "shared/lib/__tests__/peg-price-bounds.test.ts",
      ]),
    );
    expect(VALIDATION_IMPACT_PATHS.pages).toContain("scripts/maintenance/build-world-map-svg.ts");
    expect(VALIDATION_IMPACT_PATHS.pages).toContain("scripts/fixtures/selector-editorial-examples.md");
    expect(VALIDATION_IMPACT_PATHS["validation-only"]).toContain(
      "worker/src/cron/reserve-adapters/__tests__/http-html-fixture-coverage.test.ts",
    );
  });

  it("runs the Pages phase successfully in registry order", async () => {
    const commands: string[] = [];
    const result = await runValidationPhase("pages", {
      log: () => {},
      logError: () => {},
      runCommand: async (command: string) => {
        commands.push(command);
        return 0;
      },
    });

    expect(getValidationPhaseCommands("pages")).toBe(PAGES_VALIDATE_COMMANDS);
    expect(commands).toEqual(PAGES_VALIDATE_COMMANDS);
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
  });

  it("preserves the Worker phase order", async () => {
    const commands: string[] = [];
    await runValidationPhase("worker", {
      log: () => {},
      logError: () => {},
      runCommand: async (command: string) => {
        commands.push(command);
        return { status: 0, aborted: false };
      },
    });

    expect(commands).toEqual(["npm run typecheck:worker"]);
  });

  it("fails fast when a phase command fails", async () => {
    const commands: string[] = [];
    const result = await runValidationPhase("pages", {
      log: () => {},
      logError: () => {},
      runCommand: async (command: string) => {
        commands.push(command);
        return command === PAGES_VALIDATE_COMMANDS[1] ? 7 : 0;
      },
    });

    expect(commands).toEqual(PAGES_VALIDATE_COMMANDS.slice(0, 2));
    expect(result).toEqual({ status: 7, failedCmd: PAGES_VALIDATE_COMMANDS[1], aborted: false });
  });

  it("rejects unknown validation phases", async () => {
    await expect(runValidationPhase("all", { log: () => {}, logError: () => {} })).rejects.toThrow(
      "Unknown validation phase: all. Expected pages or worker.",
    );
  });

  it("keeps generated artifacts as the sole terminal prebuild barrier", () => {
    const terminalLeaves = VALIDATION_LANES.flatMap((lane) => lane.leaves).filter(
      (leaf) => "terminal" in leaf && leaf.terminal,
    );
    expect(terminalLeaves).toEqual([
      expect.objectContaining({
        command: "npm run check:generated-artifacts",
        phase: "prebuild",
      }),
    ]);
  });

  it("rejects missing leaves, duplicate or gapped prebuild orders, invalid phases, and bad surfaces", () => {
    const missingLeaf = structuredClone(VALIDATION_LANES);
    missingLeaf[0].leaves.pop();
    expect(() => validateValidationLanes(missingLeaf)).toThrow("Expected exactly 58 unique validation leaves");

    const duplicateLane = structuredClone(VALIDATION_LANES);
    duplicateLane[1].id = duplicateLane[0].id;
    expect(() => validateValidationLanes(duplicateLane)).toThrow("Duplicate validation lane id");

    const duplicatePrebuildOrder = structuredClone(VALIDATION_LANES);
    duplicatePrebuildOrder[0].leaves[1].prebuildOrder = 5;
    expect(() => validateValidationLanes(duplicatePrebuildOrder)).toThrow(
      "prebuild orders must be unique and contiguous",
    );

    const gappedPrebuildOrder = structuredClone(VALIDATION_LANES);
    gappedPrebuildOrder[0].leaves[1].prebuildOrder = 50;
    expect(() => validateValidationLanes(gappedPrebuildOrder)).toThrow("prebuild orders must be unique and contiguous");

    const invalidPhase = structuredClone(VALIDATION_LANES);
    invalidPhase[0].leaves[0].phase = "unsupported";
    expect(() => validateValidationLanes(invalidPhase)).toThrow("Unknown validation phase");

    const emptySurface = structuredClone(VALIDATION_LANES);
    emptySurface[0].leaves[0].surfaces = [];
    expect(() => validateValidationLanes(emptySurface)).toThrow("Validation leaf must have at least one surface");

    const unknownSurface = structuredClone(VALIDATION_LANES);
    unknownSurface[0].leaves[0].surfaces = ["full", "unsupported"];
    expect(() => validateValidationLanes(unknownSurface)).toThrow("Unknown validation surface");

    const badTerminal = structuredClone(VALIDATION_LANES);
    const terminal = badTerminal.flatMap((lane) => lane.leaves).find((leaf) => "terminal" in leaf && leaf.terminal);
    if (!terminal) throw new Error("Missing terminal fixture leaf");
    terminal.phase = "manual-advisory";
    expect(() => validateValidationLanes(badTerminal)).toThrow("The terminal prebuild barrier");
  });
});
