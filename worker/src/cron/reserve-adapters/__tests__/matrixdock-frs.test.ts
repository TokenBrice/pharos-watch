import { describe, expect, it } from "vitest";
import { adaptMatrixdockFrsState } from "../matrixdock-frs";

const PARAMS = {
  label: "Physical silver bars (LBMA Good Delivery, Asian vault custody)",
  risk: "medium" as const,
  feedAddress: "0x20377b5e38e0e992bbdcf3502ec72ded6a5e28ab",
  tokenAddress: "0x123ffe0a3c62878dcbee2742227dc8990058d9e1",
  suiCoinType: "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM",
};

const NOW = 1_789_000_000;

const STATE = {
  reserveRaw: 72_927_000_000_000n, // 72,927.000 troy oz
  feedDecimals: 9,
  roundId: 7n,
  feedUpdatedAt: 1_785_813_539,
  ethSupplyRaw: 33_036_714_433_829n,
  ozPerTokenRaw: 998_561_644n, // 0.998561644 oz/token
  tokenDecimals: 9,
  suiSupplyRaw: 39_995_331_647_753n,
  suiDecimals: 9,
  suiCheckpoint: 320_550_547,
  suiCheckpointTimestamp: NOW,
  observedBlock: { chain: "ethereum", number: 12_345, timestamp: NOW },
  nowSec: NOW,
};

describe("adaptMatrixdockFrsState", () => {
  it("pins the feed unit to ozPerToken and publishes the oz-per-token coverage", () => {
    const result = adaptMatrixdockFrsState(STATE, PARAMS);

    expect(result.slices).toEqual([
      { sourceKey: "matrixdock-frs:silver", name: PARAMS.label, pct: 100, risk: "medium" },
    ]);
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(72_927, 6);
    expect(result.metadata?.supplyTokens).toBeCloseTo(73_032.046081582, 6);
    // reserve oz / total supply == ozPerToken
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.998561644, 8);
    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: 12_345, timestamp: NOW });
    expect(result.warnings).toBeUndefined();
  });

  it("degrades when the reserve unit diverges from ozPerToken × supply", () => {
    const mismatched = { ...STATE, reserveRaw: 480n * STATE.reserveRaw }; // grains instead of oz
    const result = adaptMatrixdockFrsState(mismatched, PARAMS);
    expect(result.warnings?.some((warning) => warning.code === "reserve-unit-mismatch")).toBe(true);
  });

  it("throws on a non-9 decimals contract", () => {
    expect(() => adaptMatrixdockFrsState({ ...STATE, feedDecimals: 8 }, PARAMS)).toThrow("unexpected decimals");
  });

  it("throws when the feed answer is non-positive", () => {
    expect(() => adaptMatrixdockFrsState({ ...STATE, reserveRaw: 0n }, PARAMS)).toThrow("finite positive oz");
  });
});
