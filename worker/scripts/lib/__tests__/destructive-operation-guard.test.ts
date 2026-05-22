import { describe, expect, it } from "vitest";
import { parseDestructiveOperationMode } from "../destructive-operation-guard";

describe("parseDestructiveOperationMode", () => {
  it("defaults to local dry-run mode", () => {
    expect(parseDestructiveOperationMode({ argv: [], scriptName: "repair" })).toEqual({
      dryRun: true,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("requires execute and script confirmation for live mode", () => {
    expect(() => parseDestructiveOperationMode({ argv: ["--execute"], scriptName: "repair" })).toThrow(
      "live mutation requires --execute --confirm repair",
    );

    expect(
      parseDestructiveOperationMode({
        argv: ["--execute", "--confirm", "repair"],
        scriptName: "repair",
      }),
    ).toEqual({
      dryRun: false,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("supports compatibility execute aliases without skipping confirmation", () => {
    expect(() =>
      parseDestructiveOperationMode({
        argv: ["--apply"],
        executeAliases: ["--apply"],
        scriptName: "repair",
      }),
    ).toThrow("live mutation requires --execute (or --apply) --confirm repair");

    expect(
      parseDestructiveOperationMode({
        argv: ["--apply", "--confirm", "repair"],
        executeAliases: ["--apply"],
        scriptName: "repair",
      }),
    ).toEqual({
      dryRun: false,
      remote: false,
      targetFlag: "--local",
    });
  });

  it("supports remote-only operations with remote as the default target", () => {
    expect(
      parseDestructiveOperationMode({
        argv: [],
        defaultTarget: "--remote",
        localAllowed: false,
        scriptName: "repair",
      }),
    ).toEqual({
      dryRun: true,
      remote: true,
      targetFlag: "--remote",
    });

    expect(() =>
      parseDestructiveOperationMode({
        argv: ["--local"],
        defaultTarget: "--remote",
        localAllowed: false,
        scriptName: "repair",
      }),
    ).toThrow("--local is not supported");
  });

  it("allows explicit remote targeting without changing dry-run default", () => {
    expect(parseDestructiveOperationMode({ argv: ["--remote"], scriptName: "repair" })).toEqual({
      dryRun: true,
      remote: true,
      targetFlag: "--remote",
    });
  });

  it("rejects contradictory mode flags", () => {
    expect(() =>
      parseDestructiveOperationMode({
        argv: ["--execute", "--dry-run", "--confirm", "repair"],
        scriptName: "repair",
      }),
    ).toThrow("--execute and --dry-run are mutually exclusive");

    expect(() => parseDestructiveOperationMode({ argv: ["--local", "--remote"], scriptName: "repair" })).toThrow(
      "--local and --remote are mutually exclusive",
    );
  });
});
