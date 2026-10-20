import { describe, expect, it } from "vitest";
import { parseDestructiveOperationArgs } from "../destructive-operation-guard";

describe("parseDestructiveOperationArgs", () => {
  it("defaults to local dry-run mode", () => {
    expect(parseDestructiveOperationArgs({ argv: [], scriptName: "repair" }).mode).toEqual({
      dryRun: true,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("requires execute and script confirmation for live mode", () => {
    expect(() => parseDestructiveOperationArgs({ argv: ["--execute"], scriptName: "repair" }).mode).toThrow(
      "live mutation requires --execute --confirm repair",
    );

    expect(
      parseDestructiveOperationArgs({
        argv: ["--execute", "--confirm", "repair"],
        scriptName: "repair",
      }).mode,
    ).toEqual({
      dryRun: false,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("rejects confirmation naming another script", () => {
    expect(() => parseDestructiveOperationArgs({
      argv: ["--execute", "--confirm", "another-script"],
      scriptName: "repair",
    }).mode).toThrow("live mutation requires --execute --confirm repair");
  });

  it("allows a custom dry-run condition without bypassing confirmation when false", () => {
    const options = {
      scriptName: "repair",
      cliOptions: { preview: { type: "boolean" as const } },
      executeAsDryRunWhen: (values: Record<string, unknown>) => values.preview === true,
    };
    expect(parseDestructiveOperationArgs({
      ...options, argv: ["--execute", "--preview"],
    }).mode.dryRun).toBe(true);
    expect(() => parseDestructiveOperationArgs({
      ...options, argv: ["--execute"],
    }).mode).toThrow("live mutation requires --execute --confirm repair");
    expect(parseDestructiveOperationArgs({
      ...options, argv: ["--execute", "--confirm", "repair"],
    }).mode.dryRun).toBe(false);
  });

  it("never authorizes mutation on the configured help path", () => {
    expect(parseDestructiveOperationArgs({
      argv: ["--execute", "--help", "--remote"],
      cliOptions: { help: { type: "boolean" } },
      scriptName: "repair",
    }).mode).toEqual({ dryRun: true, remote: true, targetFlag: "--remote" });
  });

  it("supports compatibility execute aliases without skipping confirmation", () => {
    expect(() =>
      parseDestructiveOperationArgs({
        argv: ["--apply"],
        executeAliases: ["--apply"],
        scriptName: "repair",
      }).mode,
    ).toThrow("live mutation requires --execute (or --apply) --confirm repair");

    expect(
      parseDestructiveOperationArgs({
        argv: ["--apply", "--confirm", "repair"],
        executeAliases: ["--apply"],
        scriptName: "repair",
      }).mode,
    ).toEqual({
      dryRun: false,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("supports remote-only operations with remote as the default target", () => {
    expect(
      parseDestructiveOperationArgs({
        argv: [],
        defaultTarget: "--remote",
        localAllowed: false,
        scriptName: "repair",
      }).mode,
    ).toEqual({
      dryRun: true,
      remote: true,
      targetFlag: "--remote",
    });

    expect(() =>
      parseDestructiveOperationArgs({
        argv: ["--local"],
        defaultTarget: "--remote",
        localAllowed: false,
        scriptName: "repair",
      }).mode,
    ).toThrow("--local is not supported");
  });

  it("allows explicit remote targeting without changing dry-run default", () => {
    expect(parseDestructiveOperationArgs({ argv: ["--remote"], scriptName: "repair" }).mode).toEqual({
      dryRun: true,
      remote: true,
      targetFlag: "--remote",
    });
  });

  it("rejects contradictory mode flags", () => {
    expect(() =>
      parseDestructiveOperationArgs({
        argv: ["--execute", "--dry-run", "--confirm", "repair"],
        scriptName: "repair",
      }).mode,
    ).toThrow("--execute and --dry-run are mutually exclusive");

    expect(() => parseDestructiveOperationArgs({ argv: ["--local", "--remote"], scriptName: "repair" }).mode).toThrow(
      "--local and --remote are mutually exclusive",
    );
  });
});
