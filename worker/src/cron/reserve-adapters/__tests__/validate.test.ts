import { describe, expect, it } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS, LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters";
import {
  DASHBOARD_SOURCE_MAX_AGE_SEC,
  DISCLOSURE_SOURCE_MAX_AGE_SEC,
} from "@shared/types/live-reserve-adapter-policy";
import type { ReserveAdapterDefinition } from "../types";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const slices = [{ name: "USDC", pct: 100, risk: "low" as const }];

type AdapterKey = keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS;

/**
 * The adapter context `validateAdapterOutput` reads, projected from the real
 * definition so the policy under test is the shipped one.
 *
 * `redemptionTelemetry` is opt-in: cases that assert *non*-redemption policy
 * deliberately withhold it, and supplying it would change which redemption
 * checks run.
 */
function adapterContext(key: AdapterKey, options: { redemptionTelemetry?: boolean } = {}) {
  // The definition union is heterogeneous — not every adapter declares
  // `validation` or `redemptionTelemetry` — so project the fields the validator
  // reads rather than narrowing the union at every call site.
  const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[key] as {
    sourceModel: unknown;
    evidenceClass: unknown;
    sharedSourceMode: unknown;
    redemptionTelemetry?: unknown;
    validation?: unknown;
  };
  return {
    key,
    fetch: async () => ({ slices: [] }),
    sourceModel: definition.sourceModel,
    evidenceClass: definition.evidenceClass,
    sharedSourceMode: definition.sharedSourceMode,
    ...(options.redemptionTelemetry === true
      ? { redemptionTelemetry: definition.redemptionTelemetry }
      : {}),
    validation: definition.validation,
  };
}

