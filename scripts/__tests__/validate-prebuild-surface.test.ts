import { describe, expect, it } from "vitest";
import {
  buildValidatePrebuildCommands,
  buildValidatePrebuildCommandsForSurface,
  buildValidatePrebuildCommandsForSurfaceAndTier,
  parseValidatePrebuildSkipCommands,
  resolveValidatePrebuildTier,
  VALIDATE_PREBUILD_COMMANDS,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
  VALIDATE_PREBUILD_TIER_ENV,
} from "../lib/validate-contract.mjs";
import {
  buildValidatePrebuildExecutionUnits,
  printValidatePrebuildCommandPlan,
  runValidatePrebuild,
  splitGeneratedArtifactsCheckExecutionUnits,
} from "../maintenance/run-validate-prebuild.mjs";

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
      "npm run typecheck:tests",
      "npm run check:client-registry-imports",
      "npm run check:cli-args-policy",
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

  it("removes caller-skipped commands after surface and tier filtering", () => {
    expect(parseValidatePrebuildSkipCommands("npm run audit:deps, npm run audit:pricing-providers")).toEqual([
      "npm run audit:deps",
      "npm run audit:pricing-providers",
    ]);

    const commands = buildValidatePrebuildCommands({
      surface: "full",
      tier: "full",
      skipCommands: ["npm run audit:deps", "npm run audit:pricing-providers"],
    });

    expect(commands).not.toContain("npm run audit:deps");
    expect(commands).not.toContain("npm run audit:pricing-providers");
    expect(commands).toContain("npm run typecheck:tests");
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
        [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: "npm run typecheck:tests",
      },
      log: (line) => logs.push(line),
      runExecutionUnits: () => {
        executed = true;
        throw new Error("dry-run must not execute");
      },
    });

    const expectedCommands = buildValidatePrebuildCommands({
      surface: "full",
      tier: "blocking",
      skipCommands: ["npm run typecheck:tests"],
    });
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(executed).toBe(false);
    expect(logs).toEqual([
      `[validate:prebuild] Surface hint: full; tier: blocking; dry-run plan has ${expectedCommands.length} prebuild command(s).`,
      "[validate:prebuild] Skipped by caller: npm run typecheck:tests",
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
    const calls: Array<{
      units: Array<{ commands: string[] }>;
      options?: { continueOnError?: boolean; label?: string; maxParallel?: number };
    }> = [];

    await runValidatePrebuild({
      argv: [],
      env: {},
      log: () => {},
      runExecutionUnits: (units, options) => {
        calls.push({ units, options });
        return Promise.resolve({ status: 0, failedCmd: null, aborted: false });
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].units.map((unit) => unit.commands[0])).toEqual(
      VALIDATE_PREBUILD_COMMANDS.filter((cmd) => cmd !== "npm run check:generated-artifacts"),
    );
    expect(calls[0].options).toMatchObject({
      continueOnError: false,
      label: "validate:prebuild",
      maxParallel: 8,
    });
    expect(calls[1].units.map((unit) => unit.commands[0])).toEqual(["npm run check:generated-artifacts"]);
    expect(calls[1].options).toMatchObject({
      continueOnError: false,
      label: "validate:prebuild",
      maxParallel: 1,
    });
  });

  it("passes filtered runner units and continue-on-error through the prebuild runner", async () => {
    const calls: Array<{
      units: Array<{ commands: string[] }>;
      options?: { continueOnError?: boolean; label?: string; maxParallel?: number };
    }> = [];

    await runValidatePrebuild({
      argv: [],
      env: {
        [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
        [VALIDATE_PREBUILD_TIER_ENV]: "surface",
        VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
      },
      runExecutionUnits: (units, options) => {
        calls.push({ units, options });
        return Promise.resolve({ status: 0, failedCmd: null, aborted: false });
      },
    });

    const expectedCommands = buildValidatePrebuildCommandsForSurfaceAndTier("pages", "surface");
    expect(calls).toHaveLength(2);
    expect(calls[0].units.map((unit) => unit.commands[0])).toEqual(
      expectedCommands.filter((cmd) => cmd !== "npm run check:generated-artifacts"),
    );
    expect(calls[0].options).toMatchObject({
      continueOnError: true,
      label: "validate:prebuild",
    });
    expect(calls[1].units.map((unit) => unit.commands[0])).toEqual(["npm run check:generated-artifacts"]);
    expect(calls[1].options).toMatchObject({
      continueOnError: true,
      label: "validate:prebuild",
      maxParallel: 1,
    });
  });

  it("splits generated artifact checks into a serial trailing phase", () => {
    const units = [
      { commands: ["npm run typecheck"] },
      { commands: ["npm run check:generated-artifacts"] },
      { commands: ["npm run lint"] },
    ];

    expect(splitGeneratedArtifactsCheckExecutionUnits(units)).toEqual({
      leadingUnits: [{ commands: ["npm run typecheck"] }, { commands: ["npm run lint"] }],
      generatedArtifactUnits: [{ commands: ["npm run check:generated-artifacts"] }],
    });
  });
});
