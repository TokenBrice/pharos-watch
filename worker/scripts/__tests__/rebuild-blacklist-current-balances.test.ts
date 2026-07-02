import { describe, expect, it } from "vitest";
import { parseArgs } from "../rebuild-blacklist-current-balances";

describe("rebuild blacklist current balances script args", () => {
  it("parses numeric flags as positive integers", () => {
    expect(parseArgs(["--concurrency", "4", "--requests-per-second", "3"])).toMatchObject({
      concurrency: 4,
      requestsPerSecond: 3,
    });
    expect(parseArgs(["--concurrency=5", "--requests-per-second=6"])).toMatchObject({
      concurrency: 5,
      requestsPerSecond: 6,
    });
  });

  it.each([
    ["--concurrency", "NaN"],
    ["--concurrency", "0"],
    ["--concurrency", "1.5"],
    ["--requests-per-second", "NaN"],
    ["--requests-per-second", "0"],
    ["--requests-per-second", "1.5"],
  ])("rejects invalid numeric flag %s %s", (flag, value) => {
    expect(() => parseArgs([flag, value])).toThrow(`${flag} must be a positive integer`);
  });

  it("rejects missing numeric flag values", () => {
    expect(() => parseArgs(["--concurrency"])).toThrow("--concurrency requires a value");
    expect(() => parseArgs(["--requests-per-second"])).toThrow("--requests-per-second requires a value");
  });
});
