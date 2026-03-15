import { describe, expect, it } from "vitest";
import { resolveYieldSourceUrl } from "../yield-source-links";

describe("resolveYieldSourceUrl", () => {
  it("prefers curated protocol links for discovered lending sources", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "lusd-liquity",
        sourceKey: "aave-v3:lusd",
        yieldSource: "Aave v3",
      }),
    ).toBe("https://app.aave.com/");
  });

  it("uses source-specific overrides before coin-level fallbacks", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "lusd-liquity",
        sourceKey: "bprotocol-lqty-only",
        yieldSource: "B.Protocol Stability Pool (LQTY only)",
      }),
    ).toBe("https://app.bprotocol.org/liquity");
  });

  it("falls back to an app link from stablecoin metadata when present", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "dusd-dtrinity",
        sourceKey: "pool-dstake",
        yieldSource: "dTRINITY dStake (sdUSD)",
      }),
    ).toBe("https://app.dtrinity.org/mint/dusd/");
  });

  it("falls back to the stablecoin website when no deeper source link is curated", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usde-ethena",
        sourceKey: "66985a81-9c51-46ca-9977-42b4fe7bc6df",
        yieldSource: "Ethena staking (sUSDe)",
      }),
    ).toBe("https://ethena.fi/");
  });

  it("returns null when no curated link and no metadata link exists", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "nonexistent-coin",
        sourceKey: "unknown-pool",
        yieldSource: "Unknown Protocol",
      }),
    ).toBeNull();
  });

  it("resolves URL for newly added lending protocols", () => {
    // Verify at least one of the newly added protocols resolves
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdc-circle",
        sourceKey: "radiant-v2:usdc",
        yieldSource: "Radiant v2",
      }),
    ).toBe("https://app.radiant.capital/");
  });
});
