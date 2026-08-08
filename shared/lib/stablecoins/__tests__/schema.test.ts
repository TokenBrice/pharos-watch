import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStablecoinMetaAssets,
  StablecoinComplianceSidecarSchema,
  StablecoinMintAuthoritySidecarSchema,
  StablecoinRiskReviewSidecarSchema,
} from "../schema";
import { OracleRiskProfileSchema } from "../../../types/stablecoin-meta-schemas";

const baseFlags = {
  pegCurrency: "USD",
  governance: "centralized",
  backing: "rwa-backed",
  yieldBearing: false,
  rwa: true,
  navToken: false,
};

function makeCoin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    flags: baseFlags,
    ...overrides,
  };
}

describe("StablecoinMeta schema — MiCA profile", () => {
  it("requires source references for assessed in-scope MiCA statuses", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mica-negative",
        mica: {
          status: "non-compliant",
          tokenType: "EMT",
        },
      }),
    ], "fixture")).toThrow(/source reference/);
  });

  it("allows explicit MiCA out-of-scope rows without references", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mica-out-of-scope",
        mica: {
          status: "out-of-scope",
        },
      }),
    ], "fixture")).not.toThrow();
  });

  it("rejects MiCA out-of-scope rows with in-scope classification fields", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mica-out-of-scope-token-type",
        mica: {
          status: "out-of-scope",
          tokenType: "EMT",
        },
      }),
    ], "fixture")).toThrow(/out-of-scope/);
  });
});

const mintAuthoritySource = {
  label: "Contract docs",
  url: "https://example.com/mint-authority",
};

function makeMintAuthority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mintPath: "issuer-direct-mint",
    authorityPosture: "partially-bounded-admin",
    confidence: "verified",
    summary: "Issuer minting is controlled by a reviewed Safe.",
    controls: [
      {
        chain: "ethereum",
        address: "0x1234567890abcdef1234567890abcdef12345678",
        label: "Issuer mint Safe",
        role: "direct-minter",
        authorityType: "safe",
        directMintAbility: "direct",
        threshold: 2,
        signerCount: 3,
        modulesOrGuardsStatus: "none-detected",
        safe: {
          owners: [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333",
          ],
          threshold: 2,
          observedBlock: 123456,
          source: "onchain",
        },
      },
    ],
    review: {
      sources: [mintAuthoritySource],
      evidence: "The verified contract source and Safe state identify the mint authority.",
      reviewer: "Fixture Reviewer",
      reviewedAt: "2026-05-24",
    },
    ...overrides,
  };
}

describe("StablecoinMeta schema — frozen status", () => {
  it("accepts a well-formed frozen coin", () => {
    const json = [
      {
        id: "fixture-frozen",
        name: "Fixture Frozen",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        frozenAt: "2026-04-27",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "Closed without ceremony.",
          obituary: "FXT was sunset by its issuer.",
          sourceUrl: "https://example.com/x",
          sourceLabel: "Issuer announcement",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a frozen coin missing the obituary block", () => {
    const json = [
      {
        id: "fixture-frozen-bad",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        frozenAt: "2026-04-27",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary/);
  });

  it("rejects a frozen coin missing frozenAt", () => {
    const json = [
      {
        id: "fixture-frozen-bad-2",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "frozen",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "x",
          obituary: "x",
          sourceUrl: "https://example.com/x",
          sourceLabel: "x",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/frozenAt/);
  });

  it("rejects an active coin with a stray obituary field", () => {
    const json = [
      {
        id: "fixture-active-bad",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        status: "active",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-04",
          epitaph: "x",
          obituary: "x",
          sourceUrl: "https://example.com/x",
          sourceLabel: "x",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary is only allowed when status is frozen/);
  });
});

describe("StablecoinMeta schema — issuer wind-down evidence", () => {
  it("accepts a dated issuer announcement with a source URL", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        windDownAnnouncedAt: "2026-05-24",
        windDownSourceUrl: "https://issuer.example.com/wind-down",
      }),
    ], "fixture")).not.toThrow();
  });

  it("rejects malformed wind-down dates and source URLs", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({ windDownAnnouncedAt: "2026/05/24" }),
    ], "fixture")).toThrow(/windDownAnnouncedAt/);
    expect(() => parseStablecoinMetaAssets([
      makeCoin({ windDownSourceUrl: "issuer.example.com/wind-down" }),
    ], "fixture")).toThrow(/windDownSourceUrl/);
  });
});

