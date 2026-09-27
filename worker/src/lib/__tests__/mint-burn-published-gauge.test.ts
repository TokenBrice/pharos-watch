import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  parsePublishedMintBurnGauge,
  readPublishedMintBurnGauge,
  PUBLISHED_GAUGE_MAX_AGE_SEC,
  PUBLISHED_GAUGE_STALE_AFTER_SEC,
} from "../mint-burn-published-gauge";

const NOW_SEC = 1_800_000_000;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gauge: { score: -12.5, band: "CAUTIOUS" },
    coins: [
      { stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: -20, netFlow24hUsd: -5_000_000 },
      { stablecoinId: "usdc-circle", symbol: "USDC", pressureShiftScore: null, netFlow24hUsd: 1_000_000 },
    ],
    chains: [{ chainId: "ethereum", netFlow24hUsd: -4_000_000 }],
    ...overrides,
  };
}

function cacheTable(value: string, ageSec: number) {
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: ["mint-burn-flows:v3:aggregate:24"],
    rows: [],
    first: { value, updated_at: NOW_SEC - ageSec },
  };
}

const UNKNOWN_VALUATION = {
  completeness: "unknown",
  mintCompleteness: "unknown",
  burnCompleteness: "unknown",
  unpricedMintEventCount: 0,
  unpricedBurnEventCount: 0,
};
const PARTIAL_MINT_VALUATION = {
  completeness: "partial",
  mintCompleteness: "partial",
  burnCompleteness: "complete",
  unpricedMintEventCount: 1,
  unpricedBurnEventCount: 0,
};

describe("parsePublishedMintBurnGauge", () => {
  it("reads a publication that predates valuation completeness as unknown, never complete", () => {
    const gauge = parsePublishedMintBurnGauge(payload(), NOW_SEC, false);
    expect(gauge).toEqual({
      score: -12.5,
      partialValuationInputs: null,
      coins: [
        {
          id: "usdt-tether", symbol: "USDT", intensity: -20, net24hUsd: -5_000_000,
          valuation24h: UNKNOWN_VALUATION, baselineValuation: "unknown",
        },
        {
          id: "usdc-circle", symbol: "USDC", intensity: null, net24hUsd: 1_000_000,
          valuation24h: UNKNOWN_VALUATION, baselineValuation: "unknown",
        },
      ],
      chains: [{ chainId: "ethereum", net24hUsd: -4_000_000, valuation: "unknown" }],
      publishedAt: NOW_SEC,
      stale: false,
    });
  });

  it("reads valuation blocks and valuation-gated null nets", () => {
    const gauge = parsePublishedMintBurnGauge(payload({
      gauge: { score: -12.5, partialValuationInputs: 1 },
      coins: [{
        stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: null, netFlow24hUsd: null,
        valuation: {
          window24h: PARTIAL_MINT_VALUATION, baseline: "complete",
          netFlow7d: "partial", netFlow30d: "partial", netFlow90d: "unknown",
        },
      }],
      chains: [{ chainId: "ethereum", netFlow24hUsd: null, valuation: "partial" }],
    }), NOW_SEC, false);
    expect(gauge).toMatchObject({
      partialValuationInputs: 1,
      coins: [{ id: "usdt-tether", net24hUsd: null, valuation24h: PARTIAL_MINT_VALUATION, baselineValuation: "complete" }],
      chains: [{ chainId: "ethereum", net24hUsd: null, valuation: "partial" }],
    });
  });

  it("keeps a null gauge score (all coins NR) as a usable publication", () => {
    expect(parsePublishedMintBurnGauge(payload({ gauge: { score: null } }), NOW_SEC, false)?.score).toBeNull();
  });

  it("treats a publication written before the chain breakdown as chain-less", () => {
    const { chains, ...rest } = payload();
    expect(chains).toBeDefined();
    expect(parsePublishedMintBurnGauge(rest, NOW_SEC, false)?.chains).toEqual([]);
  });

  it.each([
    ["no gauge object", { coins: [] }],
    ["non-numeric score", payload({ gauge: { score: "12" } })],
    ["non-numeric partial valuation input count", payload({ gauge: { score: 1, partialValuationInputs: "1" } })],
    ["non-array coins", payload({ coins: {} })],
    ["coin without a net flow", payload({ coins: [{ stablecoinId: "a", symbol: "A" }] })],
    ["coin with an unparseable intensity", payload({
      coins: [{ stablecoinId: "a", symbol: "A", pressureShiftScore: "hot", netFlow24hUsd: 1 }],
    })],
    ["coin with a malformed valuation", payload({
      coins: [{ stablecoinId: "a", symbol: "A", pressureShiftScore: null, netFlow24hUsd: 1, valuation: { window24h: {} } }],
    })],
    ["chain without a net flow", payload({ chains: [{ chainId: "ethereum" }] })],
    ["chain with an unknown valuation label", payload({ chains: [{ chainId: "ethereum", netFlow24hUsd: 1, valuation: "maybe" }] })],
  ])("fails closed on %s", (_label, value) => {
    expect(parsePublishedMintBurnGauge(value, NOW_SEC, false)).toBeNull();
  });
});

describe("readPublishedMintBurnGauge", () => {
  it("returns missing when nothing has been published", async () => {
    const result = await readPublishedMintBurnGauge(mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["mint-burn-flows:v3:aggregate:24"],
        rows: [],
        first: null,
      },
    ]), NOW_SEC);
    expect(result).toEqual({ kind: "unavailable", reason: "missing" });
  });

  it("returns expired past the max age", async () => {
    const db = mockD1([cacheTable(JSON.stringify(payload()), PUBLISHED_GAUGE_MAX_AGE_SEC + 1)]);
    expect(await readPublishedMintBurnGauge(db, NOW_SEC)).toEqual({ kind: "unavailable", reason: "expired" });
  });

  it("returns malformed on unparseable JSON", async () => {
    const db = mockD1([cacheTable("{not json", 60)]);
    expect(await readPublishedMintBurnGauge(db, NOW_SEC)).toEqual({ kind: "unavailable", reason: "malformed" });
  });

  it("flags staleness past the producer tolerance without rejecting the gauge", async () => {
    const db = mockD1([cacheTable(JSON.stringify(payload()), PUBLISHED_GAUGE_STALE_AFTER_SEC + 60)]);
    const result = await readPublishedMintBurnGauge(db, NOW_SEC);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.gauge.stale).toBe(true);
    expect(result.kind === "ok" && result.gauge.score).toBe(-12.5);
  });
});
