import { describe, it, expect } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters-schemas";
import { validateAdapterOutput } from "../reserve-adapters/validate";

type AdapterKey = keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS;

/** The single 100% slice every metadata-focused case uses as its reserve body. */
const FULL_SLICE = [{ name: "A", pct: 100, risk: "low" }] as const;

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
      { slices: [...FULL_SLICE] as never, metadata: metadata as never },
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
      metadata: { immediateRedeemableRatio: 1.5 },
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
      { slices: [...FULL_SLICE] as never, metadata: metadata as never },
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
          immediateRedeemableUsd: -100,
          redemption: {
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
