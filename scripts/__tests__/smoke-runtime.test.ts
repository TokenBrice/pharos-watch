import { describe, expect, it } from "vitest";

import { parseBoolean, parseCliOptions, readCliValue } from "../lib/smoke-runtime.mjs";

describe("smoke-runtime CLI helpers", () => {
  it("parses boolean-ish env values with a fallback", () => {
    expect(parseBoolean("true", false)).toBe(true);
    expect(parseBoolean("0", true)).toBe(false);
    expect(parseBoolean("", true)).toBe(true);
  });

  it("dispatches value and flag options without hand-written loops", () => {
    const args = { timeoutMs: 100, verbose: false };

    parseCliOptions(["--timeout-ms", "250", "--verbose"], {
      "--timeout-ms": ({ readValue }) => {
        args.timeoutMs = Number(readValue());
        return "value";
      },
      "--verbose": () => {
        args.verbose = true;
      },
    });

    expect(args).toEqual({ timeoutMs: 250, verbose: true });
  });

  it("reports missing option values with the option name", () => {
    expect(() => readCliValue(["--url"], 0, "--url")).toThrow("--url requires a value");
  });
});