describe("StablecoinMeta schema — listing lifecycle status", () => {
  it("accepts a quarantined record with a dated manual review", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        status: "quarantined",
        listingStatusReview: {
          changedAt: "2026-07-15",
          reason: "Runtime price and supply coverage require remediation.",
          reviewBy: "2026-08-15",
        },
      }),
    ], "fixture")).not.toThrow();
  });

  it("rejects quarantine without a review deadline", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        status: "quarantined",
        listingStatusReview: {
          changedAt: "2026-07-15",
          reason: "Runtime coverage is unresolved.",
        },
      }),
    ], "fixture")).toThrow(/reviewBy/);
  });

  it("accepts a delisted record with durable source evidence", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        status: "delisted",
        listingStatusReview: {
          changedAt: "2026-07-15",
          reason: "The asset is outside the stablecoin listing scope.",
          source: {
            label: "Issuer product terms",
            url: "https://example.com/product-terms",
          },
        },
      }),
    ], "fixture")).not.toThrow();
  });

  it("rejects lifecycle review metadata on an active row", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        status: "active",
        listingStatusReview: {
          changedAt: "2026-07-15",
          reason: "Stray review metadata.",
        },
      }),
    ], "fixture")).toThrow(/only allowed/);
  });
});

describe("StablecoinMeta schema — blacklistability review", () => {
  const explicitStatuses = [true, false, "possible"] as const;

  for (const status of explicitStatuses) {
    it(`rejects explicit canBeBlacklisted=${String(status)} without review evidence`, () => {
      const json = [
        {
          id: `fixture-blacklist-${String(status)}`,
          name: "Fixture",
          symbol: "FXT",
          flags: baseFlags,
          canBeBlacklisted: status,
        },
      ];
      expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/blacklistabilityReview/);
    });
  }

  it("rejects the retired Dilutable blacklistability status", () => {
    const json = [
      {
        id: "fixture-blacklist-dilutable",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        canBeBlacklisted: "dilutable",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow();
  });

  it("rejects manual inherited blacklistability metadata", () => {
    const json = [
      {
        id: "fixture-blacklist-inherited",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        canBeBlacklisted: "inherited",
        blacklistabilityReview: {
          reviewedStatus: "inherited",
          sourceFreeRationale: "fixture",
          evidence: "Fixture evidence for inherited rejection.",
          reviewer: "Fixture",
          reviewedAt: "2026-05-12",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/canBeBlacklisted/);
  });

  it("accepts inferred blacklistability review metadata without an override", () => {
    const json = [
      {
        id: "fixture-blacklist-inferred",
        name: "Fixture",
        symbol: "FXT",
        flags: baseFlags,
        blacklistabilityReview: {
          reviewedStatus: "inherited",
          sourceFreeRationale: "Resolved from Pharos stablecoin metadata.",
          evidence: "Fixture evidence for inferred upstream exposure.",
          reviewer: "Fixture",
          reviewedAt: "2026-05-12",
        },
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it.each(["2026-99-99", "2026-02-30", "2025-00-12"])(
    "rejects impossible review date %s",
    (reviewedAt) => {
      expect(() => parseStablecoinMetaAssets([
        makeCoin({
          id: "fixture-blacklist-invalid-date",
          blacklistabilityReview: {
            reviewedStatus: "inherited",
            sourceFreeRationale: "Resolved from Pharos stablecoin metadata.",
            evidence: "Fixture evidence for inferred upstream exposure.",
            reviewer: "Fixture",
            reviewedAt,
          },
        }),
      ], "fixture")).toThrow(/Expected YYYY-MM-DD/);
    },
  );

  it("requires review status to match the override and include a source or rationale", () => {
    const base = {
      id: "fixture-blacklist-review",
      name: "Fixture",
      symbol: "FXT",
      flags: baseFlags,
      canBeBlacklisted: true,
    };

    expect(() => parseStablecoinMetaAssets([{
      ...base,
      blacklistabilityReview: {
        reviewedStatus: false,
        sourceFreeRationale: "fixture",
        evidence: "Fixture evidence for mismatch.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
      },
    }], "fixture")).toThrow(/reviewedStatus/);

    expect(() => parseStablecoinMetaAssets([{
      ...base,
      blacklistabilityReview: {
        reviewedStatus: true,
        evidence: "Fixture evidence without source.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
      },
    }], "fixture")).toThrow(/sources/);
  });
});

describe("StablecoinMeta schema — GENIUS profile", () => {
  const issuerDisclosure = {
    label: "Issuer disclosure",
    url: "https://example.com/genius",
    sourceKind: "issuer-disclosure",
    sourceDate: "2026-05-27",
  };

  it("accepts a source-backed issuer-announced GENIUS watch profile", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-genius-intent",
        genius: {
          applicability: "apparent-payment-stablecoin",
          authorizationStatus: "issuer-announced-intent",
          issuerPathway: "unknown",
          issuerEntity: "Fixture Issuer, N.A.",
          issuerDomicile: "United States",
          licensingRegulator: "OCC",
          primaryFederalRegulator: "OCC",
          foreignExceptionStatus: "not-applicable",
          enforcementStatus: "no-public-action-found",
          daspOfferSaleStatus: "not-yet-restricted",
          reserveDisclosurePresent: true,
          reserveDisclosureUrl: "https://example.com/reserves",
          redemptionPolicyPresent: true,
          monthlyAttestationPresent: true,
          latestReportDate: "2026-05-01",
          references: [issuerDisclosure],
          reviewer: "Fixture Reviewer",
          reviewedAt: "2026-05-27",
        },
      }),
    ], "fixture")).not.toThrow();
  });

  it("rejects official GENIUS authorization claims without a regulator reference", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-genius-official",
        genius: {
          applicability: "apparent-payment-stablecoin",
          authorizationStatus: "ppsi-approved",
          issuerPathway: "federal-qualified-nonbank",
          references: [issuerDisclosure],
          reviewer: "Fixture Reviewer",
          reviewedAt: "2026-05-27",
        },
      }),
    ], "fixture")).toThrow(/official authorization/);
  });

  it("requires no-public-authorization-found to include a dated negative evidence review", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-genius-negative",
        genius: {
          applicability: "apparent-payment-stablecoin",
          authorizationStatus: "no-public-authorization-found",
          issuerPathway: "unknown",
          reviewer: "Fixture Reviewer",
          reviewedAt: "2026-05-27",
        },
      }),
    ], "fixture")).toThrow(/negative evidence review/);
  });

  it("rejects unknown nested GENIUS fields", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-genius-strict",
        genius: {
          applicability: "apparent-payment-stablecoin",
          authorizationStatus: "issuer-announced-intent",
          issuerPathway: "unknown",
          references: [issuerDisclosure],
          reviewer: "Fixture Reviewer",
          reviewedAt: "2026-05-27",
          complianceScore: 100,
        },
      }),
    ], "fixture")).toThrow(/complianceScore/);
  });
});

