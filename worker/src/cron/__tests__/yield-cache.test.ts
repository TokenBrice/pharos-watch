import { describe, it, expect } from "vitest";
import {
  parseRiskFreeRateCache,
  parseRiskFreeRatesCache,
  parseDlStablecoinPoolsCache,
  buildRiskFreeRateCachePayload,
  buildRiskFreeRatesCachePayload,
  serializeRiskFreeRateCache,
  buildDlStablecoinPoolsCache,
  buildYieldSupplementalFamilyCache,
  parseYieldSupplementalSourcesCache,
  getDefaultDeterministicOnChainHealthState,
  parseDeterministicOnChainHealthState,
  type DeterministicOnChainHealthState,
} from "../yield-sync/cache";
import { buildNextDeterministicOnChainHealthState } from "../yield-sync/state";
import { makeDlYieldPool } from "./yield-resolve.test-support";

describe("parseRiskFreeRateCache", () => {
  const nowSec = 1710500000;

  it("parses a valid structured payload", () => {
    const payload = serializeRiskFreeRateCache(
      buildRiskFreeRateCachePayload({ rate: 4.25, source: "fred", recordDate: "2026-03-14", fetchedAt: nowSec - 3600 }),
    );
    const result = parseRiskFreeRateCache(payload, nowSec - 7200, nowSec);
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(4.25);
    expect(result!.source).toBe("fred");
    expect(result!.ageSeconds).toBe(3600);
    expect(result!.lastMarketRate).toBe(4.25);
    expect(result!.lastMarketSource).toBe("fred");
  });

  it("does not turn a future fetchedAt into age zero", () => {
    const payload = serializeRiskFreeRateCache(
      buildRiskFreeRateCachePayload({ rate: 4.25, source: "fred", fetchedAt: nowSec + 86400 }),
    );
    expect(parseRiskFreeRateCache(payload, nowSec, nowSec)?.ageSeconds).toBe(-86400);
  });

  it("returns null for malformed JSON", () => {
    expect(parseRiskFreeRateCache("{bad json", nowSec, nowSec)).toBeNull();
  });

  it("falls back to legacy scalar format", () => {
    const result = parseRiskFreeRateCache("3.75", nowSec - 86400, nowSec);
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(3.75);
    expect(result!.source).toBe("legacy-scalar");
  });

  it("accepts negative rates for non-USD benchmark support", () => {
    const result = parseRiskFreeRateCache("-1.5", nowSec, nowSec, { key: "CHF" });
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(-1.5);
    expect(result!.key).toBe("CHF");
  });

  it("returns null for empty string", () => {
    expect(parseRiskFreeRateCache("", nowSec, nowSec)).toBeNull();
  });
});

describe("parseRiskFreeRatesCache", () => {
  const nowSec = 1710500000;

  it("parses bundled benchmark records without reserializing nested payloads", () => {
    const raw = JSON.stringify(buildRiskFreeRatesCachePayload({
      USD: buildRiskFreeRateCachePayload({
        key: "USD",
        rate: 4.25,
        source: "fred",
        recordDate: "2026-03-14",
        fetchedAt: nowSec - 3600,
      }),
      USD_EFFR: null,
      EUR: buildRiskFreeRateCachePayload({
        key: "EUR",
        rate: 2.5,
        source: "ecb",
        recordDate: "2026-03-14",
        fetchedAt: nowSec - 7200,
      }),
      CHF: null,
      GBP: null,
      JPY: null,
      MXN: null,
      BRL: null,
      AUD: null,
      CAD: null,
      RUB: null,
      TRY: null,
      SGD: null,
    }));

    const result = parseRiskFreeRatesCache(raw, nowSec - 10_000, nowSec);

    expect(result?.USD.rate).toBe(4.25);
    expect(result?.USD.source).toBe("fred");
    expect(result?.EUR?.rate).toBe(2.5);
    expect(result?.EUR?.key).toBe("EUR");
    expect(result?.EUR?.source).toBe("ecb");
  });

  it("keeps legacy scalar behavior for unusual bundled scalar values", () => {
    const raw = JSON.stringify({
      version: 1,
      benchmarks: {
        USD: 3.75,
        EUR: "2.5",
      },
    });

    const result = parseRiskFreeRatesCache(raw, nowSec - 86400, nowSec);

    expect(result?.USD.rate).toBe(3.75);
    expect(result?.USD.source).toBe("legacy-scalar");
    expect(result?.EUR).toBeNull();
  });
});

