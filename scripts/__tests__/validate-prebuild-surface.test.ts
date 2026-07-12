import { describe, expect, it } from "vitest";
import {
  buildValidatePrebuildCommands,
  buildValidatePrebuildCommandsForSurface,
  parseValidatePrebuildSkipCommands,
  VALIDATE_PREBUILD_COMMANDS,
  VALIDATE_PREBUILD_SKIP_COMMANDS_ENV,
  VALIDATE_PREBUILD_SURFACE_ENV,
} from "../lib/validation-lanes.mjs";
import {
  buildValidatePrebuildExecutionUnits,
  printValidatePrebuildCommandPlan,
  runValidatePrebuild,
  splitGeneratedArtifactsCheckExecutionUnits,
} from "../maintenance/run-validate-prebuild.mjs";
import { testEnv } from "../test-utils/ci-script-test-helpers";

describe("validate:prebuild surface filtering", () => {
  it("keeps validation-only and full checks while skipping worker-only checks for pages-only hints", () => {
    const commands = buildValidatePrebuildCommandsForSurface("pages");

    expect(commands).toContain("npm run audit:deps");
    expect(commands).toContain("npm run audit:pricing-providers");
    expect(commands).toContain("npm run check:provider-resilience");
    expect(commands).toContain("npm run check:generated-artifacts");
    expect(commands).not.toContain("npm run check:dependency-coverage");
    expect(commands).not.toContain("npm run check:redemption-coverage-audit");
    expect(commands).not.toContain("npm run check:world-map");
    expect(commands).not.toContain("npm run check:migrations");
    expect(commands).not.toContain("npm run check:sql-safety");
  });

  it("keeps validation-only and full checks while skipping pages-only checks for worker-only hints", () => {
    const commands = buildValidatePrebuildCommandsForSurface("worker");

    expect(commands).toContain("npm run audit:deps");
    expect(commands).toContain("npm run audit:pricing-providers");
    expect(commands).toContain("npm run check:provider-resilience");
    expect(commands).toContain("npm run check:migrations");
    expect(commands).toContain("npm run check:sql-safety");
    expect(commands).not.toContain("npm run check:dependency-coverage");
    expect(commands).not.toContain("npm run check:redemption-coverage-audit");
    expect(commands).not.toContain("npm run check:generated-artifacts");
    expect(commands).not.toContain("npm run check:world-map");
  });

  it("keeps the full prebuild set when the hint is full or absent", () => {
    expect(buildValidatePrebuildCommandsForSurface("full")).toEqual(VALIDATE_PREBUILD_COMMANDS);
    expect(buildValidatePrebuildCommandsForSurface(undefined)).toEqual(VALIDATE_PREBUILD_COMMANDS);
  });

  it("removes caller-skipped commands after surface filtering", () => {
    expect(parseValidatePrebuildSkipCommands("npm run audit:deps, npm run audit:pricing-providers")).toEqual([
      "npm run audit:deps",
      "npm run audit:pricing-providers",
    ]);

    const commands = buildValidatePrebuildCommands({
      surface: "full",
      skipCommands: ["npm run audit:deps", "npm run audit:pricing-providers"],
    });

    expect(commands).not.toContain("npm run audit:deps");
    expect(commands).not.toContain("npm run audit:pricing-providers");
    expect(commands).toContain("npm run typecheck:tests");
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
      `[validate:prebuild] Surface hint: worker; dry-run plan has ${expectedCommands.length} prebuild command(s).`,
      "[validate:prebuild] Command plan:",
      ...expectedCommands.map((cmd, index) => `${index + 1}. ${cmd}`),
      "[validate:prebuild] Dry run enabled; commands not executed.",
    ]);
  });

  it("prints caller-skipped commands in dry-run plans", async () => {
    const logs: string[] = [];
    let executed = false;

    const result = await runValidatePrebuild({
      argv: ["--dry-run"],
      env: testEnv({
        [VALIDATE_PREBUILD_SKIP_COMMANDS_ENV]: "npm run typecheck:tests",
      }),
      log: (line) => logs.push(line),
      runExecutionUnits: () => {
        executed = true;
        throw new Error("dry-run must not execute");
      },
    });

    const expectedCommands = buildValidatePrebuildCommands({
      surface: "full",
      skipCommands: ["npm run typecheck:tests"],
    });
    expect(result).toEqual({ status: 0, failedCmd: null, aborted: false });
    expect(executed).toBe(false);
    expect(logs).toEqual([
      `[validate:prebuild] Surface hint: full; dry-run plan has ${expectedCommands.length} prebuild command(s).`,
      "[validate:prebuild] Skipped by caller: npm run typecheck:tests",
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
      env: testEnv({
        [VALIDATE_PREBUILD_SURFACE_ENV]: "pages",
        VALIDATE_PREBUILD_CONTINUE_ON_ERROR: "1",
      }),
      runExecutionUnits: (units, options) => {
        calls.push({ units, options });
        return Promise.resolve({ status: 0, failedCmd: null, aborted: false });
      },
    });

    const expectedCommands = buildValidatePrebuildCommandsForSurface("pages");
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
