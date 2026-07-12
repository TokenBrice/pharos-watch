import { describe, it, expect } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC } from "@shared/lib/live-reserve-adapters-schemas";
import { validateAdapterOutput } from "../reserve-adapters/validate";

describe("validateAdapterOutput", () => {
  it("accepts valid slices summing to 100", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 60, risk: "low" },
        { name: "B", pct: 40, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when slices sum deviates from 100 by more than 5 points", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: 80, risk: "low" }],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("pct-sum-deviation");
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

  it("rejects slices with non-positive pct", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 0, risk: "low" },
        { name: "B", pct: 100, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe("invalid-pct");
  });

  it("rejects slices with negative pct", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: -10, risk: "low" },
        { name: "B", pct: 110, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects slices with NaN pct", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: NaN, risk: "low" }],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts slices with sum deviation within tolerance", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 51, risk: "low" },
        { name: "B", pct: 51, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects empty slices array", () => {
    const result = validateAdapterOutput({ slices: [] });
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe("empty-slices");
  });

  it("rejects slices with Infinity pct", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: Infinity, risk: "low" }],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe("invalid-pct");
  });

  it("rejects a 95% total as incomplete", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: 95, risk: "low" }],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe("pct-sum-deviation");
  });

  it("rejects a 105% total as overcounted", () => {
    const result = validateAdapterOutput({
      slices: [
        { name: "A", pct: 55, risk: "low" },
        { name: "B", pct: 50, risk: "medium" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings[0].code).toBe("pct-sum-deviation");
  });

  it("rejects a 94% total as incomplete", () => {
    const result = validateAdapterOutput({
      slices: [{ name: "A", pct: 94, risk: "low" }],
    });
    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("pct-sum-deviation");
  });

  it("warns when upstream source data is older than the adapter policy allows", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { sourceTimestamp: 1_000, freshnessMode: "verified" },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
        now: 1_000 + 4 * 86400,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "stale-source-data")).toBe(true);
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

  it("rejects source timestamps beyond the future skew window", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { sourceTimestamp: 1_000 + 601, freshnessMode: "verified" },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
        now: 1_000,
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("future-source-timestamp");
  });

  it("allows source timestamps within the future skew window", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { sourceTimestamp: 1_000 + 600, freshnessMode: "verified" },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
        now: 1_000,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "future-source-timestamp")).toBe(false);
  });

  it("rejects redemption source timestamps beyond the future skew window", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: {
          freshnessMode: "not-applicable",
          redemption: { sourceTimestamp: 1_000 + 601 },
        },
      },
      {
        adapter: {
          key: "cap-vault",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].validation,
        },
        now: 1_000,
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("future-source-timestamp");
  });

  it("rejects independent outputs that claim verified freshness without a source timestamp", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { freshnessMode: "verified" },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("verified-freshness-missing-source-timestamp");
  });

  it("warns when independent outputs provide a timestamp without explicit freshnessMode", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { sourceTimestamp: 1_000 },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "freshness-mode-missing")).toBe(true);
  });

  it("warns when unverified independent outputs omit reason metadata", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { freshnessMode: "unverified" },
      },
      {
        adapter: {
          key: "reservoir",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.validation,
        },
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "freshness-reason-missing")).toBe(true);
  });

  it("rejects outputs whose freshnessMode is disallowed by the adapter definition", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { freshnessMode: "verified", sourceTimestamp: 1_000 },
      },
      {
        adapter: {
          key: "fx",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.fx.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.fx.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.fx.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.fx.validation,
        },
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "freshness-mode-disallowed")).toBe(true);
  });

  it("warns when material unknown exposure exceeds the adapter threshold", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { unknownExposurePct: 8 },
      },
      {
        adapter: {
          key: "reservoir",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.sharedSourceMode,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.reservoir.validation,
        },
      },
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "material-unknown-exposure")).toBe(true);
  });

  it("rejects invalid redemption capacity ratios", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { immediateRedeemableRatio: 1.5 },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("invalid-redemption-capacity-ratio");
  });

  it("rejects redemption capacity from adapters without capacity telemetry", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: { redemption: { capacityUsd: 10_000, capacityRatioOfSupply: 0.1 } },
      },
      {
        adapter: {
          key: "circle-transparency",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS["circle-transparency"].sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS["circle-transparency"].evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS["circle-transparency"].sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS["circle-transparency"].redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS["circle-transparency"].validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("unsupported-redemption-capacity-telemetry");
  });

  it("rejects direct redemption kind from proxy adapters", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: {
          redemption: {
            capacityUsd: 10_000,
            capacityRatioOfSupply: 0.1,
            capacityKind: "live-direct",
          },
        },
      },
      {
        adapter: {
          key: "ethena",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS.ethena.validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("redemption-capacity-kind-mismatch");
  });

  it("rejects invalid redemption route status telemetry", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: {
          redemption: {
            routeStatus: "halted",
          },
        },
      },
      {
        adapter: {
          key: "cap-vault",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("invalid-redemption-route-status");
  });

  it("rejects invalid redemption route status source telemetry", () => {
    const result = validateAdapterOutput(
      {
        slices: [{ name: "A", pct: 100, risk: "low" }],
        metadata: {
          redemption: {
            routeStatusSource: "spreadsheet",
          },
        },
      },
      {
        adapter: {
          key: "cap-vault",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.warnings[0]?.code).toBe("invalid-redemption-route-status-source");
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
      {
        adapter: {
          key: "cap-vault",
          fetch: async () => ({ slices: [] }),
          sourceModel: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sourceModel,
          evidenceClass: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].evidenceClass,
          sharedSourceMode: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].sharedSourceMode,
          redemptionTelemetry: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].redemptionTelemetry,
          validation: LIVE_RESERVE_ADAPTER_DEFINITIONS["cap-vault"].validation,
        },
      },
    );

    expect(result.valid).toBe(false);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("invalid-redemption-capacity-usd");
    expect(codes).toContain("invalid-redemption-route-status");
  });
});
