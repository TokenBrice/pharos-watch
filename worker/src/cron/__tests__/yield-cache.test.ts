import { describe, it, expect } from "vitest";
import {
  parseRiskFreeRateCache,
  parseRiskFreeRatesCache,
  parseDlStablecoinPoolsCache,
  buildRiskFreeRateCachePayload,
  buildRiskFreeRatesCachePayload,
  serializeRiskFreeRateCache,
  buildDlStablecoinPoolsCache,
  buildYieldSupplementalSourcesCache,
  parseYieldSupplementalSourcesCache,
} from "../yield-sync/cache";

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
    const pools = [{ pool: "abc", chain: "Ethereum", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null, apyMean30d: 5.0, underlyingTokens: null }];
    const raw = buildDlStablecoinPoolsCache(pools, nowSec - 1800);
    const result = parseDlStablecoinPoolsCache(raw, nowSec - 1800, nowSec);
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1);
    expect(result!.meta.ageSeconds).toBe(1800);
  });

  it("rejects legacy array format", () => {
    const pools = [{ pool: "abc", chain: "Ethereum", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null, apyMean30d: 5.0, underlyingTokens: null }];
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
        { pool: "bad-apy", chain: "Ethereum", symbol: "sDAI", apy: Number.NaN, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null, apyMean30d: 5.0, underlyingTokens: null },
        { pool: "valid", chain: "Ethereum", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null, apyMean30d: 5.0, underlyingTokens: null },
      ],
    });

    const result = parseDlStablecoinPoolsCache(raw, nowSec - 3600, nowSec);

    expect(result?.pools.map((pool) => pool.pool)).toEqual(["valid"]);
    expect(result?.meta.poolCount).toBe(1);
  });

  it("rejects structured DL cache payloads with future updatedAt", () => {
    const raw = buildDlStablecoinPoolsCache([
      { pool: "valid", chain: "Ethereum", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null, apyMean30d: 5.0, underlyingTokens: null },
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
    const raw = buildYieldSupplementalSourcesCache([
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

  it("drops supplemental candidates with future observations or non-finite APY", () => {
    const raw = JSON.stringify({
      version: 1,
      updatedAt: nowSec,
      source: "sync-yield-supplemental",
      sourceCount: 3,
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
      ],
    });

    const result = parseYieldSupplementalSourcesCache(raw, nowSec, nowSec);

    expect(result?.candidates.map((candidate) => candidate.yield.sourceKey)).toEqual(["valid"]);
    expect(result?.sourceCount).toBe(3);
  });

  it("rejects supplemental cache payloads with future updatedAt", () => {
    const raw = buildYieldSupplementalSourcesCache([
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