describe("StablecoinMeta schema — mint authority", () => {
  it("accepts a verified Safe mint authority profile", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-safe",
        mintAuthority: makeMintAuthority(),
      }),
    ], "fixture")).not.toThrow();
  });

  it("requires verified and probable profiles to include a source link", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-source",
        mintAuthority: makeMintAuthority({
          review: {
            sourceFreeRationale: "Internal review found no public source for this fixture.",
            evidence: "The fixture intentionally omits a source link for confidence validation.",
            reviewer: "Fixture Reviewer",
            reviewedAt: "2026-05-24",
          },
        }),
      }),
    ], "fixture")).toThrow(/source link/);
  });

  it("accepts verified profiles whose public source links live on controls", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-control-source",
        mintAuthority: makeMintAuthority({
          review: {
            sourceFreeRationale: "Profile source links are attached to the reviewed control row.",
            evidence: "The fixture keeps source links at control level for validation.",
            reviewer: "Fixture Reviewer",
            reviewedAt: "2026-05-24",
          },
          controls: [
            {
              chain: "ethereum",
              address: "0x1234567890abcdef1234567890abcdef12345678",
              label: "Issuer mint Safe",
              role: "direct-minter",
              authorityType: "safe",
              directMintAbility: "direct",
              threshold: 2,
              signerCount: 3,
              modulesOrGuardsStatus: "none-detected",
              sources: [mintAuthoritySource],
              safe: {
                owners: [
                  "0x1111111111111111111111111111111111111111",
                  "0x2222222222222222222222222222222222222222",
                  "0x3333333333333333333333333333333333333333",
                ],
                threshold: 2,
                observedBlock: 123456,
                source: "onchain",
              },
            },
          ],
        }),
      }),
    ], "fixture")).not.toThrow();
  });

  it("requires privileged non-unknown profiles to include controls", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-controls",
        mintAuthority: makeMintAuthority({
          controls: [],
        }),
      }),
    ], "fixture")).toThrow(/requires at least one control/);
  });

  it("validates Safe threshold and signer counts", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-threshold",
        mintAuthority: makeMintAuthority({
          controls: [
            {
              label: "Broken Safe",
              role: "direct-minter",
              authorityType: "safe",
              directMintAbility: "direct",
              threshold: 4,
              signerCount: 3,
              modulesOrGuardsStatus: "none-detected",
              safe: {
                owners: ["owner-1", "owner-2", "owner-3"],
                threshold: 4,
                observedBlock: 123456,
                source: "onchain",
              },
            },
          ],
        }),
      }),
    ], "fixture")).toThrow(/threshold/);
  });

  it("requires verified Safe controls to include modules or guards status", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-modules",
        mintAuthority: makeMintAuthority({
          controls: [
            {
              label: "Incomplete Safe",
              role: "direct-minter",
              authorityType: "safe",
              directMintAbility: "direct",
              threshold: 2,
              signerCount: 3,
              safe: {
                owners: ["owner-1", "owner-2", "owner-3"],
                threshold: 2,
                observedBlock: 123456,
                source: "onchain",
              },
            },
          ],
        }),
      }),
    ], "fixture")).toThrow(/modulesOrGuardsStatus/);
  });

  it("caps unknown Safe module or guard status below probable confidence", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-unknown-modules",
        mintAuthority: makeMintAuthority({
          confidence: "probable",
          controls: [
            {
              label: "Unresolved Safe",
              role: "direct-minter",
              authorityType: "safe",
              directMintAbility: "direct",
              modulesOrGuardsStatus: "unknown",
              safe: {
                source: "manual",
              },
            },
          ],
        }),
      }),
    ], "fixture")).toThrow(/caps confidence/);
  });

  it("keeps none-resolved posture limited to non-privileged mint paths and controls", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-none",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          confidence: "verified",
          controls: [
            {
              label: "Not actually passive",
              role: "direct-minter",
              authorityType: "contract",
              directMintAbility: "can-authorize",
            },
          ],
        }),
      }),
    ], "fixture")).toThrow(/none-resolved/);
  });

  it("lets none-resolved-mint keep non-mint control domains that none-resolved forbids", () => {
    const controls = [
      {
        label: "Upgrade admin",
        role: "proxy-admin" as const,
        authorityType: "contract" as const,
        directMintAbility: "upgrade-only" as const,
        evidence: "The fixture models an upgrade admin that holds no mint ability.",
      },
    ];
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-scoped",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved-mint",
          confidence: "verified",
          controls,
        }),
      }),
    ], "fixture")).not.toThrow();

    // The same controls under the whole-of-chain value stay rejected.
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-scoped",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          confidence: "verified",
          controls,
        }),
      }),
    ], "fixture")).toThrow(/none-resolved cannot include mint-capable controls/);
  });

  it("rejects none-resolved-mint when a control can mint or authorize minting", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-scoped-minter",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved-mint",
          confidence: "verified",
          controls: [
            {
              label: "Real minter",
              role: "direct-minter",
              authorityType: "contract",
              directMintAbility: "direct",
            },
          ],
        }),
      }),
    ], "fixture")).toThrow(/none-resolved-mint cannot include a control that can mint/);
  });

  it("requires none-resolved-mint to use a non-privileged mintPath", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-scoped-path",
        mintAuthority: makeMintAuthority({
          mintPath: "issuer-direct-mint",
          authorityPosture: "none-resolved-mint",
          confidence: "verified",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/none-resolved-mint requires a non-privileged mintPath/);
  });

  it("binds scored economic-control claims to review evidence", () => {
    const withoutEvidence = (overrides: Record<string, unknown>) =>
      makeMintAuthority({
        ...overrides,
        review: {
          sources: [mintAuthoritySource],
          evidence: "The reviewer checked this.",
          reviewer: "Fixture Reviewer",
          reviewedAt: "2026-05-24",
        },
      });

    expect(() => parseStablecoinMetaAssets([
      makeCoin({ id: "fixture-recon-bare", mintAuthority: withoutEvidence({ reconciliation: "periodic" }) }),
    ], "fixture")).toThrow(/reconciliation periodic requires a review evidence sentence/);

    expect(() => parseStablecoinMetaAssets([
      makeCoin({ id: "fixture-super-bare", mintAuthority: withoutEvidence({ supervision: "prudential" }) }),
    ], "fixture")).toThrow(/supervision prudential requires a review evidence sentence/);

    // Both claims at once are named together in a single issue.
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-both-bare",
        mintAuthority: withoutEvidence({ reconciliation: "continuous", supervision: "prudential" }),
      }),
    ], "fixture")).toThrow(/reconciliation continuous and supervision prudential/);
  });

  it("leaves non-scoring reconciliation and supervision values unbound", () => {
    // `unknown`, `not-applicable` and `none` record an absence rather than a
    // claim, so they must stay authorable without an evidence sentence.
    for (const overrides of [
      { reconciliation: "not-applicable" },
      { reconciliation: "unknown" },
      { supervision: "none" },
      { supervision: "unknown" },
    ]) {
      expect(() => parseStablecoinMetaAssets([
        makeCoin({
          id: "fixture-inert-claim",
          mintAuthority: makeMintAuthority({
            ...overrides,
            review: {
              sources: [mintAuthoritySource],
              evidence: "The reviewer checked this.",
              reviewer: "Fixture Reviewer",
              reviewedAt: "2026-05-24",
            },
          }),
        }),
      ], "fixture")).not.toThrow();
    }
  });

  it("accepts a scored economic-control claim carrying a substantive evidence sentence", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-recon-evidenced",
        mintAuthority: makeMintAuthority({
          reconciliation: "periodic",
          supervision: "prudential",
          review: {
            sources: [mintAuthoritySource],
            evidence:
              "Monthly attestations reconcile circulating supply against segregated reserves, and the issuer holds an e-money licence from the named competent authority.",
            reviewer: "Fixture Reviewer",
            reviewedAt: "2026-05-24",
          },
        }),
      }),
    ], "fixture")).not.toThrow();
  });

  it("keeps unknown mint paths paired with unknown posture unless evidence supports compromise", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-unknown",
        mintAuthority: makeMintAuthority({
          mintPath: "unknown",
          authorityPosture: "bounded-admin",
          confidence: "unknown",
          controls: undefined,
          review: {
            sourceFreeRationale: "No public source was available for this fixture.",
            evidence: "The fixture intentionally models an unknown mint authority review.",
            reviewer: "Fixture Reviewer",
            reviewedAt: "2026-05-24",
          },
        }),
      }),
    ], "fixture")).toThrow(/mintPath unknown/);
  });

  it("validates inherited mint authority references at catalog scope", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "parent-usd",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "wrapped-usd",
        variantOf: "parent-usd",
        variantKind: "savings-passthrough",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          inheritedFrom: "parent-usd",
          controls: undefined,
        }),
      }),
    ], "fixture")).not.toThrow();

    expect(() => parseStablecoinMetaAssets([
      makeCoin({ id: "other-usd" }),
      makeCoin({
        id: "missing-parent-wrapper",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "unknown",
          confidence: "manual-review",
          inheritedFrom: "ghost-usd",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/inheritedFrom/);
  });

  it("requires wrapped mint authority profiles to publish inheritedFrom explicitly", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "parent-usd",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "implicit-wrapper-usd",
        variantOf: "parent-usd",
        variantKind: "savings-passthrough",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/requires inheritedFrom/);
  });

  it("rejects active variants without an explicit mint authority review", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "variant-without-mint-review",
        variantOf: "parent-usd",
        variantKind: "savings-passthrough",
      }),
    ], "fixture")).toThrow(/active variants require mintAuthority review/);
  });

  it("rejects active wrappers inheriting from frozen mint authority parents", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "frozen-parent-usd",
        status: "frozen",
        frozenAt: "2026-06-01",
        obituary: {
          causeOfDeath: "abandoned",
          deathDate: "2026-06",
          epitaph: "Archived.",
          obituary: "Archived fixture.",
          sourceUrl: "https://example.com/frozen-parent",
          sourceLabel: "Fixture",
        },
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "active-wrapper-of-frozen-usd",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          inheritedFrom: "frozen-parent-usd",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/must reference an active tracked stablecoin/);
  });

  it("rejects mint authority inheritance cycles and runtime-depth-limit chains", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "cycle-a",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "partially-bounded-admin",
          inheritedFrom: "cycle-b",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "cycle-b",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "partially-bounded-admin",
          inheritedFrom: "cycle-a",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/must not form a cycle/);

    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "depth-0",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "partially-bounded-admin",
          inheritedFrom: "depth-1",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "depth-1",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "partially-bounded-admin",
          inheritedFrom: "depth-2",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "depth-2",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "partially-bounded-admin",
          inheritedFrom: "depth-3",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "depth-3",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "partially-bounded-admin",
          inheritedFrom: "depth-4",
          controls: undefined,
        }),
      }),
      makeCoin({
        id: "depth-4",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/depth/);
  });

  it("requires wrapper none-resolved posture to inherit from a none-resolved parent", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "admin-parent-usd",
        mintAuthority: makeMintAuthority(),
      }),
      makeCoin({
        id: "wrapped-admin-usd",
        variantOf: "admin-parent-usd",
        variantKind: "savings-passthrough",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          inheritedFrom: "admin-parent-usd",
          controls: undefined,
        }),
      }),
    ], "fixture")).toThrow(/parent is none-resolved/);
  });
});

