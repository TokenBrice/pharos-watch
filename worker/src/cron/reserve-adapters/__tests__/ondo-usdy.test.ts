import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ReserveAdapterCoin } from "@shared/types/core";
import { TRACKED_SOURCE_COINS } from "@shared/lib/stablecoins/registry";
import reserves from "@shared/data/stablecoins/domains/reserves/usdy-ondo-finance.json";
import { adaptOndoUsdyPortfolio, fetchOndoUsdyReserves } from "../ondo-usdy";
import { fetchTextWithRetry } from "../helpers";
import { extractEscapedJsonValueAfterKey } from "../html";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

vi.mock("../helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("../helpers")>(),
  fetchTextWithRetry: vi.fn(),
}));

const html = readFileSync(new URL("./fixtures/ondo-usdy-portfolio.html", import.meta.url), "utf8");
const coin: ReserveAdapterCoin = TRACKED_SOURCE_COINS.find((entry) => entry.id === "usdy-ondo-finance")!;
const config = coin.liveReservesConfig!;
const NOW = Date.parse("2026-10-25T12:00:00Z") / 1000;
const adapt = (source = html) => adaptOndoUsdyPortfolio(source, coin, NOW);

describe("Ondo USDY dated portfolio categories", () => {
  it("reconciles four fund-level slices and preserves reviewed identities/classifications", () => {
    const result = adapt();
    const values = [2094366235.88, 309364703.11, 599553.01, 10820.67];
    expect(result.slices).toEqual(reserves.reserves.map((slice, index) => ({
      ...slice, pct: values[index] / 2404341312.6700006 * 100,
    })));
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.parse("2026-10-22T00:00:00Z") / 1000,
      totalReserveUsd: 2404341312.6700006,
      unknownExposurePct: values[3] / 2404341312.6700006 * 100,
      details: { sourceClockPolicy: "date-only-utc-start", sourceAgeBudgetSec: 604800, sourceAgeBudgetCap: "adapter" },
    });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("reportedCollateralizationRatio");
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.slices.every((slice) => slice.maturityDaysMax === undefined)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter(config.adapter)!, now: NOW }).valid).toBe(true);
  });

  it.each([
    ["missing payload", html.replaceAll('\\"portfolio\\"', '\\"absent\\"')],
    ["ambiguous payload", html + html],
    ["malformed JSON", html.replace('2094366235.88', 'invalid')],
    ["wrong product", html.replaceAll('usdyPortfolioHolding', 'ousgPortfolioHolding')],
    ["unreviewed category", html.replace('8a072b79-7c71-472b-8093-0a9c3347fb8f', 'unknown')],
    ["duplicate category", html.replace('58033c63-82e8-413d-a5f4-48b2aacc88ab', '8a072b79-7c71-472b-8093-0a9c3347fb8f')],
    ["changed category name", html.replace('US Treasuries', 'Other Securities')],
    ["negative amount", html.replace('2094366235.88', '-2094366235.88')],
    ["unavailable amount", html.replace('2094366235.88', 'null')],
    ["nonfinite amount", html.replace('2094366235.88', '1e999')],
    ["zero total", html.replace('2404341312.6700006', '0')],
    ["unreconciled total", html.replace('2404341312.6700006', '2404341313.67')],
    ["stale date", html.replace('2026-10-22', '2026-10-17')],
    ["future date", html.replace('2026-10-22', '2026-10-26')],
    ["invalid calendar date", html.replace('2026-10-22', '2026-02-30')],
    ["missing date", html.replace('2026-10-22', '')],
    ["oversized", ' '.repeat(2_000_001)],
  ])("fails closed for %s", (_label, source) => {
    expect(() => adapt(source)).toThrow();
  });

  it("rejects missing categories and missing or duplicate reviewed keys", () => {
    const portfolio = JSON.parse(extractEscapedJsonValueAfterKey(html, '\\"portfolio\\":', "test"));
    portfolio.positions.pop();
    const source = JSON.stringify({ portfolio }).replaceAll('"', '\\"');
    expect(() => adapt(source)).toThrow();
    expect(() => adaptOndoUsdyPortfolio(html, { ...coin, reserves: [] }, NOW)).toThrow("unreviewed-category");
    expect(() => adaptOndoUsdyPortfolio(html, { ...coin, reserves: [...coin.reserves!, coin.reserves![0]] }, NOW)).toThrow("unreviewed-category");
  });

  it("rejects a fifth portfolio category even when its value is zero", () => {
    const portfolio = JSON.parse(extractEscapedJsonValueAfterKey(html, '\\"portfolio\\":', "test"));
    portfolio.positions.push({ ...portfolio.positions[0], _id: "unknown", name: "Unknown category", value: 0 });
    expect(() => adapt(JSON.stringify({ portfolio }).replaceAll('"', '\\"'))).toThrow();
  });

  it("keeps observed zero categories from becoming positive exposure", () => {
    const result = adapt(html.replace('2094366235.88', '0').replace('2404341312.6700006', '309975076.79'));
    expect(result.slices).toHaveLength(3);
    expect(result.slices.some((slice) => slice.assetClass === "government-security")).toBe(false);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100);
  });

  it("uses the tighter age budget, admits the exact boundary and never widens the adapter cap", () => {
    expect(() => adaptOndoUsdyPortfolio(html, coin, NOW, 86400)).toThrow("stale-or-future-source");
    const timestamp = Date.parse("2026-10-22T00:00:00Z") / 1000;
    expect(adaptOndoUsdyPortfolio(html, coin, timestamp + 604800, 999999).slices).toHaveLength(4);
    expect(() => adaptOndoUsdyPortfolio(html, coin, timestamp + 604801, 999999)).toThrow("stale-or-future-source");
  });

  it("fetches one bounded source with the caller signal and no RPC or liability reads", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue(html);
    const signal = new AbortController().signal;
    expect(await fetchOndoUsdyReserves(coin, config, signal, { nowSec: NOW })).toEqual({
      ...adapt(), metadata: { ...adapt().metadata, details: { ...adapt().metadata!.details, sourceAgeBudgetCap: "scoring" } },
    });
    expect(fetchTextWithRetry).toHaveBeenLastCalledWith("https://ondo.finance/usdy", signal, 12_000, { nowSec: NOW }, { maxResponseBytes: 2_000_000 });
  });

  it.each([new Error("upstream-unavailable"), new DOMException("aborted", "AbortError")])("propagates unavailable/aborted reads without static fallback", async (error) => {
    vi.mocked(fetchTextWithRetry).mockRejectedValueOnce(error);
    await expect(fetchOndoUsdyReserves(coin, config, new AbortController().signal, { nowSec: NOW })).rejects.toBe(error);
  });
});
