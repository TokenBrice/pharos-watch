import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReserveSlice } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { fetchWithRetry } from "../../../lib/fetch-retry";
import {
  accumulateBucketedExposure,
  buildBucketSlices,
  buildUnknownExposureWarning,
  classifyBucketedValues,
  computeUnknownExposurePct,
  decimalStringFromBigInt,
  fetchJsonWithRetry,
  getAdapterTimeout,
  isReserveRisk,
  normalizeSlices,
  notApplicableFreshnessMetadata,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  valueUsdFromBigIntPrice,
  verifiedFreshnessMetadata,
} from "../helpers";

describe("normalizeSlices", () => {
  it("rounds to one decimal by default and adjusts the largest slice to sum to 100", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 33.3, risk: "low" },
      { name: "B", pct: 33.3, risk: "medium" },
      { name: "C", pct: 33.3, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(100, 10);
    expect(result[0].pct).toBe(33.4);
  });

  it("rounds to 1 decimal place when decimals=1", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 33.33, risk: "low" },
      { name: "B", pct: 33.33, risk: "medium" },
      { name: "C", pct: 33.33, risk: "high" },
    ];
    const result = normalizeSlices(slices, 1);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(100.0, 1);
  });

  it("deduplicates slices with the same name|risk|coinId|depType key", () => {
    const slices: ReserveSlice[] = [
      { name: "USDC", pct: 30, risk: "low", coinId: "usd-coin" },
      { name: "USDC", pct: 20, risk: "low", coinId: "usd-coin" },
      { name: "T-Bills", pct: 50, risk: "very-low" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.name === "USDC")?.pct).toBe(50);
    expect(result.find((s) => s.name === "T-Bills")?.pct).toBe(50);
  });

  it("keeps blacklistable slices distinct from non-blacklistable slices", () => {
    const result = normalizeSlices([
      { name: "USDC", pct: 50, risk: "low", coinId: "usdc-circle", blacklistable: true },
      { name: "USDC", pct: 50, risk: "low", coinId: "usdc-circle" },
    ]);

    expect(result).toHaveLength(2);
  });

  it("filters zero and negative slices", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 0, risk: "low" },
      { name: "B", pct: -5, risk: "medium" },
      { name: "C", pct: 100, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("C");
    expect(result[0].pct).toBe(100);
  });

  it("returns empty for empty input", () => {
    expect(normalizeSlices([])).toEqual([]);
  });

  it("sorts descending by pct", () => {
    const slices: ReserveSlice[] = [
      { name: "Small", pct: 10, risk: "low" },
      { name: "Large", pct: 60, risk: "medium" },
      { name: "Mid", pct: 30, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    expect(result.map((s) => s.name)).toEqual(["Large", "Mid", "Small"]);
  });
});

describe("accumulateBucketedExposure", () => {
  it("accumulates bucket totals and unknown exposure for positive values only", () => {
    const result = accumulateBucketedExposure({
      items: [
        { symbol: "USDC", value: 50 },
        { symbol: "ETH", value: 25 },
        { symbol: "MYSTERY", value: 15 },
        { symbol: "ZERO", value: 0 },
      ],
      getValue: (item) => item.value,
      getBucket: (item) => (item.symbol === "USDC" ? "stable" : "other"),
      isUnknown: (item) => item.symbol === "MYSTERY",
      getUnknownKey: (item) => item.symbol,
    });

    expect(result.totalValue).toBe(90);
    expect(result.bucketTotals.get("stable")).toBe(50);
    expect(result.bucketTotals.get("other")).toBe(40);
    expect(result.unknownValue).toBe(15);
    expect(Array.from(result.unknownValuesByKey.entries())).toEqual([["MYSTERY", 15]]);
  });
});

describe("classifyBucketedValues", () => {
  it("groups matched items into configured buckets and emits a shared unknown slice", () => {
    const result = classifyBucketedValues({
      items: [
        { symbol: "USDC", label: "USDC", value: 60 },
        { symbol: "PYUSD", label: "PYUSD", value: 30 },
        { symbol: "MYSTERY", label: "Mystery venue", value: 10 },
      ],
      rules: [
        {
          key: "usdc",
          name: "USDC positions",
          risk: "low",
          coinId: "usdc-circle",
          match: (item) => item.symbol === "USDC",
        },
        {
          key: "pyusd",
          name: "PYUSD positions",
          risk: "medium",
          coinId: "pyusd-paypal",
          match: (item) => item.symbol === "PYUSD",
        },
      ] as const,
      getValue: (item) => item.value,
      getUnknownLabel: (item) => item.label,
      totalValue: 100,
    });

    expect(result.bucketTotals.get("usdc")).toBe(60);
    expect(result.unknownItems).toEqual(["Mystery venue"]);
    expect(result.unknownExposurePct).toBe(10);
    expect(result.slices).toEqual([
      { name: "USDC positions", pct: 60, risk: "low", coinId: "usdc-circle" },
      { name: "PYUSD positions", pct: 30, risk: "medium", coinId: "pyusd-paypal" },
      { name: "Unmapped reserve positions", pct: 10, risk: "high" },
    ]);
  });
});

