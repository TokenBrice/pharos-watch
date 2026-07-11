import { describe, expect, it, vi } from "vitest";

import {
  CliUsageError,
  parseCliInteger,
  parseStrictCliArgs,
  runCliEntrypoint,
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
  });

  it("maps usage and runtime failures to distinct exit codes", async () => {
    const previousExitCode = process.exitCode;
    const stderr = { write: vi.fn() };
    try {
      await runCliEntrypoint(
        async () => {
          throw new CliUsageError("bad option");
        },
        { label: "tool", usage: "Usage: tool", stderr },
      );
      expect(process.exitCode).toBe(2);
      expect(stderr.write).toHaveBeenCalledWith("tool: bad option\n");

      await runCliEntrypoint(
        async () => {
          throw new Error("network down");
        },
        { label: "tool", usage: "Usage: tool", stderr },
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
