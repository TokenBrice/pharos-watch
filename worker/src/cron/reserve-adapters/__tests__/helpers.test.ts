import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { decodeLiveReserveRedemptionTelemetry } from "@shared/types/live-reserves";
import { mockFetchRetry } from "../../../test-helpers/cron";
import type * as FetchRetry from "../../../lib/fetch-retry";

const fetchWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/fetch-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchRetry>()),
  ...mockFetchRetry({ fetchWithRetry: fetchWithRetryMock }),
}));

import { fetchWithRetry } from "../../../lib/fetch-retry";
import { buildAlchemyRpcUrl, type ChainRpcConfig, type RpcEndpoint } from "../../../lib/chain-registry";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  buildBucketSlices,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  decimalStringFromBigInt,
  fetchDefiLlamaPrices,
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  isReserveRisk,
  normalizeSlices,
  notApplicableFreshnessMetadata,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  probeTrackedTokenSupply,
  slicesFromPercentages,
  slicesFromValues,
  summarizeSourceTimestamps,
  summarizeSourceTimestampsRequiringCoverage,
  unverifiedFreshnessMetadata,
  valueUsdFromBigIntPrice,
  verifiedFreshnessMetadata,
} from "../helpers";
import { accumulateBucketedExposure, classifyBucketedValues } from "../classification";
import { parseDecimalNumber, parseFiniteNumber, sumBackingAssetAmounts } from "../strict-amount";

function solanaCoin(): StablecoinMeta {
  return {
    id: "test-solana",
    contracts: [{ chain: "solana", address: "Mint1111111111111111111111111111111111" }],
  } as StablecoinMeta;
}

function solanaContext(rpcUrl: string, fallbackRpcUrl?: string) {
  const urls = [rpcUrl, fallbackRpcUrl].filter((url): url is string => typeof url === "string" && url.length > 0);
  return { chainRpcs: new Map<string, ChainRpcConfig>([["solana", {
    chainId: "solana", chainName: "Solana", type: "other",
    endpoints: urls.map((url): RpcEndpoint => ({
      url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full",
    })),
    explorerUrl: "https://solscan.io",
  }]]) };
}

