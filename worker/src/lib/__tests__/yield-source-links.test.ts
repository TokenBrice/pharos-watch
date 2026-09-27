import { describe, expect, it } from "vitest";
import { resolveYieldSourceUrl } from "../yield-source-links";
import { LENDING_PROTOCOL_ALLOWLIST, LENDING_PROTOCOL_LABELS } from "../yield-config/yield-config";

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

  it("resolves Curve's scrvUSD source to the savings app route", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "crvusd-curve",
        sourceKey: "onchain:crvusd-curve:scrvusd-current-rate",
        yieldSource: "Curve Savings (scrvUSD)",
      }),
    ).toBe("https://www.curve.finance/crvusd/ethereum/scrvUSD");
  });

  it("falls back to an app link from stablecoin metadata when present", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "sdusd-dtrinity",
        sourceKey: "pool-dstake",
        yieldSource: "dTRINITY dStake (sdUSD)",
      }),
    ).toBe("https://app.dtrinity.org/");
  });

  it("links an identified DL pool instead of the issuer homepage", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usde-ethena",
        sourceKey: "66985a81-9c51-46ca-9977-42b4fe7bc6df",
        yieldSource: "Ethena staking (sUSDe)",
      }),
    ).toBe("https://defillama.com/yields/pool/66985a81-9c51-46ca-9977-42b4fe7bc6df");
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

  it("falls back to the linked child venue instead of the parent issuer", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdc-circle",
        sourceKey: "linked-variant:yvusdc-yearn:price-derived",
        yieldSource: "Yearn v3 USDC vault",
      }),
    ).toBe("https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204");
  });

  it("preserves a structured linked alternative's child-owned source link", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usde-ethena",
        sourceKey: "linked-variant:srusde-strata:structured-wrapper",
        yieldSource: "Strata senior USDe tranche",
      }),
    ).toBe("https://strata.markets");
  });

  it("does not trust a linked child that is unrelated to the requested parent", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdt-tether",
        sourceKey: "linked-variant:yvusdc-yearn:price-derived",
        yieldSource: "Unmapped wrapper source",
      }),
    ).not.toContain("yearn.fi");
  });

  it("selects Ethereum savings by key without mislinking Gnosis or a non-pool source", () => {
    const params = { stablecoinId: "zchf-frankencoin", yieldSource: "Frankencoin" };
    const ethereumSavingsPool = ["8b427366", "7bfb", "4c61", "88be", "8dc004fdc3da"].join("-");
    const gnosisSavingsPool = ["75ff7280", "15a9", "4111", "9b68", "25254d741529"].join("-");
    expect(resolveYieldSourceUrl({ ...params, sourceKey: ethereumSavingsPool }))
      .toBe("https://app.frankencoin.com/savings?chain=ethereum");
    expect(resolveYieldSourceUrl({ ...params, yieldSource: "Frankencoin Savings", sourceKey: gnosisSavingsPool }))
      .toBe(`https://defillama.com/yields/pool/${gnosisSavingsPool}`);
    expect(resolveYieldSourceUrl({ ...params, sourceKey: "price-derived" })).toBe("https://frankencoin.com");
  });

  it("preserves the linked child's pinned instrument link but identifies its other pools separately", () => {
    const params = { stablecoinId: "usdc-circle", yieldSource: "Yearn v3 USDC vault" };
    expect(resolveYieldSourceUrl({
      ...params,
      sourceKey: "linked-variant:yvusdc-yearn:7d89af7a-24c9-4292-aa38-7c71b05fbd6d",
    })).toBe("https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204");
    expect(resolveYieldSourceUrl({
      ...params,
      sourceKey: "linked-variant:yvusdc-yearn:a306885c-001e-4479-9ae8-459a56527bc1",
    })).toBe("https://defillama.com/yields/pool/a306885c-001e-4479-9ae8-459a56527bc1");
    expect(resolveYieldSourceUrl({
      ...params,
      stablecoinId: "usdt-tether",
      sourceKey: "linked-variant:yvusdc-yearn:7d89af7a-24c9-4292-aa38-7c71b05fbd6d",
    })).not.toContain("yearn.fi");
  });

  it("resolves real Pendle fixed-yield labels to the selected market and chain", () => {
    expect(resolveYieldSourceUrl({
      stablecoinId: "nonexistent-coin",
      sourceKey: "protocol-api:pendle:ethereum:0x0bef762d2094ac80821c657dea6783fc43435292",
      yieldSource: "Pendle fixed yield: Axis USDx",
    })).toBe("https://app.pendle.finance/trade/markets/0x0bef762d2094ac80821c657dea6783fc43435292/swap?view=pt&chain=ethereum");
  });

  it.each([
    "protocol-api:pendle:ethereum:0x123",
    "protocol-api:pendle:ethereum&other=value:0x0bef762d2094ac80821c657dea6783fc43435292",
    "66985a81-9c51-46ca-9977-42b4fe7bc6df/extra",
  ])("does not manufacture an instrument URL from malformed key %s", (sourceKey) => {
    expect(resolveYieldSourceUrl({
      stablecoinId: "nonexistent-coin",
      sourceKey,
      yieldSource: "Unmapped source",
    })).toBeNull();
  });

  it("keeps weighted groups on their owner app rather than inventing a single pool", () => {
    expect(resolveYieldSourceUrl({
      stablecoinId: "sdusd-dtrinity",
      sourceKey: "defillama-weighted:dtrinity-sdusd",
      yieldSource: "dTRINITY dStake (sdUSD)",
    })).toBe("https://app.dtrinity.org/");
  });

  it("keeps the issuer fallback for a non-pool source", () => {
    expect(resolveYieldSourceUrl({
      stablecoinId: "usde-ethena",
      sourceKey: "price-derived",
      yieldSource: "Price-derived",
    })).toBe("https://ethena.fi/");
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
