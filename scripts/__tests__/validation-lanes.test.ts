import { describe, expect, it } from "vitest";
import {
  ALL_VALIDATE_PREBUILD_COMMANDS,
  buildNoncriticalTestShardCommands,
  buildValidatePrebuildCommands,
  buildValidatePrebuildLeaves,
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
  "npm run lint",
  "npm run lint:typed",
  "npm run typecheck",
  "npm run typecheck:tests",
  "npm run check:client-registry-imports",
  "npm run check:cron-connections",
  "npm run check:cron-sync",
  "npm run check:worker-config",
  "npm run check:env-contract",
  "npm run check:generated-artifacts",
  "npm run check:migrations",
  "npm run check:site-csp-sync",
  "npm run check:shared-types-imports",
  "npm run check:sql-safety",
  "npm run check:stablecoin-data",
  "npm run check:worker-boundary",
];

describe("validation lane authority", () => {
  it("assigns descriptor commands to unique semantic lanes", () => {
    validateValidationLanes();
    expect(new Set(VALIDATION_LANES.map((lane) => lane.id)).size).toBe(VALIDATION_LANES.length);
    expect(VALIDATION_LANES.map((lane) => lane.id)).toEqual(
      expect.arrayContaining([
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
      ]),
    );

    const commands = VALIDATION_LANES.flatMap((lane) => lane.leaves).map((leaf) => leaf.command);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("keeps blocking prebuild focused while preserving full advisory opt-in", () => {
    expect(VALIDATE_PREBUILD_COMMANDS).toEqual(EXPECTED_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands()).toEqual(EXPECTED_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands({ surface: "full" })).toEqual(EXPECTED_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommands({ surface: "full" })).toHaveLength(16);
    expect(buildValidatePrebuildCommands({ surface: "pages" })).toHaveLength(10);
    expect(buildValidatePrebuildCommands({ surface: "worker" })).toHaveLength(12);
    expect(buildValidatePrebuildCommands({ surface: "pages" })).not.toContain("npm run check:cron-connections");
    expect(buildValidatePrebuildCommands({ surface: "pages" })).not.toContain("npm run check:worker-boundary");
    expect(buildValidatePrebuildCommands({ surface: "worker" })).not.toContain("npm run check:site-csp-sync");
    expect(buildValidatePrebuildCommands({ surface: "worker" })).not.toContain("npm run check:stablecoin-data");
    expect(buildValidatePrebuildCommands({ surface: "pages" })).not.toContain("npm run check:dependency-coverage");
    expect(buildValidatePrebuildCommands({ surface: "worker" })).not.toContain("npm run check:dependency-coverage");
    expect(buildValidatePrebuildCommands({ surface: "pages" })).not.toContain("npm run check:migrations");
    expect(buildValidatePrebuildCommands({ surface: "worker" })).not.toContain("npm run check:generated-artifacts");
    expect(buildValidatePrebuildCommands({ surface: "pages", includeAdvisory: true })).toContain(
      "npm run check:dependency-coverage",
    );
    expect(buildValidatePrebuildCommands({ surface: "worker", includeAdvisory: true })).toContain(
      "npm run check:fetch-body-timeouts",
    );
    expect(ALL_VALIDATE_PREBUILD_COMMANDS).toHaveLength(41);

    const skipCommands = ["npm run audit:deps", "npm run check:generated-artifacts"];
    expect(buildValidatePrebuildCommands({ surface: "pages", skipCommands, includeAdvisory: true })).not.toEqual(
      buildValidatePrebuildCommands({ surface: "pages", includeAdvisory: true }),
    );
    expect(buildValidatePrebuildCommands({ surface: "pages", skipCommands, includeAdvisory: true })).not.toContain(
      "npm run audit:deps",
    );
  });

  it("exposes compound wrappers as stable atomic discovery leaves", () => {
    const leaves = buildValidatePrebuildLeaves({ includeAdvisory: true });
    const lintLeaf = leaves.find((leaf) => leaf.command === "npm run lint");
    const agentLeaf = leaves.find((leaf) => leaf.command === "npm run check:agent-skill-symlinks");
    expect(lintLeaf && "discoveryCommands" in lintLeaf ? lintLeaf.discoveryCommands : undefined).toEqual([
      { command: "npm run check:table-primitives", id: "prebuild:table-primitives" },
      { command: "npm run lint:eslint", id: "prebuild:eslint" },
    ]);
    expect(agentLeaf && "discoveryCommands" in agentLeaf ? agentLeaf.discoveryCommands : undefined).toEqual([
      { command: "npm run check:agent-skill-symlinks:only", id: "prebuild:agent-skill-symlinks" },
      { command: "npm run check:agent-infra", id: "prebuild:agent-infra" },
    ]);
  });

  it("keeps Pages, postbuild, Worker, smoke, and shard plans exact", () => {
    expect(PAGES_VALIDATE_COMMANDS).toEqual([
      "npm run build",
      "npm run check:feature-flag-inlining",
      "npm run seo:check",
      "npm run check:phishing-signatures",
      "npm run check:classifier-sensitive-copy",
    ]);
    expect(COMMON_VALIDATE_POSTBUILD_COMMANDS).toEqual([
      "npm run test:noncritical -- --shard=1/2",
      "npm run test:noncritical -- --shard=2/2",
    ]);
    expect(WORKER_VALIDATE_COMMANDS).toEqual(["npm run typecheck:worker"]);
    expect(CRITICAL_TEST_FILES).toContain(WORKER_SCHEDULED_TEST);
    expect(WORKER_VALIDATE_COMMANDS).not.toContain("npm run validate:worker-scheduled-smoke");
    expect(PAGES_SMOKE_VALIDATE_COMMANDS).toEqual(["npm run validate:pages-smoke"]);
    expect(WORKER_SMOKE_VALIDATE_COMMANDS).toEqual(["npm run validate:worker-smoke"]);
    expect(buildNoncriticalTestShardCommands()).toEqual(COMMON_VALIDATE_POSTBUILD_COMMANDS.slice(0, 2));
  });

  it("keeps lane-owned impact path buckets", () => {
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

  it("prints a Pages phase dry-run plan without executing commands", async () => {
    const logs: string[] = [];
    let executed = false;
    const result = await runValidationPhase("pages", {
      argv: ["--dry-run"],
      log: (line: string) => logs.push(line),
      logError: () => {},
      runCommand: async () => {
        executed = true;
        return 1;
      },
    });

    expect(executed).toBe(false);
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(logs).toEqual([
      `[validate:pages] Dry run enabled; ${PAGES_VALIDATE_COMMANDS.length} command(s) will not execute.`,
      "[validate:pages] Command plan:",
      ...PAGES_VALIDATE_COMMANDS.map((command, index) => `${index + 1}. ${command}`),
    ]);
  });

  it("prints validation phase help without executing commands", async () => {
    const logs: string[] = [];
    let executed = false;
    const result = await runValidationPhase("pages", {
      argv: ["--help"],
      log: (line: string) => logs.push(line),
      logError: () => {},
      runCommand: async () => {
        executed = true;
        return 1;
      },
    });

    expect(executed).toBe(false);
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(logs).toContain("Usage: npm run validate:<phase> -- [--dry-run|--help]");
    expect(logs).toContain("Supported phases: pages, worker");
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

  it("rejects duplicate commands, duplicate orders, invalid phases, and bad surfaces", () => {
    const duplicateLane = structuredClone(VALIDATION_LANES);
    duplicateLane[1].id = duplicateLane[0].id;
    expect(() => validateValidationLanes(duplicateLane)).toThrow("Duplicate validation lane id");

    const duplicateCommand = structuredClone(VALIDATION_LANES);
    duplicateCommand[0].leaves[1].command = duplicateCommand[0].leaves[0].command;
    expect(() => validateValidationLanes(duplicateCommand)).toThrow("Duplicate validation lane command");

    const duplicatePrebuildOrder = structuredClone(VALIDATION_LANES);
    duplicatePrebuildOrder[0].leaves[1].prebuildOrder = 5;
    expect(() => validateValidationLanes(duplicatePrebuildOrder)).toThrow("prebuild orders must be unique");

    const invalidPrebuildOrder = structuredClone(VALIDATION_LANES);
    invalidPrebuildOrder[0].leaves[1].prebuildOrder = 0;
    expect(() => validateValidationLanes(invalidPrebuildOrder)).toThrow("prebuild orders must be positive integers");

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
