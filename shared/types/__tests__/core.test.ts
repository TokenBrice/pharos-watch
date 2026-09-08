import { describe, expect, it } from "vitest";
import { getFilterTags } from "../../lib/filter-tags";
import {
  DETAIL_PROVIDER_VALUES,
  DetailProviderSchema,
  STABLECOIN_STATUS_VALUES,
  type StablecoinMeta,
} from "../core";
import { OracleRiskBranchSchema } from "../stablecoin-meta-schemas";
import { StablecoinMetaSourceAssetSchema } from "@shared/lib/stablecoins/schema";

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
  };
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
    const meta = {
      ...makeCoin({ id: "fixture-frozen", name: "Fixture", symbol: "FXT" }),
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
    expect(StablecoinMetaSourceAssetSchema.parse(meta).obituary).toEqual(meta.obituary);
    const result = StablecoinMetaSourceAssetSchema.safeParse({
      ...meta,
      obituary: { ...meta.obituary, sourceUrl: "not-a-url" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["obituary", "sourceUrl"] }));
    }
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
    expect(getFilterTags(makeCoin()).filter((tag) => tag.startsWith("variant-"))).toEqual([]);
  });

  it.each([
    "pure-wrapper", "savings-passthrough", "strategy-vault", "risk-absorption", "bond-maturity",
  ] as const)("emits exactly the tracked and %s tags", (variantKind) => {
    const tags = getFilterTags(makeCoin({ variantOf: "base-coin", variantKind }));
    expect(tags.filter((tag) => tag.startsWith("variant-")).sort())
      .toEqual([`variant-${variantKind}`, "variant-tracked"].sort());
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
