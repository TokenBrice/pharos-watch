import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv as processArgv } from "node:process";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  CliUsageError,
  parseCliInteger,
  parseStrictCliArgs,
  requireCliString,
  runCliEntrypoint,
  runDirectCli,
  writeJsonOutput,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";

describe("strict operator CLI arguments", () => {
  it("parses declared options, aliases, and intentional repeats", () => {
    const parsed = parseStrictCliArgs(
      ["-h", "--url", "https://one.test", "--url=https://two.test"],
      {
        options: {
          url: { type: "string", multiple: true },
        },
      },
    );

    expect(parsed.values.help).toBe(true);
    expect(parsed.values.url).toEqual(["https://one.test", "https://two.test"]);
  });

  it.each([
    { argv: ["--unknown"], message: "Unknown option" },
    { argv: ["--name"], message: "argument missing" },
    { argv: ["--name", "one", "--name", "two"], message: "may only be specified once" },
    { argv: ["unexpected"], message: "Unexpected argument" },
  ])("rejects unsafe input: $message", ({ argv, message }) => {
    expect(() =>
      parseStrictCliArgs(argv, { options: { name: { type: "string" } } }),
    ).toThrow(message);
  });

  it("rejects declared option conflicts", () => {
    expect(() =>
      parseStrictCliArgs(["--check", "--dry-run"], {
        conflicts: [["check", "dry-run"]],
        options: {
          check: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
      }),
    ).toThrow("--check and --dry-run cannot be used together");
  });

  it("rejects empty inline string values", () => {
    expect(() =>
      parseStrictCliArgs(["--name="], { options: { name: { type: "string" } } }),
    ).toThrow("--name requires a non-empty value");
  });

  it("parses bounded integers without accepting numeric prefixes", () => {
    expect(parseCliInteger("12", { name: "--attempts", min: 1, max: 20 })).toBe(12);
    expect(() => parseCliInteger("12oops", { name: "--attempts", min: 1 })).toThrow(
      "--attempts must be an integer",
    );
    expect(() => parseCliInteger("0", { name: "--attempts", min: 1 })).toThrow(
      "--attempts must be between",
    );
  });

  it("writes help exactly once when requested", () => {
    const output = { write: vi.fn() };
    expect(writeCliHelpIfRequested({ help: true }, "Usage: tool", output)).toBe(true);
    expect(output.write).toHaveBeenCalledWith("Usage: tool\n");
    expect(writeCliHelpIfRequested({ help: false }, "Usage: tool", output)).toBe(false);
  });

  it.each([
    { value: undefined, name: "--output", message: "--output is required" },
    { value: "", name: "--output", message: "--output is required" },
    { value: "  ", name: "--output", message: "--output is required" },
  ])("rejects missing required string values: $value", ({ value, name, message }) => {
    expect(() => requireCliString(value, name)).toThrow(message);
  });

  it("writes JSON output into a missing parent directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-cli-args-"));
    try {
      const outputPath = join(root, "nested", "report.json");
      writeJsonOutput(outputPath, '{"ok":true}\n');
      expect(readFileSync(outputPath, "utf8")).toBe('{"ok":true}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "imported invocation", importMetaUrl: "file:///not-the-entrypoint.mjs", direct: false },
    {
      label: "direct invocation",
      importMetaUrl: pathToFileURL(processArgv[1]!).href,
      direct: true,
    },
  ])("only runs a $label", async ({ importMetaUrl, direct }) => {
    const action = vi.fn();
    const previousExitCode = process.exitCode;
    try {
      expect(runDirectCli(importMetaUrl, action)).toBe(direct);
      await Promise.resolve();
      expect(action).toHaveBeenCalledTimes(direct ? 1 : 0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    { label: "success", action: async () => undefined, expectedExitCode: 0 },
    { label: "usage failure", action: async () => { throw new CliUsageError("bad option"); }, expectedExitCode: 2 },
    { label: "runtime failure", action: async () => { throw new Error("network down"); }, expectedExitCode: 1 },
  ])("maps $label to exit code $expectedExitCode", async ({ action, expectedExitCode, label }) => {
    const previousExitCode = process.exitCode;
    const stderr = { write: vi.fn() };
    try {
      process.exitCode = 0;
      await runCliEntrypoint(action, { label: "tool", usage: "Usage: tool", stderr });
      expect(process.exitCode, label).toBe(expectedExitCode);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