function solanaSupplyResponse(amount?: string) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1, result: { value: amount === undefined ? {} : { amount } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("buildRedemptionSnapshotMetadata", () => {
  it("nests fee telemetry inside redemption metadata without a legacy top-level field", () => {
    expect(buildRedemptionSnapshotMetadata({
      capacityUsd: 1250,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      feeBps: 52,
    })).toEqual({
      redemption: {
        capacityUsd: 1250,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        feeBps: 52,
      },
    });
  });

  it("canonicalizes and deduplicates valid producer URLs before they are persisted", () => {
    const sourceUrls = ["https://issuer.example", "https://issuer.example/", "https://issuer.example/redeem"];
    const metadata = buildRedemptionSnapshotMetadata({ capacityUsd: 100, sourceUrls });
    expect(metadata.redemption?.sourceUrls).toEqual(["https://issuer.example/", "https://issuer.example/redeem"]);
    expect(sourceUrls).toEqual(["https://issuer.example", "https://issuer.example/", "https://issuer.example/redeem"]);
    const decoded = decodeLiveReserveRedemptionTelemetry(metadata);
    expect(decoded).toEqual({ status: "valid", telemetry: metadata.redemption });
    expect(JSON.parse(JSON.stringify(metadata)).redemption).toEqual(metadata.redemption);
  });

  it.each(["ftp://issuer.example/redeem", "not-a-url"])("does not salvage producer telemetry by filtering invalid source URL %s", (invalidUrl) => {
    const sourceUrls = ["https://issuer.example/redeem", invalidUrl];
    const metadata = buildRedemptionSnapshotMetadata({ capacityUsd: 100, sourceUrls });
    expect(metadata.redemption?.sourceUrls).toEqual(sourceUrls);
    expect(decodeLiveReserveRedemptionTelemetry(metadata).status).toBe("invalid");
  });

  it("requires an explicit route observation before publishing live route provenance", () => {
    expect(buildRedemptionSnapshotMetadata({
      routeStatus: "open",
      routeStatusSource: "onchain",
    } as never)).toEqual({
      redemption: {
        routeStatus: "open",
      },
    });
    expect(buildRedemptionSnapshotMetadata({
      routeStatus: "open",
      routeStatusSource: "onchain",
      routeObserved: true,
    })).toEqual({
      redemption: {
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
    });
  });
  it("keeps producer fields closed while wire extensions remain a separate contract", () => {
    // @ts-expect-error Live attribution requires an affirmative observed-route claim.
    buildRedemptionSnapshotMetadata({ routeStatusSource: "onchain", routeStatus: "open" });
    // @ts-expect-error Known-field producer typing rejects misspelled telemetry keys.
    buildRedemptionSnapshotMetadata({ capacittyUsd: 1 });
    // @ts-expect-error Shared schema literals, not independently copied Worker vocabularies.
    buildRedemptionSnapshotMetadata({ freshnessKind: "latest-rpc" });
    // @ts-expect-error Genuine diagnostics do not reopen unknown/misspelled common fields.
    buildRedemptionSnapshotMetadata({ capacityUsd: 0, litePsmAddress: "0xabc", capacittyUsd: 1 });
    expect(buildRedemptionSnapshotMetadata({
      capacityUsd: 0, feeBps: null, outputAssetKeys: ["usdc-circle"],
      routeStatus: "paused", routeStatusSource: "onchain", routeObserved: true,
    })).toEqual({ redemption: { capacityUsd: 0, outputAssetKeys: ["usdc-circle"],
      routeStatus: "paused", routeStatusSource: "onchain" } });
  });
});

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

  it("filters zero slices and rejects negative percentages", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 0, risk: "low" },
      { name: "C", pct: 100, risk: "high" },
    ];
    const result = normalizeSlices(slices);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("C");
    expect(result[0].pct).toBe(100);
    expect(() => normalizeSlices([
      { name: "B", pct: -5, risk: "medium" },
      { name: "C", pct: 100, risk: "high" },
    ])).toThrow(/reserve percentages row 1 has invalid value: -5/);
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

  it("rejects a grossly oversummed upstream before remainder correction", () => {
    const slices: ReserveSlice[] = [
      { name: "A", pct: 150, risk: "low" },
      { name: "B", pct: 100, risk: "medium" },
      { name: "C", pct: 50, risk: "high" },
    ];
    expect(() => normalizeSlices(slices)).toThrow(
      /reserve percentages sum to 300\.0% \(expected 100% ± 2%\)/,
    );
  });

  it("corrects normal downward rounding drift (e.g. 100.1% -> 100%)", () => {
    // Ensure the defense-in-depth clamp doesn't break normal small-over-sum
    // normalization: the largest slice absorbs the small negative remainder.
    const slices: ReserveSlice[] = [
      { name: "Big", pct: 60.1, risk: "low" },
      { name: "Small", pct: 40, risk: "medium" },
    ];
    const result = normalizeSlices(slices);
    expect(result.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 5);
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

  it("filters zero values and rejects negative absolute or percentage rows", () => {
    const result = slicesFromValues([
      { value: 0, name: "Zero", risk: "low" },
      { value: 100, name: "Valid", risk: "high" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid");
    expect(result[0].pct).toBe(100);
    expect(() => slicesFromValues([
      { value: -10, name: "Neg", risk: "medium" },
      { value: 100, name: "Valid", risk: "high" },
    ])).toThrow(/reserve values row 1 has invalid value: -10/);
    expect(() => slicesFromPercentages([
      { pct: -10, name: "Neg", risk: "medium" },
      { pct: 110, name: "Valid", risk: "high" },
    ], { context: "test percentages" })).toThrow(/test percentages row 1 has invalid value: -10/);
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

describe("freshnessMetadataFromTimestamp", () => {
  it("returns verified metadata when a source timestamp is present", () => {
    expect(freshnessMetadataFromTimestamp(1_777_000_000, "issuer-api", "timestamp missing")).toEqual({
      sourceTimestamp: 1_777_000_000,
      freshnessMode: "verified",
    });
  });

  it("falls back to unverified metadata when the timestamp is null or undefined", () => {
    const expected = {
      freshnessMode: "unverified",
      details: {
        freshnessSource: "issuer-api",
        freshnessReason: "timestamp missing",
      },
    };
    expect(freshnessMetadataFromTimestamp(null, "issuer-api", "timestamp missing")).toEqual(expected);
    expect(freshnessMetadataFromTimestamp(undefined, "issuer-api", "timestamp missing")).toEqual(expected);
  });
});

describe("decimal amount parsing", () => {
  it.each([
    [42, 42], ["42.5", 42.5], [" .5 ", 0.5], ["1.", 1],
    ["+1e3", 1000], ["-1.5e-2", -0.015], ["1.E+2", 100],
    ["+0", 0], ["-0", -0], ["0", 0], [0, 0],
  ] as const)("preserves finite decimal units for %s", (value, expected) => {
    expect(parseDecimalNumber(value)).toBe(expected);
    expect(parseFiniteNumber(value, { label: "reserve amount" })).toBe(expected);
    expect(parsePositiveNumericLike(value)).toBe(expected > 0 ? expected : null);
  });

  it.each([
    "0x10", "0X10", "+0x10", "0b10", "0o10", "", "  ", ".", "+", "-",
    "1e", "1e+", "1e309", "-1e309", "1_000", "1,000", "Infinity", "NaN",
    "1.2.3", ".e2", "e2", "1ee2", "1e2.5", "1e--2", "1-2", "1 2",
    true, false, {}, { value: 1 }, [], [1], null, undefined, 1n,
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ])("rejects malformed amounts without a zero fallback: %s", (value) => {
    expect(parseDecimalNumber(value)).toBeNull();
    expect(parsePositiveNumericLike(value)).toBeNull();
    expect(() => parseFiniteNumber(value, { label: "reserve amount" })).toThrow();
  });

  it("does not coerce object conversion hooks", () => {
    const value = { valueOf: () => { throw new Error("must not coerce"); } };
    expect(parseDecimalNumber(value)).toBeNull();
    expect(parsePositiveNumericLike(value)).toBeNull();
  });

  it("distinguishes observed zero, negative amounts, absence, and inclusive minima", () => {
    expect(parseFiniteNumber("0", { label: "reserve amount", min: 0 })).toBe(0);
    expect(parseFiniteNumber("-0", { label: "reserve amount", min: 0 })).toBe(-0);
    expect(parseFiniteNumber("-1", { label: "reserve amount" })).toBe(-1);
    expect(parseFiniteNumber("0.5", { label: "reserve amount", min: 0.5 })).toBe(0.5);
    expect(() => parseFiniteNumber("0.499", { label: "reserve amount", min: 0.5 })).toThrow();
    expect(() => parseFiniteNumber("-1", { label: "reserve amount", min: 0 })).toThrow();
    expect(() => parseFiniteNumber(undefined, { label: "reserve amount", min: 0 })).toThrow();
    expect(parsePositiveNumericLike("-1")).toBeNull();
    expect(parsePositiveNumericLike(undefined)).toBeNull();
  });

  it.each([
    ["1,000", 1000], [" -12,345.5 ", -12345.5], ["+123,456,789.00", 123456789],
    ["1234.5", 1234.5], ["0", 0],
  ] as const)("preserves well-formed grouped decimal units for %s", (value, expected) => {
    expect(parseDecimalNumber(value, { allowGrouped: true })).toBe(expected);
    expect(parseFiniteNumber(value, { label: "reserve amount", allowGrouped: true })).toBe(expected);
  });

  it.each([
    "12,34", "1234,567", "1,,000", ",100", "1,000,", "1,000.0.0",
    "1,000.", "1,000e3", "1e3", ".5", "1.", "0x10", "", "  ",
  ])("rejects invalid grouping and unchanged grouped-mode exclusions: %s", (value) => {
    expect(parseDecimalNumber(value, { allowGrouped: true })).toBeNull();
    expect(() => parseFiniteNumber(value, { label: "reserve amount", allowGrouped: true })).toThrow();
  });

  it("retains zero backing rows but rejects negative, missing, and radix amounts", () => {
    expect(sumBackingAssetAmounts("issuer", "cash", [{ amount: "0" }, { amount: ".5" }])).toBe(0.5);
    for (const entries of [[{ amount: "-1" }], [{}], [{ amount: "0x10" }]]) {
      expect(() => sumBackingAssetAmounts("issuer", "cash", entries)).toThrow();
    }
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
      adapterKey: "infinifi",
      code: "unknown",
      message: "unknown buckets",
      unknownExposurePct: 5,
    }).effect).toBe("info");
    expect(buildUnknownExposureWarning({
      adapterKey: "infinifi",
      code: "unknown",
      message: "unknown buckets",
      unknownExposurePct: 7,
    }).effect).toBe("degraded");
    expect(buildUnknownExposureWarning({
      adapterKey: "flying-tulip-ftusd",
      code: "unknown",
      message: "unknown buckets",
      unknownExposurePct: 0.1,
    }).effect).toBe("degraded");
  });
});

describe("buildCoverageShortfallWarnings", () => {
  it("emits a degraded warning with the formatted coverage pct below the threshold", () => {
    expect(buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `reserves cover ${pct}% of supply`,
      coverageRatio: 0.987654,
    })).toEqual([{
      code: "reserve-undercollateralized",
      message: "reserves cover 98.77% of supply",
      severity: "warning",
      effect: "degraded",
    }]);
  });

  it("stays silent at or above the threshold and when the ratio is unknown", () => {
    expect(buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `${pct}%`,
      coverageRatio: 0.995,
    })).toEqual([]);
    expect(buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `${pct}%`,
      coverageRatio: null,
    })).toEqual([]);
  });

  it("honors a custom threshold ratio", () => {
    expect(buildCoverageShortfallWarnings({
      code: "nav-coverage-gap",
      message: (pct) => `${pct}%`,
      coverageRatio: 0.992,
      thresholdRatio: 0.99,
    })).toEqual([]);
    expect(buildCoverageShortfallWarnings({
      code: "nav-coverage-gap",
      message: (pct) => `${pct}%`,
      coverageRatio: 0.985,
      thresholdRatio: 0.99,
    })).toHaveLength(1);
  });

  it("treats binary rounding just under an exact threshold as covered", () => {
    // asUSDF in prod: backing / (supply * exchangePrice) = 0.9999999999999999.
    expect(buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `${pct}%`,
      coverageRatio: 0.9999999999999999,
      thresholdRatio: 1,
    })).toEqual([]);
    expect(buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `${pct}%`,
      coverageRatio: 0.99999,
      thresholdRatio: 1,
    })).toHaveLength(1);
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

  it("rejects ambiguous or invalid dd/mm/yy dates", () => {
    expect(parseTimestampLikeToUnixSeconds("7/05/26")).toBeNull();
    expect(parseTimestampLikeToUnixSeconds("31/02/26")).toBeNull();
    expect(parseTimestampLikeToUnixSeconds("20/13/26")).toBeNull();
  });

  it.each(["2024-02-29", "February 29, 2024", "Feb 29, 2000"])("accepts real leap dates (%s)", (value) => {
    const year = value.endsWith("2000") ? 2000 : 2024;
    expect(parseTimestampLikeToUnixSeconds(value)).toBe(Date.UTC(year, 1, 29) / 1000);
  });

  it.each([
    "2023-02-29", "2026-02-30", "2026-04-31", "2026-00-10", "2026-13-10",
    "Feb 29, 2023", "February 30, 2026", "Apr 31, 2026", "Feb 29, 2100",
    "2026-02-30T12:00:00Z", "2026-02-30T12:00:00+02:00",
    "2026-04-05T24:00:00Z", "2026-04-05T12:60:00Z", "2026-04-05T12:00:60Z",
    "2026-04-05T12:00:00+24:00", "2026-04-05T12:00:00-00:60",
  ])("rejects impossible calendar, time or offset components (%s)", (value) => {
    expect(parseTimestampLikeToUnixSeconds(value)).toBeNull();
  });

  it("converts explicit offsets and fractional seconds independently of the host timezone", () => {
    const expected = Date.UTC(2026, 3, 5, 10, 3, 24) / 1000;
    expect(parseTimestampLikeToUnixSeconds("2026-04-05T12:33:24.053849+02:30")).toBe(expected);
    expect(parseTimestampLikeToUnixSeconds("2026-04-05T07:03:24-0300")).toBe(expected);
    expect(parseTimestampLikeToUnixSeconds("2026-04-05T10:03:24Z")).toBe(expected);
  });

  it("requires an explicit reviewed UTC policy for zoneless datetimes", () => {
    const value = "2026-04-05T17:33:24.053849";
    expect(parseTimestampLikeToUnixSeconds(value)).toBeNull();
    expect(parseTimestampLikeToUnixSeconds(value, "assumed-utc")).toBe(Date.UTC(2026, 3, 5, 17, 33, 24) / 1000);
    expect(parseTimestampLikeToUnixSeconds("2026-02-30T17:33:24", "assumed-utc")).toBeNull();
  });

  it("retains the reviewed Accountable UTC clock and explicit-zone textual dates", () => {
    expect(parseTimestampLikeToUnixSeconds("2026.09.09 06:53:39 UTC")).toBe(Date.UTC(2026, 8, 9, 6, 53, 39) / 1000);
    expect(parseTimestampLikeToUnixSeconds("Thu, 05 Mar 2026 12:00:00 GMT")).toBe(Date.UTC(2026, 2, 5, 12) / 1000);
    expect(parseTimestampLikeToUnixSeconds("Feb 30, 2026 12:00:00 UTC")).toBeNull();
    expect(parseTimestampLikeToUnixSeconds("Thu, 31 Apr 2026 12:00:00 GMT")).toBeNull();
    expect(parseTimestampLikeToUnixSeconds("2026.02.30 06:53:39 UTC")).toBeNull();
  });

  it("keeps epoch units and rejects missing, nonfinite and nonpositive clocks", () => {
    expect(parseTimestampLikeToUnixSeconds(1_773_337_492_853)).toBe(1_773_337_492);
    expect(parseTimestampLikeToUnixSeconds("1773337492")).toBe(1_773_337_492);
    expect(parseTimestampLikeToUnixSeconds(1_773_337_492.9)).toBe(1_773_337_492);
    expect(parseTimestampLikeToUnixSeconds("1990-01-01")).toBe(Date.UTC(1990, 0, 1) / 1000);
    for (const value of [0, -1, "0", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, "1970-01-01"]) {
      expect(parseTimestampLikeToUnixSeconds(value)).toBeNull();
    }
  });
});

