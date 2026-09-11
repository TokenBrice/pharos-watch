import type { adaptCapVaultState } from "../cap-vault";

type AssetState = Parameters<typeof adaptCapVaultState>[0]["assets"][number];

export function makeCapAsset(overrides: Partial<AssetState> = {}): AssetState {
  return {
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    name: "USDC",
    risk: "low",
    decimals: 6,
    totalSupplied: 100,
    totalBorrowed: 0,
    available: 100,
    paused: false,
    pausedStatusUnavailable: false,
    ...overrides,
  };
}