describe("slicesFromValues", () => {
  it("converts values to percentage slices summing to 100", () => {
    const result = slicesFromValues([
      { value: 700, name: "A", risk: "low" },
      { value: 300, name: "B", risk: "medium" },
    ]);
    expect(result.find((s) => s.name === "A")?.pct).toBe(70);
    expect(result.find((s) => s.name === "B")?.pct).toBe(30);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBe(100);
  });

  it("filters zero and negative values", () => {
    const result = slicesFromValues([
      { value: 0, name: "Zero", risk: "low" },
      { value: -10, name: "Neg", risk: "medium" },
      { value: 100, name: "Valid", risk: "high" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid");
    expect(result[0].pct).toBe(100);
  });

  it("returns empty for all-zero input", () => {
    const result = slicesFromValues([
      { value: 0, name: "A", risk: "low" },
      { value: 0, name: "B", risk: "medium" },
    ]);
    expect(result).toEqual([]);
  });

  it("preserves coinId and depType", () => {
    const result = slicesFromValues([
      { value: 50, name: "USDC", risk: "low", coinId: "usd-coin", depType: "collateral" },
      { value: 50, name: "DAI", risk: "medium", coinId: "dai" },
    ]);
    const usdc = result.find((s) => s.name === "USDC");
    expect(usdc?.coinId).toBe("usd-coin");
    expect(usdc?.depType).toBe("collateral");
    const dai = result.find((s) => s.name === "DAI");
    expect(dai?.coinId).toBe("dai");
    expect(dai?.depType).toBeUndefined();
  });

  it("rounds to 1 decimal by default (three equal values sum to 100.0)", () => {
    const result = slicesFromValues([
      { value: 100, name: "A", risk: "low" },
      { value: 100, name: "B", risk: "medium" },
      { value: 100, name: "C", risk: "high" },
    ]);
    const sum = result.reduce((acc, s) => acc + s.pct, 0);
    expect(sum).toBeCloseTo(100.0, 1);
  });
});

describe("buildBucketSlices", () => {
  it("builds slices from bucket totals and returns the immediate redeemable bucket value", () => {
    const bucketTotals = new Map([
      ["stable", 60],
      ["btc", 30],
      ["other", 10],
    ] as const);

    const result = buildBucketSlices(
      bucketTotals,
      [
        { name: "Stable", bucket: "stable", risk: "low" },
        { name: "BTC", bucket: "btc", risk: "medium" },
        { name: "Other", bucket: "other", risk: "high" },
      ],
      "stable",
    );

    expect(result.immediateRedeemableUsd).toBe(60);
    expect(result.slices).toEqual([
      { name: "Stable", pct: 60, risk: "low" },
      { name: "BTC", pct: 30, risk: "medium" },
      { name: "Other", pct: 10, risk: "high" },
    ]);
  });

  it("supports explicit slice values alongside bucket-backed slices", () => {
    const bucketTotals = new Map([
      ["stable", 50],
      ["btc", 25],
      ["other", 20],
    ] as const);

    const result = buildBucketSlices(
      bucketTotals,
      [
        { name: "Stable", bucket: "stable", risk: "low" },
        { name: "BTC", bucket: "btc", risk: "medium" },
        { name: "Other", bucket: "other", risk: "high" },
        { name: "Insurance", value: 5, risk: "medium" },
      ],
      "stable",
    );

    expect(result.immediateRedeemableUsd).toBe(50);
    expect(result.slices).toEqual([
      { name: "Stable", pct: 50, risk: "low" },
      { name: "BTC", pct: 25, risk: "medium" },
      { name: "Other", pct: 20, risk: "high" },
      { name: "Insurance", pct: 5, risk: "medium" },
    ]);
  });
});

describe("isReserveRisk", () => {
  it("returns true for all 5 valid risk values", () => {
    expect(isReserveRisk("very-low")).toBe(true);
    expect(isReserveRisk("low")).toBe(true);
    expect(isReserveRisk("medium")).toBe(true);
    expect(isReserveRisk("high")).toBe(true);
    expect(isReserveRisk("very-high")).toBe(true);
  });

  it("returns false for invalid values", () => {
    expect(isReserveRisk("lo")).toBe(false);
    expect(isReserveRisk("")).toBe(false);
    expect(isReserveRisk(null)).toBe(false);
    expect(isReserveRisk(undefined)).toBe(false);
    expect(isReserveRisk(42)).toBe(false);
  });
});

describe("getAdapterTimeout", () => {
  const baseConfig = {
    adapter: "single-asset",
    version: 1,
    semantics: "single-asset" as const,
    inputs: { primary: { kind: "http-json" as const, url: "https://example.com" } },
  } satisfies LiveReservesConfig;

  it("returns fallback when params.timeoutMs is not set", () => {
    expect(getAdapterTimeout(baseConfig, 12_000)).toBe(12_000);
  });

  it("returns default 10s when no fallback specified", () => {
    expect(getAdapterTimeout(baseConfig)).toBe(10_000);
  });
});

describe("unverifiedFreshnessMetadata", () => {
  it("standardizes unverified freshness semantics with explicit detail fields", () => {
    expect(unverifiedFreshnessMetadata("issuer-api", "timestamp missing")).toEqual({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "issuer-api",
        freshnessReason: "timestamp missing",
      },
    });
  });
});

describe("verifiedFreshnessMetadata", () => {
  it("standardizes verified freshness semantics", () => {
    expect(verifiedFreshnessMetadata(1_777_000_000)).toEqual({
      sourceTimestamp: 1_777_000_000,
      freshnessMode: "verified",
    });
  });
});

describe("notApplicableFreshnessMetadata", () => {
  it("standardizes latest-state freshness semantics", () => {
    expect(notApplicableFreshnessMetadata()).toEqual({
      freshnessMode: "not-applicable",
    });
  });
});

describe("parsePositiveNumericLike", () => {
  it("accepts finite positive numbers and numeric strings", () => {
    expect(parsePositiveNumericLike(42)).toBe(42);
    expect(parsePositiveNumericLike("42.5")).toBe(42.5);
  });

  it("rejects zero, negatives, blank strings, and non-scalars", () => {
    expect(parsePositiveNumericLike(0)).toBeNull();
    expect(parsePositiveNumericLike("-1")).toBeNull();
    expect(parsePositiveNumericLike("")).toBeNull();
    expect(parsePositiveNumericLike({ value: 1 })).toBeNull();
  });
});

describe("decimal helpers", () => {
  it("formats bigint decimals without losing structural precision", () => {
    expect(decimalStringFromBigInt(1_234_500_000_000_000_000n, 18)).toBe("1.2345");
  });

  it("values scaled bigint balances against usd prices without converting to decimal numbers first", () => {
    expect(valueUsdFromBigIntPrice(100_000_000n, 8, 60_000)).toBe(60_000);
  });
});

describe("unknown exposure helpers", () => {
  it("computes unknown exposure pct defensively", () => {
    expect(computeUnknownExposurePct(25, 100)).toBe(25);
    expect(computeUnknownExposurePct(0, 100)).toBe(0);
  });

  it("escalates warning effect when unknown exposure is material", () => {
    expect(buildUnknownExposureWarning({
      code: "unknown",
      message: "unknown buckets",
      unknownExposurePct: 2,
    }).effect).toBe("info");
    expect(buildUnknownExposureWarning({
      code: "unknown",
      message: "unknown buckets",
      unknownExposurePct: 7,
    }).effect).toBe("degraded");
  });
});

describe("parseTimestampLikeToUnixSeconds", () => {
  it("parses unix seconds, unix milliseconds, natural-language dates, and dd/mm/yy dates", () => {
    expect(parseTimestampLikeToUnixSeconds(1_773_316_982)).toBe(1_773_316_982);
    expect(parseTimestampLikeToUnixSeconds("1773337492853")).toBe(1_773_337_492);
    expect(parseTimestampLikeToUnixSeconds("Feb 28, 2026")).toBe(Date.UTC(2026, 1, 28) / 1000);
    expect(parseTimestampLikeToUnixSeconds("20/03/26")).toBe(Date.UTC(2026, 2, 20) / 1000);
  });

  it("returns null for unsupported timestamp values", () => {
    expect(parseTimestampLikeToUnixSeconds("")).toBeNull();
    expect(parseTimestampLikeToUnixSeconds("not-a-date")).toBeNull();
    expect(parseTimestampLikeToUnixSeconds(null)).toBeNull();
  });
});

describe("fetchJsonWithRetry", () => {
  const signal = AbortSignal.timeout(5000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests JSON explicitly and parses successful responses", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJsonWithRetry("https://example.com/api", signal, 1234)).resolves.toEqual({ ok: true });

    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://example.com/api",
      {
        signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      },
      2,
      { timeoutMs: 1234 },
    );
  });

  it("surfaces content type and body snippet when a JSON endpoint returns HTML", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response("<!DOCTYPE html><html><body>blocked</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    const error = await fetchJsonWithRetry("https://example.com/api", signal).then(
      () => new Error("expected fetchJsonWithRetry to reject"),
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected fetchJsonWithRetry to reject with an Error");
    }
    expect(error.message).toContain("JSON parse failed for https://example.com/api (text/html; charset=utf-8)");
    expect(error.message).toContain("body starts with: <!DOCTYPE html><html><body>blocked</body></html>");
  });
});
