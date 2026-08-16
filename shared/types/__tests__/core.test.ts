import { describe, expect, it } from "vitest";
import { getFilterTags } from "../../lib/filter-tags";
import {
  DETAIL_PROVIDER_VALUES,
  DetailProviderSchema,
  STABLECOIN_STATUS_VALUES,
  type StablecoinMeta,
} from "../core";
import { OracleRiskBranchSchema } from "../stablecoin-meta-schemas";

function makeCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test-coin",
    name: "Test Coin",
    symbol: "TEST",
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: true,
      navToken: false,
    },
    ...overrides,
  } as StablecoinMeta;
}

describe("STABLECOIN_STATUS_VALUES", () => {
  it("includes every listing lifecycle phase", () => {
    expect(STABLECOIN_STATUS_VALUES).toEqual([
      "pre-launch",
      "active",
      "quarantined",
      "delisted",
      "frozen",
    ]);
  });
});

describe("DETAIL_PROVIDER_VALUES", () => {
  it("keeps the canonical detail provider enum and schema aligned", () => {
    expect(DETAIL_PROVIDER_VALUES).toEqual(["defillama", "coingecko", "commodity"]);
    expect(DetailProviderSchema.options).toEqual(DETAIL_PROVIDER_VALUES);
    expect(DetailProviderSchema.safeParse("coinmarketcap").success).toBe(false);
  });
});

describe("StablecoinMeta", () => {
  it("accepts a frozen coin with obituary block", () => {
    const meta: StablecoinMeta = {
      id: "fixture-frozen",
      name: "Fixture",
      symbol: "FXT",
      flags: { pegCurrency: "USD", governance: "centralized", backing: "fiat" } as never,
      status: "frozen",
      frozenAt: "2026-04-27",
      obituary: {
        causeOfDeath: "abandoned",
        deathDate: "2026-04",
        epitaph: "Closed without ceremony.",
        obituary: "FXT was sunset by its issuer in April 2026.",
        sourceUrl: "https://example.com/fxt-shutdown",
        sourceLabel: "Issuer announcement",
      },
    };
    expect(meta.status).toBe("frozen");
  });
});

describe("OracleRiskBranch liquidation state", () => {
  const branch = {
    id: "dead-oracle",
    label: "Dead oracle market",
    tier: "opaque-or-unknown" as const,
    summary: "The liquidation path was reviewed against deployed contracts.",
  };

  it("represents a reviewed uncallable path without pretending zero-second liquidation", () => {
    expect(OracleRiskBranchSchema.parse({ ...branch, liquidationState: "uncallable" })).toMatchObject({
      liquidationState: "uncallable",
    });
  });

  it("rejects a liquidation delay on an uncallable path", () => {
    expect(
      OracleRiskBranchSchema.safeParse({
        ...branch,
        liquidationState: "uncallable",
        liquidationDelaySec: 0,
      }).success,
    ).toBe(false);
  });
});

describe("getFilterTags — infrastructures", () => {
  it("emits no infrastructure tag when infrastructures is unset", () => {
    const tags = getFilterTags(makeCoin());
    expect(tags.some((t) => t.startsWith("infrastructure-"))).toBe(false);
  });

  it("emits no infrastructure tag for an empty infrastructures array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: [] }));
    expect(tags.some((t) => t.startsWith("infrastructure-"))).toBe(false);
  });

  it("emits infrastructure-liquity-v1 for a single-element liquity-v1 array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["liquity-v1"] }));
    expect(tags).toContain("infrastructure-liquity-v1");
    expect(tags).not.toContain("infrastructure-liquity-v2");
    expect(tags).not.toContain("infrastructure-m0");
  });

  it("emits infrastructure-m0 for a single-element m0 array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["m0"] }));
    expect(tags).toContain("infrastructure-m0");
  });

  it("emits one tag per element for a multi-element array", () => {
    const tags = getFilterTags(makeCoin({ infrastructures: ["liquity-v2", "m0"] }));
    expect(tags).toContain("infrastructure-liquity-v2");
    expect(tags).toContain("infrastructure-m0");
  });
});

