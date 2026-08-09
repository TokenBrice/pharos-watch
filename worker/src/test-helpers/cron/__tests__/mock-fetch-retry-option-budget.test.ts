import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `mockFetchRetry` derives one shared stub for seven suites, and each behaviour
 * knob it grows is a boolean the call sites have to reason about. Four is the
 * agreed ceiling: at a fifth, split the helper into two named factories
 * (`mockFetchRetryPassthrough` / `mockFetchRetryOverBase`) instead of adding
 * another flag.
 */
const OPTION_BUDGET = 4;

const SOURCE = readFileSync(
  path.resolve("worker/src/test-helpers/cron/mock-fetch-retry.ts"),
  "utf8",
);

describe("MockFetchRetryOptions budget", () => {
  it("keeps the option surface at or below the agreed ceiling", () => {
    const interfaceStart = SOURCE.indexOf("export interface MockFetchRetryOptions {");
    expect(interfaceStart).toBeGreaterThanOrEqual(0);
    const body = SOURCE.slice(interfaceStart, SOURCE.indexOf("\n}", interfaceStart));
    const options = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);

    expect(options.length).toBeLessThanOrEqual(OPTION_BUDGET);
  });
});
