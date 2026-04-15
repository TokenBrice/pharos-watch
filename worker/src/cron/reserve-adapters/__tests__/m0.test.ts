import { describe, expect, it } from "vitest";
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
      cashUnits: "milli-usd-to-micro-usd",
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
});
