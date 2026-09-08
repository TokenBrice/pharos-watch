export function makeTimestampedYuzuPayload(reserves: Record<string, unknown> = {}) {
  return {
    collateralization: 1,
    ts: "1787848065315",
    reserves: {
      total_reserves: 1_000,
      total_supply: 1_000,
      exposure_split_ts: "2026.08.24 07:31:16 UTC",
      exposure_split: { Liquidity_Buffer: { "": 1_000 } },
      timeline: [{ ts: "1787600794262", reserves: 1_000 }],
      ...reserves,
    },
  };
}