describe("source timestamp summaries", () => {
  it("computes count and extrema without changing submitted values", () => {
    const values = Object.freeze([1_000, 4_700, 2_000, 1_000]);
    expect(summarizeSourceTimestamps(values)).toEqual({
      sourceTimestamp: 1_000,
      latestSourceTimestamp: 4_700,
      sourceTimestampSpreadSec: 3_700,
      timestampCount: 4,
    });
    expect(summarizeSourceTimestampsRequiringCoverage(values)).toEqual({
      ...summarizeSourceTimestamps(values),
      untimestampedCount: 0,
    });
  });

  it("preserves all-bad and empty coverage counts with nullable extrema", () => {
    for (const values of [[], [null, "2026-02-30", 0, Number.NaN]]) {
      expect(summarizeSourceTimestamps(values)).toBeNull();
      expect(summarizeSourceTimestampsRequiringCoverage(values)).toEqual({
        sourceTimestamp: null,
        latestSourceTimestamp: null,
        sourceTimestampSpreadSec: null,
        timestampCount: 0,
        untimestampedCount: values.length,
      });
    }
  });

  it("distinguishes optional alternative clocks from incomplete material coverage", () => {
    const values = [null, 4_700, "2026-02-30", 1_000];
    expect(summarizeSourceTimestamps(values)).toEqual({
      sourceTimestamp: 1_000,
      latestSourceTimestamp: 4_700,
      sourceTimestampSpreadSec: 3_700,
      timestampCount: 2,
    });
    expect(summarizeSourceTimestampsRequiringCoverage(values)).toEqual({
      ...summarizeSourceTimestamps(values),
      untimestampedCount: 2,
    });
  });
});