describe("parseDlStablecoinPoolsCache", () => {
  const nowSec = 1710500000;

  it("parses structured payload with data array", () => {
    const pools = [makeDlYieldPool({ pool: "abc", project: "sdai", tvlUsd: 1e8 })];
    const raw = buildDlStablecoinPoolsCache(pools, nowSec - 1800);
    const result = parseDlStablecoinPoolsCache(raw, nowSec - 1800, nowSec);
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1);
    expect(result!.meta.ageSeconds).toBe(1800);
  });

  it("rejects legacy array format", () => {
    const pools = [makeDlYieldPool({ pool: "abc", project: "sdai", tvlUsd: 1e8 })];
    const raw = JSON.stringify(pools);
    expect(parseDlStablecoinPoolsCache(raw, nowSec - 3600, nowSec)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseDlStablecoinPoolsCache("{bad", nowSec, nowSec)).toBeNull();
  });

  it("returns null for non-array non-object JSON", () => {
    expect(parseDlStablecoinPoolsCache('"just a string"', nowSec, nowSec)).toBeNull();
  });

  it("drops malformed cached DL rows while keeping valid rows", () => {
    const raw = JSON.stringify({
      updatedAt: nowSec - 3600,
      source: "sync-dex-liquidity",
      poolCount: 2,
      data: [
        makeDlYieldPool({ pool: "bad-apy", project: "sdai", tvlUsd: 1e8, apy: Number.NaN }),
        makeDlYieldPool({ pool: "valid", project: "sdai", tvlUsd: 1e8 }),
      ],
    });

    const result = parseDlStablecoinPoolsCache(raw, nowSec - 3600, nowSec);

    expect(result?.pools.map((pool) => pool.pool)).toEqual(["valid"]);
    expect(result?.meta.poolCount).toBe(1);
  });

  it("rejects structured DL cache payloads with future updatedAt", () => {
    const raw = buildDlStablecoinPoolsCache([
      makeDlYieldPool({ pool: "valid", project: "sdai", tvlUsd: 1e8 }),
    ], nowSec + 1);

    expect(parseDlStablecoinPoolsCache(raw, nowSec, nowSec)).toBeNull();
  });
});