describe("getFilterTags — tracked variants", () => {
  it("emits no variant tags when variant metadata is absent", () => {
    const tags = getFilterTags(makeCoin());
    expect(tags).not.toContain("variant-tracked");
    expect(tags).not.toContain("variant-pure-wrapper");
    expect(tags).not.toContain("variant-savings-passthrough");
    expect(tags).not.toContain("variant-strategy-vault");
    expect(tags).not.toContain("variant-risk-absorption");
    expect(tags).not.toContain("variant-bond-maturity");
  });

  it("emits tracked pure-wrapper tags", () => {
    const tags = getFilterTags(makeCoin({
      variantOf: "base-coin",
      variantKind: "pure-wrapper",
    }));

    expect(tags).toContain("variant-tracked");
    expect(tags).toContain("variant-pure-wrapper");
    expect(tags).not.toContain("variant-savings-passthrough");
    expect(tags).not.toContain("variant-strategy-vault");
    expect(tags).not.toContain("variant-risk-absorption");
    expect(tags).not.toContain("variant-bond-maturity");
  });

  it("emits tracked savings variant tags", () => {
    const tags = getFilterTags(makeCoin({
      variantOf: "base-coin",
      variantKind: "savings-passthrough",
    }));

    expect(tags).toContain("variant-tracked");
    expect(tags).toContain("variant-savings-passthrough");
    expect(tags).not.toContain("variant-strategy-vault");
    expect(tags).not.toContain("variant-risk-absorption");
    expect(tags).not.toContain("variant-bond-maturity");
  });

  it("emits tracked strategy variant tags", () => {
    const tags = getFilterTags(makeCoin({
      variantOf: "base-coin",
      variantKind: "strategy-vault",
    }));

    expect(tags).toContain("variant-tracked");
    expect(tags).toContain("variant-strategy-vault");
    expect(tags).not.toContain("variant-savings-passthrough");
    expect(tags).not.toContain("variant-risk-absorption");
    expect(tags).not.toContain("variant-bond-maturity");
  });

  it("emits tracked risk-absorption variant tags", () => {
    const tags = getFilterTags(makeCoin({
      variantOf: "base-coin",
      variantKind: "risk-absorption",
    }));

    expect(tags).toContain("variant-tracked");
    expect(tags).toContain("variant-risk-absorption");
    expect(tags).not.toContain("variant-savings-passthrough");
    expect(tags).not.toContain("variant-strategy-vault");
    expect(tags).not.toContain("variant-bond-maturity");
  });

  it("emits tracked bond variant tags", () => {
    const tags = getFilterTags(makeCoin({
      variantOf: "base-coin",
      variantKind: "bond-maturity",
    }));

    expect(tags).toContain("variant-tracked");
    expect(tags).toContain("variant-bond-maturity");
    expect(tags).not.toContain("variant-savings-passthrough");
    expect(tags).not.toContain("variant-strategy-vault");
    expect(tags).not.toContain("variant-risk-absorption");
  });
});

describe("getFilterTags — peg-group tags", () => {
  it("USD peg emits usd-peg and no group tag", () => {
    const tags = getFilterTags(makeCoin({ flags: { pegCurrency: "USD", governance: "centralized", backing: "rwa-backed", yieldBearing: false, rwa: true, navToken: false } }));
    expect(tags).toContain("usd-peg");
    expect(tags).not.toContain("commodity-peg");
    expect(tags).not.toContain("fiat-non-usd-peg");
  });

  it("GOLD peg emits gold-peg and commodity-peg group tag", () => {
    const tags = getFilterTags(makeCoin({ flags: { pegCurrency: "GOLD", governance: "centralized", backing: "rwa-backed", yieldBearing: false, rwa: true, navToken: false } }));
    expect(tags).toContain("gold-peg");
    expect(tags).toContain("commodity-peg");
    expect(tags).not.toContain("fiat-non-usd-peg");
  });

  it("EUR peg emits eur-peg and fiat-non-usd-peg group tag", () => {
    const tags = getFilterTags(makeCoin({ flags: { pegCurrency: "EUR", governance: "centralized", backing: "rwa-backed", yieldBearing: false, rwa: true, navToken: false } }));
    expect(tags).toContain("eur-peg");
    expect(tags).toContain("fiat-non-usd-peg");
    expect(tags).not.toContain("commodity-peg");
    expect(tags).not.toContain("usd-peg");
  });

  it("VAR (CPI) peg emits var-peg and fiat-non-usd-peg group tag", () => {
    const tags = getFilterTags(makeCoin({ flags: { pegCurrency: "VAR", governance: "centralized", backing: "algorithmic", yieldBearing: false, rwa: false, navToken: false } }));
    expect(tags).toContain("var-peg");
    expect(tags).toContain("fiat-non-usd-peg");
    expect(tags).not.toContain("commodity-peg");
  });

  it("OTHER peg emits other-peg and fiat-non-usd-peg group tag", () => {
    const tags = getFilterTags(makeCoin({ flags: { pegCurrency: "OTHER", governance: "centralized", backing: "rwa-backed", yieldBearing: false, rwa: true, navToken: false } }));
    expect(tags).toContain("other-peg");
    expect(tags).toContain("fiat-non-usd-peg");
    expect(tags).not.toContain("commodity-peg");
  });
});