describe("StablecoinMeta schema — variantOf / pegReferenceId coherence (Rule 1)", () => {
  it("accepts a coin with matching variantOf and pegReferenceId", () => {
    const json = [
      makeCoin({
        id: "variant-parent-ok",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
      {
        id: "fixture-variant-ok",
        name: "Fixture Variant",
        symbol: "FVT",
        flags: baseFlags,
        variantOf: "variant-parent-ok",
        variantKind: "savings-passthrough",
        pegReferenceId: "variant-parent-ok",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          inheritedFrom: "variant-parent-ok",
          controls: undefined,
        }),
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a coin with variantOf only (no pegReferenceId)", () => {
    const json = [
      makeCoin({
        id: "variant-parent-no-peg",
        mintAuthority: makeMintAuthority({
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: undefined,
        }),
      }),
      {
        id: "fixture-variant-no-peg",
        name: "Fixture Variant No Peg",
        symbol: "FVP",
        flags: baseFlags,
        variantOf: "variant-parent-no-peg",
        variantKind: "savings-passthrough",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          inheritedFrom: "variant-parent-no-peg",
          controls: undefined,
        }),
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a coin with pegReferenceId only (no variantOf)", () => {
    const json = [
      {
        id: "fixture-peg-only",
        name: "Fixture Peg Only",
        symbol: "FPG",
        flags: baseFlags,
        pegReferenceId: "usdt-tether",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a coin where variantOf and pegReferenceId disagree", () => {
    const json = [
      {
        id: "fixture-variant-mismatch",
        name: "Fixture Mismatch",
        symbol: "FMM",
        flags: baseFlags,
        variantOf: "usdt-tether",
        variantKind: "savings-passthrough",
        pegReferenceId: "usdc-circle",
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/pegReferenceId/);
  });
});

// Rule 2 (reserves wrapper depType requires coinId) is NOT enforced in the schema because
// srusd-reservoir has depType "wrapper" without coinId — its wrapped parent (rusd-reservoir)
// is not a tracked coin. Curator fix needed before this invariant can be added.
// See: shared/data/stablecoins/coins/srusd-reservoir.json reserves[0]
describe("StablecoinMeta schema — reserves depType valid cases", () => {
  it("accepts a reserves entry with depType 'wrapper' and coinId set", () => {
    const json = [
      {
        id: "fixture-wrapper-ok",
        name: "Fixture Wrapper OK",
        symbol: "FWO",
        flags: baseFlags,
        reserves: [
          { name: "Parent token shares", pct: 100, risk: "low", coinId: "usdt-tether", depType: "wrapper" },
        ],
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a reserves entry with depType 'collateral' and no coinId (real-world asset)", () => {
    const json = [
      {
        id: "fixture-collateral-no-coinid",
        name: "Fixture Collateral",
        symbol: "FCC",
        flags: baseFlags,
        reserves: [
          { name: "Tokenized Treasury Bonds", pct: 100, risk: "low", depType: "collateral" },
        ],
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects curated reserves that do not describe a full composition", () => {
    const json = [
      {
        id: "fixture-reserves-partial",
        name: "Fixture Partial Reserves",
        symbol: "FPR",
        flags: baseFlags,
        reserves: [
          { name: "USDC", pct: 40, risk: "low" },
          { name: "Treasuries", pct: 20, risk: "very-low" },
        ],
      },
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/Reserve composition must sum to 100%/);
  });
});

describe("StablecoinMeta schema — error formatting", () => {
  it("appends a hidden-issue count when more than 8 issues are surfaced", () => {
    // Ten fully-empty objects each fail multiple required-field checks, so the
    // aggregate ZodError carries well over 8 issues.
    const json = Array.from({ length: 10 }, () => ({}));
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/… \(\+\d+ more\)/);
  });

  it("does not append a suffix when 8 or fewer issues exist", () => {
    // A single object missing only its required top-level fields stays at or
    // below the 8-issue cap, so no truncation suffix should appear.
    let message = "";
    try {
      parseStablecoinMetaAssets([{ id: "fixture-few-issues" }], "fixture");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/more\)/);
  });
});

describe("Stablecoin research sidecar schemas", () => {
  const mintAuthority = {
    mintPath: "unknown",
    authorityPosture: "unknown",
    confidence: "unknown",
    summary: "The fixture mint authority remains unresolved.",
    review: {
      sourceFreeRationale: "Schema fixture without external research.",
      evidence: "The fixture records enough evidence text for strict schema validation.",
      reviewer: "test",
      reviewedAt: "2026-07-09",
    },
  };

  const blacklistabilityReview = {
    reviewedStatus: true,
    sourceFreeRationale: "Schema fixture without external research.",
    evidence: "The fixture models a direct blacklistability control surface.",
    reviewer: "test",
    reviewedAt: "2026-07-09",
  };

  it("accepts each supported research-domain shape", () => {
    expect(StablecoinMintAuthoritySidecarSchema.safeParse({
      id: "fixture-usd",
      mintAuthority,
    }).success).toBe(true);
    expect(StablecoinComplianceSidecarSchema.safeParse({
      id: "fixture-usd",
      mica: { status: "out-of-scope" },
      genius: {
        applicability: "unclear",
        authorizationStatus: "unknown",
        issuerPathway: "unknown",
        reviewer: "test",
        reviewedAt: "2026-07-09",
      },
    }).success).toBe(true);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      canBeBlacklisted: true,
      blacklistabilityReview,
      oracleRisk: {
        tier: "opaque-or-unknown",
        summary: "The fixture oracle design remains unknown.",
      },
      bridgeRouteRisk: {
        tier: "opaque-or-unknown",
        summary: "The fixture bridge route remains unknown.",
        reviewedAt: "2026-07-09",
        reviewer: "test",
        confidence: "unknown",
        sourceFreeRationale: "Schema fixture without external research.",
      },
    }).success).toBe(true);
  });

  it("requires at least one owned field in optional multi-field domains", () => {
    expect(StablecoinComplianceSidecarSchema.safeParse({ id: "fixture-usd" }).success).toBe(false);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({ id: "fixture-usd" }).success).toBe(false);
  });

  it("requires branch rows when a reviewed oracle applicability decision says they are required", () => {
    const baseProfile = {
      tier: "standard-external",
      summary: "The fixture records a multi-market collateral oracle design.",
      branchApplicability: {
        disposition: "branches-required",
        reviewedAt: "2026-07-13",
        reviewer: "test",
        rationale: "Each collateral market has independent oracle and liquidation behavior.",
        sources: [{ label: "Docs", url: "https://example.com/docs" }],
      },
    };

    expect(OracleRiskProfileSchema.safeParse(baseProfile).success).toBe(false);
    expect(
      OracleRiskProfileSchema.safeParse({
        ...baseProfile,
        branchModel: "multi-branch",
        branches: [
          {
            id: "eth",
            label: "ETH",
            tier: "standard-external",
            summary: "The branch fixture supplies a valid independently reviewed feed path.",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a not-applicable oracle applicability decision on a multi-branch profile", () => {
    expect(
      OracleRiskProfileSchema.safeParse({
        tier: "standard-external",
        summary: "The fixture records a multi-market collateral oracle design.",
        branchModel: "multi-branch",
        branches: [
          {
            id: "eth",
            label: "ETH",
            tier: "standard-external",
            summary: "The branch fixture supplies a valid independently reviewed feed path.",
          },
        ],
        branchApplicability: {
          disposition: "not-applicable",
          reviewedAt: "2026-07-13",
          reviewer: "test",
          rationale: "This intentionally contradictory fixture checks schema validation.",
          sources: [{ label: "Docs", url: "https://example.com/docs" }],
        },
      }).success,
    ).toBe(false);
  });

  it("requires route-level evidence for reviewed bridge deployments", () => {
    const parsed = StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      bridgeRouteRisk: {
        tier: "issuer-native-burn-mint",
        summary: "The fixture has an issuer-native deployment.",
        reviewedAt: "2026-07-13",
        reviewer: "test",
        confidence: "verified",
        sources: [{ label: "Issuer docs", url: "https://example.com/issuer" }],
        routes: [
          {
            id: "ethereum:0xabc",
            destinationChain: "ethereum",
            contractAddress: "0xabc",
            protocol: "Issuer",
            issuanceModel: "native-issuance",
            routeClass: "native",
            riskTier: "issuer-native-burn-mint",
            semantics: "native-mint",
            scope: "canonical",
            reviewDisposition: "reviewed",
            observedAt: "2026-07-13",
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain("route-level sources");
  });

  it("accepts an evidence-honest unresolved bridge deployment", () => {
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      bridgeRouteRisk: {
        tier: "opaque-or-unknown",
        summary: "The fixture bridge route remains unresolved.",
        reviewedAt: "2026-07-13",
        reviewer: "test",
        confidence: "unknown",
        sourceFreeRationale: "No route-level deployment evidence was available.",
        routes: [
          {
            id: "base:0xdef",
            destinationChain: "base",
            contractAddress: "0xdef",
            protocol: "unresolved route",
            issuanceModel: "unknown",
            routeClass: "unknown",
            riskTier: "opaque-or-unknown",
            semantics: "unknown",
            scope: "unknown",
            reviewDisposition: "unresolved",
            reviewNote: "The route semantics and scope remain unresolved.",
          },
        ],
      },
    }).success).toBe(true);
  });

  it("keeps explicit blacklistability overrides coupled to their review", () => {
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      canBeBlacklisted: true,
    }).success).toBe(false);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      canBeBlacklisted: false,
      blacklistabilityReview,
    }).success).toBe(false);
  });

  it("rejects unknown keys in every research sidecar", () => {
    expect(StablecoinMintAuthoritySidecarSchema.safeParse({
      id: "fixture-usd",
      mintAuthority,
      notes: "not owned here",
    }).success).toBe(false);
    expect(StablecoinComplianceSidecarSchema.safeParse({
      id: "fixture-usd",
      mica: { status: "out-of-scope" },
      jurisdiction: { country: "US" },
    }).success).toBe(false);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      blacklistabilityReview,
      governanceQuality: "single-entity",
    }).success).toBe(false);
  });
});