describe("parseYieldSupplementalSourcesCache", () => {
  const nowSec = 1710500000;

  it("rejects legacy array format", () => {
    const raw = JSON.stringify([{
      symbol: "sDAI",
      yield: {
        currentApy: 4.2,
        apyBase: 4.2,
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd: null,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: "protocol-api:test:ethereum:0x1",
        sourceObservedAt: nowSec,
        comparisonAnchorObservedAt: null,
      },
    }]);

    expect(parseYieldSupplementalSourcesCache(raw, nowSec, nowSec)).toBeNull();
  });

  it("accepts nullable reward and source TVL fields for otherwise valid supplemental candidates", () => {
    const raw = buildYieldSupplementalFamilyCache([
      {
        symbol: "sDAI",
        chain: "ethereum",
        address: null,
        yield: {
          currentApy: 4.2,
          apyBase: 4.2,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "protocol-api:test:ethereum:0x1",
          yieldSource: "Test Source",
          yieldType: "lending-opportunity",
          sourceObservedAt: nowSec,
          comparisonAnchorObservedAt: null,
        },
      },
    ], nowSec);

    const result = parseYieldSupplementalSourcesCache(raw, nowSec, nowSec);

    expect(result?.candidates).toHaveLength(1);
  });

  it("drops supplemental candidates with future observations, non-finite APY, or APY above 300%", () => {
    const raw = JSON.stringify({
      version: 1,
      updatedAt: nowSec,
      source: "sync-yield-supplemental",
      sourceCount: 4,
      data: [
        {
          symbol: "sDAI",
          yield: {
            currentApy: 4.2,
            apyBase: 4.2,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: "valid",
            sourceObservedAt: nowSec,
            comparisonAnchorObservedAt: null,
          },
        },
        {
          symbol: "sDAI",
          yield: {
            currentApy: "bad",
            sourceKey: "bad-apy",
          },
        },
        {
          symbol: "sDAI",
          yield: {
            currentApy: 4.2,
            apyBase: 4.2,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: "future",
            sourceObservedAt: nowSec + 1,
            comparisonAnchorObservedAt: null,
          },
        },
        {
          symbol: "sDAI",
          yield: {
            currentApy: 5000,
            apyBase: 5000,
            apyReward: null,
            sourcePool: null,
            sourceTvlUsd: null,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: "over-envelope",
            sourceObservedAt: nowSec,
            comparisonAnchorObservedAt: null,
          },
        },
      ],
    });

    const result = parseYieldSupplementalSourcesCache(raw, nowSec, nowSec);

    expect(result?.candidates.map((candidate) => candidate.yield.sourceKey)).toEqual(["valid"]);
    expect(result?.sourceCount).toBe(4);
  });

  it("rejects supplemental cache payloads with future updatedAt", () => {
    const raw = buildYieldSupplementalFamilyCache([
      {
        symbol: "sDAI",
        yield: {
          currentApy: 4.2,
          apyBase: 4.2,
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: null,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: "valid",
          sourceObservedAt: nowSec,
          comparisonAnchorObservedAt: null,
        },
      },
    ], nowSec + 1);

    expect(parseYieldSupplementalSourcesCache(raw, nowSec, nowSec)).toBeNull();
  });
});

// Mirrors the module-private constants in state.ts.
const COOLDOWN_THRESHOLD = 2;
const COOLDOWN_SEC = 6 * 3600;
const START = 1_000_000;

const DEFAULT = getDefaultDeterministicOnChainHealthState();

type Params = Parameters<typeof buildNextDeterministicOnChainHealthState>[0];

function baseParams(overrides: Partial<Params> = {}): Params {
  return {
    deterministicConfigCount: 4,
    previous: DEFAULT,
    startSec: START,
    onChainAttemptedCount: 4,
    onChainRatesResolved: 0,
    allDeterministicFailed: false,
    maskedAllDeterministicFailure: false,
    onChainAlternativeCoverageMissingIds: [],
    onChainSkippedDueToCooldown: false,
    ...overrides,
  };
}

function previousWith(overrides: Partial<DeterministicOnChainHealthState>): DeterministicOnChainHealthState {
  return { ...DEFAULT, ...overrides };
}

describe("parseDeterministicOnChainHealthState", () => {
  it("resets a far-future cooldown instead of suppressing on-chain reads indefinitely", () => {
    const parsed = parseDeterministicOnChainHealthState(JSON.stringify({
      consecutiveAllFailRuns: 9,
      consecutiveMaskedAllFailRuns: 9,
      cooldownUntil: START + 10 * 365 * 24 * 3600,
      lastAttemptedAt: START - 10,
      lastFailureMissingIds: ["coin-a"],
    }), START);

    expect(parsed).toEqual(DEFAULT);
  });
});

