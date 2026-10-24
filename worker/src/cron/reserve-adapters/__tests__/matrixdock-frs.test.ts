import { describe, expect, it } from "vitest";
import { adaptMatrixdockFrsState } from "../matrixdock-frs";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../../lib/live-reserves/store-shared";

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

  it.each([
    ["stale", NOW - LIVE_RESERVE_FRESHNESS_SEC - 1],
    ["future", NOW + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC + 1],
    ["missing", Number.NaN],
  ] as const)("withholds the global observation for a %s Sui clock", (_label, suiCheckpointTimestamp) => {
    expect(() => adaptMatrixdockFrsState({ ...STATE, suiCheckpointTimestamp }, PARAMS))
      .toThrow("Sui checkpoint timestamp");
  });

  it("uses the tighter coin age budget rather than the reserve-feed ceiling", () => {
    expect(() => adaptMatrixdockFrsState({
      ...STATE, suiCheckpointTimestamp: NOW - 3601,
    }, PARAMS, 3600)).toThrow("Sui checkpoint timestamp");
    expect(adaptMatrixdockFrsState({
      ...STATE, suiCheckpointTimestamp: NOW - 3600,
    }, PARAMS, 3600).metadata?.supplyTokens).toBeCloseTo(73_032.046081582, 6);
  });

  it("admits six-hour cross-chain skew and rejects a greater skew", () => {
    const coherent = { ...STATE, suiCheckpointTimestamp: NOW - 6 * 3600 };
    expect(adaptMatrixdockFrsState(coherent, PARAMS).metadata?.collateralizationRatio)
      .toBeCloseTo(0.998561644, 8);
    expect(() => adaptMatrixdockFrsState({
      ...coherent, suiCheckpointTimestamp: coherent.suiCheckpointTimestamp - 1,
    }, PARAMS)).toThrow("Ethereum/Sui observation skew");
    expect(() => adaptMatrixdockFrsState({
      ...STATE, observedBlock: { ...STATE.observedBlock, timestamp: NOW - 6 * 3600 - 1 },
    }, PARAMS)).toThrow("Ethereum/Sui observation skew");
  });

  it("admits the latest-state age boundary and keeps reserve-round age separate", () => {
    const boundary = NOW - LIVE_RESERVE_FRESHNESS_SEC;
    const result = adaptMatrixdockFrsState({
      ...STATE, suiCheckpointTimestamp: boundary,
      observedBlock: { ...STATE.observedBlock, timestamp: boundary },
      feedUpdatedAt: NOW - 60 * 86400 - 1,
    }, PARAMS);
    expect(result.metadata?.supplyTokens).toBeCloseTo(73_032.046081582, 6);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "quiet-reserve-feed", effect: "info" })]);
  });

  it.each([
    ["fresh round, supply moved", 0, 80_000_000_000n, []],
    ["old round, within tolerance", 60 * 86400 + 1, 25_000_000_000n, [{ code: "quiet-reserve-feed", effect: "info" }]],
    ["old round, supply moved", 60 * 86400 + 1, 80_000_000_000n, [{ code: "stale-reserve-feed", effect: "degraded" }]],
  ] as const)("degrades an old reserve round only when it no longer reconciles (%s)", (_label, ageSec, extraEthRaw, expected) => {
    const result = adaptMatrixdockFrsState({
      ...STATE, feedUpdatedAt: NOW - ageSec, ethSupplyRaw: STATE.ethSupplyRaw + extraEthRaw,
    }, PARAMS);
    expect(result.warnings ?? []).toEqual(expected.map((warning) => expect.objectContaining(warning)));
  });

  it("degrades when the reserve unit diverges from ozPerToken × supply", () => {
    const mismatched = { ...STATE, reserveRaw: 480n * STATE.reserveRaw }; // grains instead of oz
    const result = adaptMatrixdockFrsState(mismatched, PARAMS);
    expect(result.warnings?.some((warning) => warning.code === "reserve-unit-mismatch")).toBe(true);
  });

  it.each([
    { feedDecimals: 8 },
    { tokenDecimals: 8 },
    { suiDecimals: 8 },
  ])("throws when any observed decimals value is not 9", (override) => {
    expect(() => adaptMatrixdockFrsState({ ...STATE, ...override }, PARAMS)).toThrow("unexpected decimals");
  });

  it("throws when the feed answer is non-positive", () => {
    expect(() => adaptMatrixdockFrsState({ ...STATE, reserveRaw: 0n }, PARAMS)).toThrow("finite positive oz");
  });
});
