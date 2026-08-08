import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { adaptM0Collateral, adaptM0Current } from "../m0";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const SAMPLE_PAYLOAD = {
  data: {
    CollateralCurrent: {
      totalCash: 27_250_000_000,
      eligibleTreasuries: 137_500_000_000_000,
      nonEligibleTreasuries: 0,
      totalTreasuries: 137_500_000_000_000,
      totalTokenCollateral: 30_000_000_000_000,
      eligibleTokenCollateral: 30_000_000_000_000,
      nonEligibleTokenCollateral: 0,
      remainingTerm: 86,
      yieldToMaturity: 0.036,
    },
  },
};

describe("adaptM0Current", () => {
  it("keeps M0-backed curated tokenized collateral on the canonical low tier", () => {
    for (const coinId of ["musd-metamask", "ctusd-citrea", "usdat-saturn"]) {
      const tokenizedCollateral = TRACKED_META_BY_ID.get(coinId)?.reserves?.find(
        ({ name }) => name === "Tokenized treasury collateral",
      );
      expect(tokenizedCollateral, coinId).toMatchObject({ pct: 97.9, risk: "low" });
    }
  });

  it("converts the current collateral query into reserve slices", () => {
    const slices = adaptM0Current(SAMPLE_PAYLOAD);

    expect(slices).toEqual([
      { name: "Eligible U.S. Treasuries", pct: 70.6, risk: "very-low" },
      { name: "Tokenized treasury collateral", pct: 15.4, risk: "low" },
      { name: "Cash", pct: 14, risk: "very-low" },
    ]);
  });

  it("keeps the cash scaling assumption explicit in adapter metadata", async () => {
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "dashboard-graphql",
      },
      cashScaleApplied: 1_000,
      cashUnits: "milli-usd-to-usd",
      totalCashScaled: 27_250_000_000_000,
      normalizedReserveTotal: 194_750_000_000_000,
    });
    expect(result.metadata?.redemption).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("m0") ?? undefined }).valid).toBe(true);
  });

  it("uses the oldest collateral update timestamp when M0 exposes multiple candidates", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        collateralUpdateds: [
          {
            timestamp: "1776232804",
            blockTimestamp: "1776232835",
          },
        ],
        minterGateway_latestUpdateTimestampSnapshots: [
          {
            timestamp: "1776232835",
            value: "1776232835",
          },
        ],
      },
    });

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1776232804,
      earliestCollateralSourceTimestamp: 1776232804,
      latestCollateralSourceTimestamp: 1776232835,
      sourceTimestampSpreadSec: 31,
      timestampCandidateCount: 4,
    });
  });

  it("degrades when M0 timestamp candidates diverge materially", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        collateralUpdateds: [
          {
            timestamp: "1776225600",
            blockTimestamp: "1776232835",
          },
        ],
      },
    });

    expect(result.warnings?.some((warning) => warning.code === "source-timestamp-spread")).toBe(true);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1776225600,
      latestCollateralSourceTimestamp: 1776232835,
      sourceTimestampSpreadSec: 7235,
    });
  });

  it("rejects snapshots where raw cash is already near the treasury scale (upstream units changed)", () => {
    expect(() => adaptM0Collateral({
      data: {
        CollateralCurrent: {
          // Raw cash already scaled to reserve units — applying *1000 would 1000x the total.
          totalCash: 27_250_000_000_000,
          eligibleTreasuries: 137_500_000_000_000,
          nonEligibleTreasuries: 0,
          totalTreasuries: 137_500_000_000_000,
          totalTokenCollateral: 30_000_000_000_000,
          eligibleTokenCollateral: 30_000_000_000_000,
          nonEligibleTokenCollateral: 0,
          remainingTerm: 86,
          yieldToMaturity: 0.036,
        },
      },
    })).toThrow(/cash-scale anomaly/);
  });

  it("accepts zero cash without tripping the scale anomaly check", () => {
    const result = adaptM0Collateral({
      data: {
        CollateralCurrent: {
          totalCash: 0,
          eligibleTreasuries: 137_500_000_000_000,
          nonEligibleTreasuries: 0,
          totalTreasuries: 137_500_000_000_000,
          totalTokenCollateral: 30_000_000_000_000,
          eligibleTokenCollateral: 30_000_000_000_000,
          nonEligibleTokenCollateral: 0,
          remainingTerm: 86,
          yieldToMaturity: 0.036,
        },
      },
    });
    expect(result.metadata).toMatchObject({
      cashScaleApplied: 1_000,
      totalCashScaled: 0,
    });
  });

  // Observed 2026-08-08: protocol-api.m0.org answers every `Collateral*` query with
  // its gateway error envelope (`{"status":false,"statusCode":500,"message":"fetch
  // failed"}`) while the rest of the schema still resolves. HTTP 500 already throws
  // in the transport, but the envelope must never be adapted into a snapshot if the
  // gateway ever returns it with a 200, and a null resolver result must fail loudly.
  it("refuses the M0 gateway error envelope instead of publishing an empty snapshot", () => {
    expect(() => adaptM0Collateral(
      { status: false, statusCode: 500, message: "fetch failed", result: {} } as never,
    )).toThrow(/missing CollateralCurrent/);
  });

  it("refuses a null CollateralCurrent resolver result", () => {
    expect(() => adaptM0Collateral({ data: { CollateralCurrent: null } } as never))
      .toThrow(/missing CollateralCurrent/);
  });

  it("emits no publishable slices when every collateral bucket reports zero", () => {
    const result = adaptM0Collateral({
      data: {
        CollateralCurrent: {
          totalCash: 0,
          eligibleTreasuries: 0,
          nonEligibleTreasuries: 0,
          totalTreasuries: 0,
          totalTokenCollateral: 0,
          eligibleTokenCollateral: 0,
          nonEligibleTokenCollateral: 0,
          remainingTerm: 0,
          yieldToMaturity: 0,
        },
      },
    });

    expect(result.slices).toEqual([]);
    const adapter = getReserveAdapter("m0") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toContain("empty-slices");
  });
});
