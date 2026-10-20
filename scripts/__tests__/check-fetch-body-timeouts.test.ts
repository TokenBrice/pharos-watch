import { describe, expect, it, vi } from "vitest";

import {
  findFetchBodyTimeoutViolations,
  main,
  scanFetchBodyTimeouts,
} from "../ci/check-fetch-body-timeouts.ts";
import { withTempRepo } from "./helpers/test-state";

describe("fetch body timeout guardrail", () => {
  it.each(["json", "text"])("detects %s body reads beyond 80 source lines", (method) => {
    const violations = findFetchBodyTimeoutViolations([
      "async function run() {",
      "  const res = await fetchWithRetry(url);",
      ...Array.from({ length: 81 }, () => "  // unrelated processing"),
      `  return res.${method}();`,
      "}",
    ].join("\n"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ variable: "res", method, fetchLine: 2, bodyLine: 84 });
  });

  it("detects qualified and aliased fetchWithRetry calls", () => {
    const violations = findFetchBodyTimeoutViolations(`
      export async function run(dependencies) {
        const retryFetch = fetchWithRetry;
        const first = await dependencies.fetchWithRetry("https://example.test/first");
        const second = await retryFetch("https://example.test/second");
        await first.text();
        return await second.json();
      }
    `);

    expect(violations.map((violation) => violation.variable)).toEqual(["first", "second"]);
    expect(violations.map((violation) => violation.method)).toEqual(["text", "json"]);
  });

  it("detects later same-line body reads after unrelated json/text calls", () => {
    const violations = findFetchBodyTimeoutViolations(`
      import { fetchWithRetry } from "../lib/fetch-retry";
      export async function run(cache) {
        const res = await fetchWithRetry("https://example.test");
        return cache.json(await res.text());
      }
    `);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      variable: "res",
      method: "text",
      fetchLine: 4,
      bodyLine: 5,
    });
  });

  it("detects body reads from destructured Promise.all fetchWithRetry responses", () => {
    const violations = findFetchBodyTimeoutViolations(`
      import { fetchWithRetry } from "../lib/fetch-retry";
      export async function run() {
        const [marketChartRes, coinRes] = await Promise.all([
          fetchWithRetry("https://example.test/market"),
          dependencies.fetchWithRetry("https://example.test/coin"),
        ]);
        if (!marketChartRes?.ok) return null;
        await marketChartRes.json();
        return coinRes ? await coinRes.text() : null;
      }
    `);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.variable)).toEqual(["marketChartRes", "coinRes"]);
    expect(violations.map((violation) => violation.method)).toEqual(["json", "text"]);
  });

  it("preserves omitted Promise.all slots", () => {
    const violations = findFetchBodyTimeoutViolations(`
      async function run() {
        const [, res] = await Promise.all([other(), fetchWithRetry(url)]);
        return res.json();
      }
    `);
    expect(violations.map(({ variable, method }) => ({ variable, method }))).toEqual([
      { variable: "res", method: "json" },
    ]);
  });

  it.each(["json", "text"])("detects %s reads through copied and reassigned alias chains", (method) => {
    const violations = findFetchBodyTimeoutViolations([
      "async function run() {",
      "  let res = await fetchWithRetry(url);",
      "  const copy = res;",
      "  let chain; chain = copy; chain = chain;",
      "  res = otherResponse;",
      `  await copy.${method}();`,
      `  await chain.${method}();`,
      "  chain = otherResponse;",
      `  await chain.${method}();`,
      `  await res.${method}();`,
      `  { const copy = otherResponse; await copy.${method}(); }`,
      "}",
    ].join("\n"));
    expect(violations.map(({ variable, fetchLine, bodyLine }) => ({ variable, fetchLine, bodyLine }))).toEqual([
      { variable: "copy", fetchLine: 2, bodyLine: 6 },
      { variable: "chain", fetchLine: 2, bodyLine: 7 },
    ]);
  });

  it("reports every raw body read without a debt allowlist", () => {
    withTempRepo("pharos-fetch-body-timeouts", {
      "worker/src/cron/provider.ts": `
        import { fetchWithRetry } from "../lib/fetch-retry";
        export async function run() {
          const res = await fetchWithRetry("https://example.test");
          if (!res?.ok) return null;
          return await res.text();
        }
      `,
    }, (cwd) => {
      expect(scanFetchBodyTimeouts({ cwd })).toEqual([
        expect.objectContaining({
          file: "worker/src/cron/provider.ts",
          variable: "res",
          method: "text",
        }),
      ]);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(main()).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("worker/src/cron/provider.ts:6 res.text() after fetchWithRetry at line 4"),
        );
      } finally {
        cwdSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  it("passes when response bodies use the timeout-safe helpers", () => {
    withTempRepo("pharos-fetch-body-timeouts", {
      "worker/src/cron/provider.ts": "export async function run() { return fetchJsonWithRetry(url); }",
    }, (cwd) => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(scanFetchBodyTimeouts({ cwd })).toEqual([]);
        expect(main()).toBe(0);
        expect(logSpy).toHaveBeenCalledWith("Fetch body timeout check passed (no raw body reads after fetchWithRetry).");
      } finally {
        cwdSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  });
});