describe("StablecoinMeta schema — real fixture smoke tests", () => {
  const fixtures = [
    "usdt-tether",
    "asusdf-astherus",
    "susds-sky",
    "stusd-stoneyield",
  ];

  for (const fixture of fixtures) {
    it(`parses ${fixture}.json without error`, () => {
      const path = join(__dirname, "../../../../shared/data/stablecoins/coins", `${fixture}.json`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads fixed fixture IDs from the local whitelist.
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      expect(() => parseStablecoinMetaAssets([raw], fixture)).not.toThrow();
    });
  }
});

describe("StablecoinMeta schema — PoR / composition lockstep", () => {
  const reserves = [{ name: "US Treasury bills", pct: 100, risk: "low" }];
  const latestReport = {
    periodEnd: "2026-06-30",
    publishedAt: "2026-07-10",
    assuranceMethod: "examination",
    scope: "assets-only",
    liabilityReconciliation: "none",
    reviewer: "Fixture Reviewer",
    confidence: "verified",
    sources: [{ label: "Attestation", url: "https://example.com/attestation" }],
  };
  const reserveReview = (compositionAsOf: string) => ({
    reviewedAt: "2026-07-12",
    reviewer: "Fixture Reviewer",
    confidence: "verified",
    sources: [{ label: "Attestation", url: "https://example.com/attestation" }],
    rationale: "The fixture models a curated composition drawn from the attestation.",
    compositionBasis: "Attestation breakdown table",
    compositionAsOf,
    scope: "full-composition",
    knownUnknownExposure: "None identified.",
    knownUnknownExposurePct: 0,
  });
  const coin = (compositionAsOf: string) =>
    makeCoin({
      id: "fixture-lockstep",
      reserves,
      proofOfReserves: { type: "self-reported", url: "https://example.com/por", latestReport },
      reserveReview: reserveReview(compositionAsOf),
    });

  it("accepts a composition dated to the report period end", () => {
    expect(() => parseStablecoinMetaAssets([coin("2026-06-30")], "fixture")).not.toThrow();
  });

  it("rejects a composition dated after the report period end", () => {
    expect(() => parseStablecoinMetaAssets([coin("2026-07-12")], "fixture")).toThrow(/PoR lockstep/);
  });

  it("rejects a composition dated before the report period end", () => {
    expect(() => parseStablecoinMetaAssets([coin("2026-05-31")], "fixture")).toThrow(/PoR lockstep/);
  });

  it("stays silent when either side of the pair is absent", () => {
    const noComposition = makeCoin({
      id: "fixture-lockstep-no-composition",
      reserves,
      proofOfReserves: { type: "self-reported", url: "https://example.com/por", latestReport },
    });
    expect(() => parseStablecoinMetaAssets([noComposition], "fixture")).not.toThrow();

    const noReport = makeCoin({
      id: "fixture-lockstep-no-report",
      reserves,
      proofOfReserves: { type: "self-reported", url: "https://example.com/por" },
      reserveReview: reserveReview("2026-06-30"),
    });
    expect(() => parseStablecoinMetaAssets([noReport], "fixture")).not.toThrow();
  });
});
