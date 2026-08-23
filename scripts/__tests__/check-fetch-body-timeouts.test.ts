import { describe, expect, it } from "vitest";

import {
  findFetchBodyTimeoutViolations,
  makeViolationKey,
  scanFetchBodyTimeouts,
} from "../ci/check-fetch-body-timeouts.ts";
import { withTempRepo } from "./helpers/test-state";

describe("fetch body timeout guardrail", () => {
  it("detects direct body reads after raw fetchWithRetry responses", () => {
    const violations = findFetchBodyTimeoutViolations(`
      import { fetchWithRetry } from "../lib/fetch-retry";
      export async function run() {
        const res = await fetchWithRetry("https://example.test");
        if (!res?.ok) return null;
        return await res.json();
      }
    `);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      variable: "res",
      method: "json",
      fetchLine: 4,
      bodyLine: 6,
    });
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

  it("allows explicitly baselined debt and reports stale baseline entries", () => {
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
      const initial = scanFetchBodyTimeouts({ cwd, knownDebt: new Set() });
      expect(initial.unexpected).toHaveLength(1);

      const knownDebt = new Set([makeViolationKey(initial.unexpected[0]!)]);
      const accepted = scanFetchBodyTimeouts({ cwd, knownDebt });
      expect(accepted.unexpected).toEqual([]);
      expect(accepted.staleDebt).toEqual([]);

      const stale = scanFetchBodyTimeouts({ cwd, knownDebt: new Set(["missing::baseline::entry"]) });
      expect(stale.unexpected).toHaveLength(1);
      expect(stale.staleDebt).toEqual(["missing::baseline::entry"]);
    });
  });
});