describe("buildNextDeterministicOnChainHealthState", () => {
  it("resets to default when there are no deterministic configs", () => {
    const result = buildNextDeterministicOnChainHealthState(
      baseParams({
        deterministicConfigCount: 0,
        previous: previousWith({ consecutiveAllFailRuns: 3, cooldownUntil: START + COOLDOWN_SEC }),
      }),
    );
    expect(result).toEqual(DEFAULT);
  });

  describe("skipped due to cooldown", () => {
    it("preserves prior state and stamps lastSkippedAt when alternative coverage is complete", () => {
      const previous = previousWith({
        consecutiveAllFailRuns: 2,
        consecutiveMaskedAllFailRuns: 2,
        cooldownUntil: START + COOLDOWN_SEC,
        lastSuccessAt: 500,
      });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, onChainSkippedDueToCooldown: true }),
      );
      expect(result).toEqual({ ...previous, lastSkippedAt: START });
    });

    it("resets accumulators but records the missing ids when alternative coverage has gaps", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 2, consecutiveMaskedAllFailRuns: 2 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({
          previous,
          onChainSkippedDueToCooldown: true,
          onChainAlternativeCoverageMissingIds: ["aave-usdc", "morpho-usdt"],
        }),
      );
      expect(result).toEqual({
        ...DEFAULT,
        lastSkippedAt: START,
        lastFailureMissingIds: ["aave-usdc", "morpho-usdt"],
      });
    });
  });

  describe("nothing attempted", () => {
    it("keeps an active future cooldown", () => {
      const previous = previousWith({
        consecutiveAllFailRuns: 2,
        consecutiveMaskedAllFailRuns: 2,
        cooldownUntil: START + 100,
      });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, onChainAttemptedCount: 0 }),
      );
      expect(result).toEqual({ ...previous, cooldownUntil: START + 100 });
    });

    it("clears an expired cooldown", () => {
      const previous = previousWith({ cooldownUntil: START - 100 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, onChainAttemptedCount: 0 }),
      );
      expect(result).toEqual({ ...previous, cooldownUntil: null });
    });
  });

  it("resets to a fresh success state when any on-chain rate resolves", () => {
    const previous = previousWith({ consecutiveAllFailRuns: 5, consecutiveMaskedAllFailRuns: 5 });
    const result = buildNextDeterministicOnChainHealthState(
      baseParams({ previous, onChainRatesResolved: 3, allDeterministicFailed: true }),
    );
    expect(result).toEqual({
      ...DEFAULT,
      lastAttemptedAt: START,
      lastSuccessAt: START,
    });
  });

  describe("all deterministic sources failed", () => {
    it("increments unmasked all-fail runs but never triggers cooldown and resets the masked counter", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 1, consecutiveMaskedAllFailRuns: 5, lastSuccessAt: 42 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({
          previous,
          allDeterministicFailed: true,
          maskedAllDeterministicFailure: false,
          onChainAlternativeCoverageMissingIds: ["x"],
        }),
      );
      expect(result.consecutiveAllFailRuns).toBe(2);
      expect(result.consecutiveMaskedAllFailRuns).toBe(0);
      expect(result.cooldownUntil).toBeNull();
      expect(result.lastAttemptedAt).toBe(START);
      expect(result.lastAllFailedAt).toBe(START);
      expect(result.lastSuccessAt).toBe(42);
      expect(result.lastFailureMissingIds).toEqual(["x"]);
    });

    it("accumulates masked all-fail runs below the threshold without cooldown", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 0, consecutiveMaskedAllFailRuns: COOLDOWN_THRESHOLD - 2 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, allDeterministicFailed: true, maskedAllDeterministicFailure: true }),
      );
      expect(result.consecutiveMaskedAllFailRuns).toBe(COOLDOWN_THRESHOLD - 1);
      expect(result.cooldownUntil).toBeNull();
    });

    it("triggers cooldown once masked all-fail runs reach the threshold", () => {
      const previous = previousWith({ consecutiveAllFailRuns: 1, consecutiveMaskedAllFailRuns: COOLDOWN_THRESHOLD - 1 });
      const result = buildNextDeterministicOnChainHealthState(
        baseParams({ previous, allDeterministicFailed: true, maskedAllDeterministicFailure: true }),
      );
      expect(result.consecutiveMaskedAllFailRuns).toBe(COOLDOWN_THRESHOLD);
      expect(result.cooldownUntil).toBe(START + COOLDOWN_SEC);
    });
  });

  it("records the attempt and resets accumulators for a partial (non-total) failure", () => {
    const previous = previousWith({ consecutiveAllFailRuns: 4, consecutiveMaskedAllFailRuns: 4 });
    const result = buildNextDeterministicOnChainHealthState(
      baseParams({ previous, allDeterministicFailed: false, onChainRatesResolved: 0 }),
    );
    expect(result).toEqual({ ...DEFAULT, lastAttemptedAt: START });
  });
});