describe("validateAdapterOutput redemption telemetry", () => {
  it.each([
    [3600, 3600, true],
    [3601, 3600, false],
    [172800, undefined, true],
    [172801, undefined, false],
  ] as const)("bounds nested evidence age %ss using the existing %s budget", (age, maxSourceAgeSec, valid) => {
    const now = 1_790_467_200;
    const result = validateAdapterOutput({
      slices,
      metadata: {
        freshnessMode: "verified", sourceTimestamp: now,
        redemption: { sourceTimestamp: now - age, freshnessKind: "verified-source-timestamp" },
      },
    }, { now, maxSourceAgeSec });
    expect(result.valid).toBe(valid);
    if (!valid) expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "stale-redemption-source-timestamp", effect: "fatal",
    }));
  });

  it.each([
    [undefined, undefined, 172800],
    [3600, undefined, 3600],
    [undefined, 7200, 7200],
    [3600, 7200, 3600],
    [7200, 3600, 3600],
    [3600, 3600, 3600],
  ] as const)("takes the same tighter scoring %s / adapter %s budget for producer and nested evidence", (scoring, adapterCap, budget) => {
    const now = 1_790_467_200;
    const adapter = { ...getReserveAdapter("infinifi")!, validation: { maxSourceAgeSec: adapterCap } };
    const validate = (age: number, nested: boolean) => validateAdapterOutput({ slices, metadata: {
      freshnessMode: "verified", sourceTimestamp: now - (nested ? 0 : age),
      ...(nested ? { redemption: { sourceTimestamp: now - age, freshnessKind: "verified-source-timestamp" } } : {}),
    } }, { adapter, now, maxSourceAgeSec: scoring });
    expect(validate(budget, true).valid).toBe(true);
    expect(validate(budget + 1, true).warnings).toContainEqual(expect.objectContaining({
      code: "stale-redemption-source-timestamp", effect: "fatal",
    }));
    expect(validate(budget, false).warnings.some((warning) => warning.code === "stale-source-data")).toBe(false);
    expect(validate(budget + 1, false).warnings.some((warning) => warning.code === "stale-source-data"))
      .toBe(scoring !== undefined || adapterCap !== undefined);
  });

  it.each([0, -1])("degrades non-positive verified source clock %s without treating it as current", (sourceTimestamp) => {
    const result = validateAdapterOutput({ slices, metadata: { freshnessMode: "verified", sourceTimestamp } },
      { now: 1_790_467_200, adapter: getReserveAdapter("infinifi")!, maxSourceAgeSec: 3600 });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "stale-source-data", effect: "degraded" }));
  });

  it("rejects upstream source clocks beyond the skew allowance", () => {
    expect(validateAdapterOutput({ slices, metadata: { freshnessMode: "verified", sourceTimestamp: 1_790_467_801 } },
      { now: 1_790_467_200, adapter: getReserveAdapter("infinifi")!, maxSourceAgeSec: 3600 }).valid).toBe(false);
  });

  it("allows the upstream source-skew boundary without extending the source-age cap", () => {
    const result = validateAdapterOutput({ slices, metadata: { freshnessMode: "verified", sourceTimestamp: 1_790_467_800 } },
      { now: 1_790_467_200, adapter: getReserveAdapter("infinifi")!, maxSourceAgeSec: 3600 });
    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.effect === "degraded")).toBe(false);
  });

  it("retains raw upstream percentage drift after slices have been normalized", () => {
    const validateRawDeviation = (rawSumDeviation: number) => validateAdapterOutput({
      slices,
      metadata: { diag: { rawSumDeviation } },
    });
    expect(validateRawDeviation(0.5)).toEqual({ valid: true, warnings: [] });
    const degraded = validateRawDeviation(2);
    expect(degraded.valid).toBe(true);
    expect(degraded.warnings).toContainEqual(expect.objectContaining({
      code: "pct-sum-deviation", effect: "degraded",
    }));
    const fatal = validateRawDeviation(2.01);
    expect(fatal.valid).toBe(false);
    expect(fatal.warnings).toContainEqual(expect.objectContaining({
      code: "pct-sum-deviation", effect: "fatal",
    }));
  });

  it("keeps a disclosed whole-number total inside its rounding envelope ok, never past the error band", () => {
    const rounded = [{ name: "Cash", pct: 33, risk: "low" as const }, { name: "Bonds", pct: 66, risk: "low" as const }];
    const validateEnvelope = (pcts: typeof rounded, roundingEnvelopePct?: number) =>
      validateAdapterOutput({ slices: pcts, metadata: { diag: { publishedAllocationSumPct: 99, roundingEnvelopePct } } });
    expect(validateEnvelope(rounded, 1)).toEqual({ valid: true, warnings: [] });
    expect(validateEnvelope(rounded).warnings).toContainEqual(expect.objectContaining({
      code: "pct-sum-deviation", effect: "degraded",
    }));
    const pastEnvelope = [{ ...rounded[0]!, pct: 32.5 }, rounded[1]!];
    expect(validateEnvelope(pastEnvelope, 1).warnings).toContainEqual(expect.objectContaining({
      code: "pct-sum-deviation", effect: "degraded",
    }));
    const pastError = [{ ...rounded[0]!, pct: 30 }, rounded[1]!];
    expect(validateEnvelope(pastError, 10).valid).toBe(false);
  });

  it.each([null, "0", -0.1, Number.NaN, Infinity, undefined])("rejects present malformed raw deviation %s", (rawSumDeviation) => {
    const result = validateAdapterOutput({ slices, metadata: { diag: { rawSumDeviation } } });
    expect(result.valid).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid-raw-sum-deviation", effect: "fatal" }));
  });

  it("accepts absent raw deviation and measured zero without changing reviewed rounding omissions", () => {
    for (const diag of [{}, { rawSumDeviation: 0 }, { publishedAllocationSumPct: 99, roundingEnvelopePct: 2 }]) {
      expect(validateAdapterOutput({ slices, metadata: { diag } })).toEqual({ valid: true, warnings: [] });
    }
  });

  it.each([
    [null, "invalid-redemption-telemetry"],
    [[], "invalid-redemption-telemetry"],
    ["invalid", "invalid-redemption-telemetry"],
    [{ capacityUsd: 1_000_000, dailyLimitUsd: null }, "invalid-redemption-daily-limit"],
    [{ capacityUsd: 1_000_000, outputAssetKeys: ["asset:a", "asset:a"] }, "invalid-redemption-output-assets"],
    [{ capacityUsd: 1_000_000, outputValuation: { sourceId: "test", observedAt: 0, unitValueUsd: 1,
      basketWeights: [{ assetId: "a", weight: 0.9 }, { assetId: "b", weight: 0.2 }] } }, "invalid-redemption-output-valuation"],
  ])("rejects structurally malformed telemetry %j with a stable issue code", (redemption, code) => {
    const result = validateAdapterOutput({ slices, metadata: { redemption } }, { adapter: getReserveAdapter("gho")! });
    expect(result.valid).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code, effect: "fatal" }));
  });

  it("rejects slices above the public 100% per-slice schema limit", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "Oversized", pct: 101, risk: "low" },
        { name: "Remainder", pct: 1, risk: "medium" },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatchObject({
      code: "invalid-pct",
      effect: "fatal",
    });
  });

  it("rejects a zero-weight member even beside a valid full-weight slice", () => {
    const result = validateAdapterOutput({
      slices: [...slices, { name: "Empty credit book", pct: 0, risk: "high" }],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid-pct", effect: "fatal" }));
  });

  it("does not require a source timestamp for latest-state freshness", () => {
    expect(validateAdapterOutput(
      { slices, metadata: { freshnessMode: "not-applicable" } },
      { maxSourceAgeSec: 3600 },
    )).toEqual({ valid: true, warnings: [] });
  });

  it.each([
    {
      name: "nested capacity overrides valid legacy capacity", adapter: "gho",
      metadata: { immediateRedeemableUsd: 1_000_000, immediateRedeemableRatio: 0.1, redemption: { capacityUsd: -1, capacityRatioOfSupply: 0.1 } },
      codes: ["invalid-redemption-capacity-usd"],
    },
    {
      name: "nested ratio overrides valid legacy ratio", adapter: "gho",
      metadata: { immediateRedeemableUsd: 1_000_000, immediateRedeemableRatio: 0.1, redemption: { capacityUsd: 1_000_000, capacityRatioOfSupply: 1.5 } },
      codes: ["invalid-redemption-capacity-ratio"],
    },
    {
      name: "nested fees override valid legacy fees", adapter: "gho",
      metadata: { redemptionFeeBps: 10, redemption: { feeBps: -1 } },
      codes: ["invalid-redemption-fee-bps"],
    },
    {
      name: "stringified capacity and impossible fees", adapter: "gho",
      metadata: { redemptionFeeBps: 10, redemption: { capacityUsd: "1000000", feeBps: 20_000 } },
      codes: ["invalid-redemption-capacity-usd", "invalid-redemption-fee-bps"],
    },
    {
      name: "negative redemption constraints", adapter: "falcon",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-queue", settlementDelaySec: -1, queueDepthUsd: -1, dailyLimitUsd: -1, minRedeemUsd: -1 } },
      codes: ["invalid-redemption-settlement-delay", "invalid-redemption-queue-depth", "invalid-redemption-daily-limit", "invalid-redemption-min-redeem"],
    },
    {
      name: "malformed source URLs", adapter: "falcon",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-proxy-validated", sourceUrls: ["https://example.com/redemption.json", "not-a-url"] } },
      codes: ["invalid-redemption-source-urls"],
    },
    {
      name: "invalid review date", adapter: "falcon",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-proxy-validated", routeStatusReviewedAt: "2026-02-31" } },
      codes: ["invalid-redemption-route-reviewed-at"],
    },
    {
      name: "missing live route source", adapter: "gho",
      metadata: { redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded", routeStatus: "open" } },
      codes: ["missing-redemption-route-status-source"],
    },
  ])("rejects $name", ({ adapter, metadata, codes }) => {
    const result = validateAdapterOutput({ slices, metadata }, { adapter: getReserveAdapter(adapter)! });
    expect(result.valid).toBe(false);
    for (const code of codes) {
      expect(result.warnings).toContainEqual(expect.objectContaining({ code, effect: "fatal" }));
    }
  });

  it("rejects verified redemption freshness without a valid source timestamp", () => {
    const adapter = getReserveAdapter("gho");
    const missingTimestamp = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "verified-source-timestamp",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );
    const malformedTimestamp = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "verified-source-timestamp",
            sourceTimestamp: "1700000000",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(missingTimestamp.valid).toBe(false);
    expect(missingTimestamp.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing-redemption-source-timestamp",
        effect: "fatal",
      }),
    );
    expect(malformedTimestamp.valid).toBe(false);
    expect(malformedTimestamp.warnings).toContainEqual(
      expect.objectContaining({
        code: "invalid-redemption-source-timestamp",
        effect: "fatal",
      }),
    );
  });

  it.each([
    {
      name: "non-string route source", adapter: "gho",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded", routeStatus: "paused", routeStatusSource: 123 },
      codes: ["invalid-redemption-route-status-source"],
    },
    {
      name: "invalid holder, capacity and freshness kinds", adapter: "ethena",
      redemption: { capacityUsd: 1_000_000, capacityKind: "instant", freshnessKind: "fresh", holderEligibility: "vip-only" },
      codes: ["invalid-redemption-capacity-kind", "invalid-redemption-freshness-kind", "invalid-redemption-holder-eligibility"],
    },
    {
      name: "proxy capacity on direct-only adapter", adapter: "gho",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-proxy-validated" },
      codes: ["redemption-capacity-kind-mismatch"],
    },
    {
      name: "direct capacity on proxy-only adapter", adapter: "falcon",
      redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded" },
      codes: ["redemption-capacity-kind-mismatch"],
    },
  ])("rejects $name", ({ adapter, redemption, codes }) => {
    const result = validateAdapterOutput({ slices, metadata: { redemption } }, { adapter: getReserveAdapter(adapter)! });
    expect(result.valid).toBe(false);
    for (const code of codes) {
      expect(result.warnings).toContainEqual(expect.objectContaining({ code, effect: "fatal" }));
    }
  });

  it("degrades queue capacity that omits queue or delay semantics", () => {
    const adapter = getReserveAdapter("falcon");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-queue",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "redemption-queue-semantics-missing",
        effect: "degraded",
      }),
    );
  });

  it("suppresses redemption-capacity-unverified under reservoir's unverified-only API policy", () => {
    // Reservoir's balance sheet can only ever attest `unverified` freshness
    // (decision 2026-09-24), and an unverified-only policy deliberately
    // suppresses the capacity-freshness duplicate: the adapter's real capacity
    // telemetry is a same-run PSM read that withholds the whole block when the
    // read fails, so the suppressed duplicate carries no signal here.
    const adapter = getReserveAdapter("reservoir");
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          freshnessMode: "unverified",
          redemption: {
            capacityUsd: 1_000_000,
            freshnessKind: "unverified",
          },
        },
      },
      { adapter: adapter ?? undefined },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(false);
    expect(result.warnings.some((w) => w.code === "freshness-mode-disallowed")).toBe(false);
  });

  it("still emits redemption-capacity-unverified when the adapter allows verified freshness (ethena)", () => {
    const baseAdapter = getReserveAdapter("ethena");
    expect(baseAdapter).not.toBeNull();
    const adapter: ReserveAdapterDefinition = baseAdapter!;
    const result = validateAdapterOutput(
      {
        slices,
        metadata: {
          immediateRedeemableUsd: 1_000_000,
          redemption: {
            capacityUsd: 1_000_000,
            freshnessKind: "unverified",
          },
        },
      },
      { adapter },
    );

    expect(result.warnings.some((w) => w.code === "redemption-capacity-unverified")).toBe(true);
  });
});


