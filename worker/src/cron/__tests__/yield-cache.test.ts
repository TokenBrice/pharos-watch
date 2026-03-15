import { describe, it, expect } from "vitest";
import {
  parseRiskFreeRateCache,
  parseDlStablecoinPoolsCache,
  buildRiskFreeRateCachePayload,
  serializeRiskFreeRateCache,
  buildDlStablecoinPoolsCache,
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

  it("returns null for negative rate", () => {
    expect(parseRiskFreeRateCache("-1.5", nowSec, nowSec)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRiskFreeRateCache("", nowSec, nowSec)).toBeNull();
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

  it("parses legacy array format", () => {
    const pools = [{ pool: "abc", chain: "Ethereum", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null, apyMean30d: 5.0, underlyingTokens: null }];
    const raw = JSON.stringify(pools);
    const result = parseDlStablecoinPoolsCache(raw, nowSec - 3600, nowSec);
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1);
    expect(result!.meta.fallbackMode).toBe("legacy-array-cache");
  });

  it("returns null for malformed JSON", () => {
    expect(parseDlStablecoinPoolsCache("{bad", nowSec, nowSec)).toBeNull();
  });

  it("returns null for non-array non-object JSON", () => {
    expect(parseDlStablecoinPoolsCache('"just a string"', nowSec, nowSec)).toBeNull();
  });
});