describe("fetchJsonWithRetry", () => {
  const signal = AbortSignal.timeout(5000);

  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(error.message).toContain("JSON parse failed for https://example.com/api (HTTP 200, text/html; charset=utf-8)");
    expect(error.message).toContain("body starts with: <!DOCTYPE html><html><body>blocked</body></html>");
  });

  it("falls back across secondary Solana RPC endpoints when earlier endpoints fail", async () => {
    vi.mocked(fetchWithRetry)
      .mockRejectedValueOnce(new Error("POST fetch failed for https://solana-mainnet.g.alchemy.com/v2/alchemy-key"))
      .mockRejectedValueOnce(new Error("POST fetch failed for https://lb.drpc.org/ogrpc?network=solana&dkey=drpc-key"))
      .mockRejectedValueOnce(new Error("POST fetch failed for https://api.mainnet-beta.solana.com"))
      .mockRejectedValueOnce(new Error("POST fetch failed for https://api.mainnet.solana.com"))
      .mockResolvedValueOnce(solanaSupplyResponse("42"));

    await expect(probeTrackedTokenSupply(
      solanaCoin(),
      { kind: "onchain-solana" },
      signal,
      "curated-validated",
      solanaContext("https://solana-mainnet.g.alchemy.com/v2/alchemy-key", "https://lb.drpc.org/ogrpc?network=solana&dkey=drpc-key"),
    )).resolves.toBe(42n);

    expect(vi.mocked(fetchWithRetry).mock.calls.map(([url]) => url)).toEqual([
      "https://solana-mainnet.g.alchemy.com/v2/alchemy-key",
      "https://lb.drpc.org/ogrpc?network=solana&dkey=drpc-key",
      "https://api.mainnet-beta.solana.com",
      "https://api.mainnet.solana.com",
      "https://solana-rpc.publicnode.com",
    ]);
    expect(vi.mocked(fetchWithRetry)).toHaveBeenNthCalledWith(
      1,
      "https://solana-mainnet.g.alchemy.com/v2/alchemy-key",
      expect.objectContaining({ method: "POST", signal }),
      2,
      {
        timeoutMs: 10_000,
        returnFinalResponse: true,
        throwOnFinalNetworkError: true,
        onResponse: undefined,
        onBodyRead: expect.any(Function),
      },
    );
  });

  it("attaches the registered Alchemy auth header to keyed Solana RPC POSTs", async () => {
    const rpcUrl = buildAlchemyRpcUrl("solana-mainnet", "alchemy-secret");
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(solanaSupplyResponse("9"));

    await expect(probeTrackedTokenSupply(
      solanaCoin(),
      { kind: "onchain-solana" },
      signal,
      "curated-validated",
      solanaContext(rpcUrl),
    )).resolves.toBe(9n);

    expect(rpcUrl).toBe("https://solana-mainnet.g.alchemy.com/v2/");
    const [calledUrl, init] = vi.mocked(fetchWithRetry).mock.calls[0]!;
    expect(calledUrl).toBe(rpcUrl);
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer alchemy-secret");
  });

  it("redacts keyed Solana RPC URLs from the final supply error", async () => {
    vi.mocked(fetchWithRetry)
      .mockRejectedValueOnce(new Error("HTTP 403 for POST https://solana-mainnet.g.alchemy.com/v2/alchemy-secret"))
      .mockRejectedValueOnce(new Error("HTTP 403 for POST https://lb.drpc.org/ogrpc?network=solana&dkey=drpc-secret"))
      .mockImplementation(() => Promise.resolve(solanaSupplyResponse()));

    const error = await probeTrackedTokenSupply(
      solanaCoin(),
      { kind: "onchain-solana" },
      signal,
      "curated-validated",
      solanaContext("https://solana-mainnet.g.alchemy.com/v2/alchemy-secret", "https://lb.drpc.org/ogrpc?network=solana&dkey=drpc-secret"),
    ).then(
      () => new Error("expected supply probe to reject"),
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected an Error");
    expect(error.message).toContain("https://lb.drpc.org/[redacted]");
    expect(error.message).not.toContain("alchemy-secret");
    expect(error.message).not.toContain("drpc-secret");
  });

  it("keeps explicit Solana RPCs behind runtime keyed RPCs and ahead of public fallbacks", async () => {
    vi.mocked(fetchWithRetry)
      .mockRejectedValueOnce(new Error("POST fetch failed"))
      .mockRejectedValueOnce(new Error("POST fetch failed"))
      .mockResolvedValueOnce(solanaSupplyResponse("7"));

    await expect(probeTrackedTokenSupply(
      solanaCoin(),
      { kind: "onchain-solana" },
      signal,
      "curated-validated",
      solanaContext("https://runtime.example/solana", "https://runtime-fallback.example/solana"),
      "https://explicit.example/solana",
      "https://explicit-fallback.example/solana",
    )).resolves.toBe(7n);

    expect(vi.mocked(fetchWithRetry).mock.calls.map(([url]) => url)).toEqual([
      "https://runtime.example/solana",
      "https://runtime-fallback.example/solana",
      "https://explicit.example/solana",
    ]);
    expect(vi.mocked(fetchWithRetry)).toHaveBeenNthCalledWith(
      1,
      "https://runtime.example/solana",
      expect.objectContaining({ method: "POST", signal }),
      2,
      {
        timeoutMs: 10_000,
        returnFinalResponse: true,
        throwOnFinalNetworkError: true,
        onResponse: undefined,
        onBodyRead: expect.any(Function),
      },
    );
  });
});

describe("fetchDefiLlamaPrices", () => {
  const signal = AbortSignal.timeout(5000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes HyperEVM assets to DefiLlama's hyperliquid chain slug", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response(JSON.stringify({
        coins: {
          "hyperliquid:0x5555555555555555555555555555555555555555": { price: 37.27, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { prices, warnings } = await fetchDefiLlamaPrices([
      {
        key: "WHYPE",
        chain: "hyperevm",
        address: "0x5555555555555555555555555555555555555555",
      },
    ], signal);

    expect(prices.get("WHYPE")).toBe(37.27);
    expect(warnings).toEqual([]);
    expect(fetchWithRetry).toHaveBeenCalledWith(
      "https://coins.llama.fi/prices/current/hyperliquid:0x5555555555555555555555555555555555555555",
      { signal },
      2,
      {
        timeoutMs: 10_000,
        returnFinalResponse: true,
        throwOnFinalNetworkError: true,
        onBodyRead: expect.any(Function),
      },
    );
  });
});