it.each(["solomon-protocol:BTC reserve", `adapter:${"a".repeat(153)}`])("rejects an invalid persisted source key %s", (sourceKey) => {
  expect(validateAdapterOutput({ slices: [{ sourceKey, name: "Collateral", pct: 100, risk: "low" }] })).toMatchObject({
    valid: false, warnings: [expect.objectContaining({ code: "invalid-slice-schema", effect: "fatal" })],
  });
});

it("accepts a schema-valid source key at the maximum length", () => {
  expect(validateAdapterOutput({ slices: [{ sourceKey: `adapter:${"a".repeat(152)}`, name: "Collateral", pct: 100, risk: "low" }] }).valid).toBe(true);
});

describe("validateAdapterOutput", () => {
  it.each([
    {
      label: "slices summing to exactly 100",
      slices: [
        { name: "A", pct: 60, risk: "low" },
        { name: "B", pct: 40, risk: "medium" },
      ],
      warningCount: 0,
    },
    {
      // 102% stays valid but still records the (non-fatal) deviation warning.
      label: "a sum deviation inside the tolerance band",
      slices: [
        { name: "A", pct: 51, risk: "low" },
        { name: "B", pct: 51, risk: "medium" },
      ],
      warningCount: 1,
    },
  ])("accepts $label", ({ slices, warningCount }) => {
    const result = validateAdapterOutput({ slices: slices as never });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(warningCount);
  });

  it.each([
    { label: "a non-positive pct", slices: [{ name: "A", pct: 0, risk: "low" }, { name: "B", pct: 100, risk: "medium" }], code: "invalid-pct" },
    { label: "a negative pct", slices: [{ name: "A", pct: -10, risk: "low" }, { name: "B", pct: 110, risk: "medium" }], code: "invalid-pct" },
    { label: "a NaN pct", slices: [{ name: "A", pct: NaN, risk: "low" }], code: "invalid-pct" },
    { label: "an Infinity pct", slices: [{ name: "A", pct: Infinity, risk: "low" }], code: "invalid-pct" },
    { label: "an empty slice list", slices: [], code: "empty-slices" },
    { label: "an 80% total", slices: [{ name: "A", pct: 80, risk: "low" }], code: "pct-sum-deviation" },
    { label: "a 94% total", slices: [{ name: "A", pct: 94, risk: "low" }], code: "pct-sum-deviation" },
    { label: "a 95% total", slices: [{ name: "A", pct: 95, risk: "low" }], code: "pct-sum-deviation" },
    { label: "a 105% total", slices: [{ name: "A", pct: 55, risk: "low" }, { name: "B", pct: 50, risk: "medium" }], code: "pct-sum-deviation" },
  ])("rejects $label with a $code warning", ({ slices, code }) => {
    const result = validateAdapterOutput({ slices: slices as never });
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe(code);
  });

  it("rejects slices with invalid risk enum values", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 50, risk: "low" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { name: "B", pct: 50, risk: "bogus" as any },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects malformed, self-linked, and unknown dependency targets", () => {
    const knownIds = new Set(["subject", "known-upstream"]);
    for (const [slice, code] of [
      [{ name: "", pct: 100, risk: "low" }, "invalid-name"],
      [{ name: "Missing target", pct: 100, risk: "low", depType: "mechanism" }, "dependency-type-without-target"],
      [{ name: "Self", pct: 100, risk: "low", coinId: "subject" }, "self-dependency"],
      [{ name: "Unknown", pct: 100, risk: "low", coinId: "unknown" }, "unknown-dependency-target"],
    ] as const) {
      const result = validateAdapterOutput(
        { slices: [slice] as never },
        { subjectId: "subject", knownStablecoinIds: knownIds },
      );
      expect(result.valid).toBe(false);
      expect(result.warnings[0].code).toBe(code);
    }
  });

  it("accepts a known external dependency target", () => {
    const result = validateAdapterOutput(
      {
        slices: [
          {
            name: "Known upstream",
            pct: 100,
            risk: "low",
            coinId: "known-upstream",
            depType: "mechanism",
          },
        ],
      },
      { subjectId: "subject", knownStablecoinIds: new Set(["subject", "known-upstream"]) },
    );

    expect(result.valid).toBe(true);
  });

  it.each([
    {
      label: "upstream source data older than the adapter policy allows",
      adapterKey: "ethena" as AdapterKey,
      metadata: { sourceTimestamp: 1_000, freshnessMode: "verified" },
      now: 1_000 + 4 * 86400,
      code: "stale-source-data",
    },
    {
      label: "a source timestamp without an explicit freshnessMode",
      adapterKey: "ethena" as AdapterKey,
      metadata: { sourceTimestamp: 1_000 },
      now: undefined,
      code: "freshness-mode-missing",
    },
    {
      label: "an unverified output without reason metadata",
      adapterKey: "reservoir" as AdapterKey,
      metadata: { freshnessMode: "unverified" },
      now: undefined,
      code: "freshness-reason-missing",
    },
    {
      label: "a freshnessMode the adapter definition disallows",
      adapterKey: "fx" as AdapterKey,
      metadata: { freshnessMode: "verified", sourceTimestamp: 1_000 },
      now: undefined,
      code: "freshness-mode-disallowed",
    },
    {
      label: "material unknown exposure above the adapter threshold",
      adapterKey: "reservoir" as AdapterKey,
      metadata: { unknownExposurePct: 8 },
      now: undefined,
      code: "material-unknown-exposure",
    },
  ])("warns about $label with a $code warning", ({ adapterKey, metadata, now, code }) => {
    const result = validateAdapterOutput(
      { slices: slices, metadata: metadata as never },
      { adapter: adapterContext(adapterKey) as never, ...(now == null ? {} : { now }) },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === code)).toBe(true);
  });

  it("accepts source timestamps inside the late-monthly disclosure source-age policy", () => {
    const now = 1_000 + LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC;
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { sourceTimestamp: 1_000, freshnessMode: "verified" },
      },
      {
        maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
        now,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "stale-source-data")).toBe(false);
  });
  it("keeps the measured tether publication inside its disclosure freshness bound", () => {
    const sourceTimestamp = Math.floor(Date.parse("2026-08-21T23:30:02.000Z") / 1000);
    const now = Math.floor(Date.parse("2026-08-25T08:17:07.000Z") / 1000);
    const ageSec = now - sourceTimestamp;
    const adapter = adapterContext("tether-transparency");
    const output = {
      slices: slices,
      metadata: { sourceTimestamp, freshnessMode: "verified" },
    };

    expect(adapter.validation).toMatchObject({ maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC });
    expect(ageSec).toBeGreaterThan(DASHBOARD_SOURCE_MAX_AGE_SEC);
    expect(ageSec).toBeLessThan(DISCLOSURE_SOURCE_MAX_AGE_SEC);

    const disclosureResult = validateAdapterOutput(output, { adapter: adapter as never, now });
    expect(disclosureResult.warnings.some((warning) => warning.code === "stale-source-data")).toBe(false);

    const dashboardResult = validateAdapterOutput(output, {
      adapter: adapter as never,
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      now,
    });
    expect(dashboardResult.warnings.some((warning) => warning.code === "stale-source-data")).toBe(true);
  });

  it("allows source timestamps within the future skew window", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { sourceTimestamp: 1_000 + 600, freshnessMode: "verified" },
      },
      { adapter: adapterContext("ethena") as never, now: 1_000 },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "future-source-timestamp")).toBe(false);
  });

  it.each([
    {
      label: "a source timestamp beyond the future skew window",
      adapterKey: "ethena" as AdapterKey,
      redemptionTelemetry: false,
      metadata: { sourceTimestamp: 1_000 + 601, freshnessMode: "verified" },
      now: 1_000,
      code: "future-source-timestamp",
    },
    {
      label: "a redemption source timestamp beyond the future skew window",
      adapterKey: "cap-vault" as AdapterKey,
      redemptionTelemetry: true,
      metadata: { freshnessMode: "not-applicable", redemption: { sourceTimestamp: 1_000 + 601 } },
      now: 1_000,
      code: "future-source-timestamp",
    },
    {
      label: "verified freshness without a source timestamp",
      adapterKey: "ethena" as AdapterKey,
      redemptionTelemetry: false,
      metadata: { freshnessMode: "verified" },
      now: undefined,
      code: "verified-freshness-missing-source-timestamp",
    },
    {
      label: "a redemption capacity ratio outside [0, 1]",
      adapterKey: "ethena" as AdapterKey,
      redemptionTelemetry: true,
      metadata: { redemption: { capacityRatioOfSupply: 1.5 } },
      now: undefined,
      code: "invalid-redemption-capacity-ratio",
    },
    {
      label: "redemption capacity from an adapter without capacity telemetry",
      adapterKey: "circle-transparency" as AdapterKey,
      redemptionTelemetry: true,
      metadata: { redemption: { capacityUsd: 10_000, capacityRatioOfSupply: 0.1 } },
      now: undefined,
      code: "unsupported-redemption-capacity-telemetry",
    },
    {
      label: "a direct redemption kind from a proxy adapter",
      adapterKey: "falcon" as AdapterKey,
      redemptionTelemetry: true,
      metadata: {
        redemption: { capacityUsd: 10_000, capacityRatioOfSupply: 0.1, capacityKind: "live-direct" },
      },
      now: undefined,
      code: "redemption-capacity-kind-mismatch",
    },
    {
      label: "an unknown redemption route status",
      adapterKey: "cap-vault" as AdapterKey,
      redemptionTelemetry: true,
      metadata: { redemption: { routeStatus: "halted" } },
      now: undefined,
      code: "invalid-redemption-route-status",
    },
    {
      label: "an unknown redemption route status source",
      adapterKey: "cap-vault" as AdapterKey,
      redemptionTelemetry: true,
      metadata: { redemption: { routeStatusSource: "spreadsheet" } },
      now: undefined,
      code: "invalid-redemption-route-status-source",
    },
  ])("rejects $label with a $code fatal", ({ adapterKey, redemptionTelemetry, metadata, now, code }) => {
    const result = validateAdapterOutput(
      { slices: slices, metadata: metadata as never },
      {
        adapter: adapterContext(adapterKey, { redemptionTelemetry }) as never,
        ...(now == null ? {} : { now }),
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe(code);
  });

  it("collects all redemption fatals when multiple violations occur simultaneously", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: {
          redemption: {
            capacityUsd: -100,
            routeStatus: "exploded",
          },
        },
      },
      { adapter: adapterContext("cap-vault", { redemptionTelemetry: true }) as never },
    );

    expect(result.valid).toBe(false);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("invalid-redemption-capacity-usd");
    expect(codes).toContain("invalid-redemption-route-status");
  });
});
