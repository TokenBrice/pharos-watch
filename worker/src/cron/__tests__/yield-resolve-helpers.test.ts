import { describe, expect, it } from "vitest";
import {
  CHAIN_LENDING_TVL_FLOOR_USD,
  getLendingOpportunityAbsoluteTvlFloor,
  getRequiredLendingOpportunityTvlUsd,
} from "../yield-sync/resolve-helpers";

describe("lending opportunity TVL floors", () => {
  it("defines the exact small/pre-mainnet chain floor table", () => {
    expect(CHAIN_LENDING_TVL_FLOOR_USD).toEqual({
      aptos: 25_000,
      berachain: 25_000,
      cardano: 25_000,
      ink: 25_000,
      monad: 25_000,
      plasma: 25_000,
      solana: 25_000,
      stacks: 25_000,
      stellar: 25_000,
      sui: 25_000,
    });
  });

  it("uses chain-specific floors and keeps unknown chains on the default floor", () => {
    expect(getLendingOpportunityAbsoluteTvlFloor("Monad")).toBe(25_000);
    expect(getLendingOpportunityAbsoluteTvlFloor("Stellar")).toBe(25_000);
    expect(getLendingOpportunityAbsoluteTvlFloor("unknown-chain")).toBe(100_000);
  });

  it("keeps the stablecoin-supply-relative gate above the chain floor", () => {
    expect(
      getRequiredLendingOpportunityTvlUsd({
        stablecoinId: "usdc-circle",
        poolChain: "Monad",
        stablecoinSupplyById: new Map([["usdc-circle", 500_000_000]]),
      }),
    ).toBe(500_000);
  });
});
