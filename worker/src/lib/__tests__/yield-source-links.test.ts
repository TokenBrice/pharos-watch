import { describe, expect, it } from "vitest";
import { resolveYieldSourceUrl } from "../yield-source-links";
import { LENDING_PROTOCOL_ALLOWLIST, LENDING_PROTOCOL_LABELS } from "../../cron/yield-config";

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

  it("resolves curated protocol-native yield links before metadata fallbacks", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usbd-bima",
        sourceKey: "protocol-api:bima-susbd",
        yieldSource: "BIMA savings (sUSBD)",
      }),
    ).toBe("https://bima.money/earn");
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

  it("matches prefixed protocol labels before falling back to coin metadata", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdc-circle",
        sourceKey: "protocol-api:morpho-vault:ethereum:0xabc",
        yieldSource: "Morpho: Gauntlet USDC Prime",
      }),
    ).toBe("https://app.morpho.org/");
  });

  it("matches chain-qualified labels emitted by chain-aware source keys", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdc-circle",
        sourceKey: "aave-v3-onchain:base",
        yieldSource: "Aave v3 (base)",
      }),
    ).toBe("https://app.aave.com/");
  });

  it("resolves Kong-prefixed labels to the Kong app", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdc-circle",
        sourceKey: "protocol-api:kong:ethereum:0xabc",
        yieldSource: "Kong: Steakhouse USDC",
      }),
    ).toBe("https://kong.yearn.fi/");
  });

  it("resolves the K3 sBOLD source to Liquity's dedicated earn route", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "bold-liquity",
        sourceKey: "protocol-api:k3:ethereum:0x23346b04a7f55b8760e5860aa5a77383d63491cd",
        yieldSource: "K3: sBOLD",
      }),
    ).toBe("https://liquity.app/earn/sbold");
  });

  it("resolves the explicit K3 sBOLD wrapper label to Liquity's dedicated earn route", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "bold-liquity",
        sourceKey: "dac71f4f-7b97-463a-b19f-9796c56c21f1",
        yieldSource: "Liquity Stability Pool (via K3 sBOLD)",
      }),
    ).toBe("https://liquity.app/earn/sbold");
  });

  it("covers every allowlisted lending protocol label with a curated source URL", () => {
    for (const protocol of LENDING_PROTOCOL_ALLOWLIST) {
      const label = LENDING_PROTOCOL_LABELS[protocol];
      expect(label).toBeTruthy();
      expect(
        resolveYieldSourceUrl({
          stablecoinId: "nonexistent-coin",
          sourceKey: `${protocol}:test`,
          yieldSource: label,
        }),
      ).toMatch(/^https?:\/\//);
    }
  });
});
