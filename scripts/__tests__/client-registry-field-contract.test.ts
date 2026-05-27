import { describe, expect, it } from "vitest";

import {
  projectCoin,
  projectBlacklistStatus,
  projectGeniusProfile,
  projectMintAuthoritySummary,
  readCanonicalClientFields,
} from "../build-data/build-client-registry.mjs";
import { STABLECOIN_CLIENT_META_FIELDS } from "../../shared/types/stablecoin-client-meta";

describe("client registry field contract", () => {
  it("reads the canonical ordered field list from the shared TypeScript contract", () => {
    expect(readCanonicalClientFields()).toEqual([...STABLECOIN_CLIENT_META_FIELDS]);
  });

  it("projects client registry fields in canonical order", () => {
    const coin = {
      id: "usdc-circle",
      name: "USDC",
      symbol: "USDC",
      oneLiner: "A dollar-backed stablecoin.",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      pegMechanism: "fiat-backed",
      mechanismArchetype: "fiat-backed",
      archetypeOverride: false,
      geckoId: "usd-coin",
      protocolSlug: "circle",
      variantOf: null,
      variantKind: null,
      status: "active",
      tags: ["major"],
      frozenAt: null,
      launchDate: "2018-09-26",
      announcedDate: "2018-05-15",
      expectedLaunchDate: null,
      launchPhase: "live",
      milestones: [],
      dateHistory: [],
      canBeBlacklisted: true,
      commodityOunces: null,
      infrastructures: ["circle"],
      mica: null,
      genius: null,
      yieldConfig: null,
      liveReservesConfig: null,
      proofOfReserves: null,
      reserves: [{ asset: "cash" }],
      collateral: "cash",
      collateralQuality: "rwa",
    };

    expect(Object.keys(projectCoin(coin, readCanonicalClientFields()))).toEqual([
      ...STABLECOIN_CLIENT_META_FIELDS,
    ]);
  });

  it("projects only the mint-authority coverage summary and excludes detail evidence", () => {
    const coin = {
      id: "minted-usd",
      name: "Minted USD",
      symbol: "MUSD",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      mintAuthority: {
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        summary: "Issuer minter can create supply through a documented role.",
        review: {
          sources: [{ label: "Docs", url: "https://example.com/docs" }],
          evidence: "Long reviewer evidence stays on the server-side metadata object.",
          reviewer: "pharos",
          reviewedAt: "2026-05-24",
          unresolvedQuestions: ["Should not ship"],
        },
        controls: [
          {
            chain: "ethereum",
            address: "0x0000000000000000000000000000000000000001",
            label: "Issuer minter",
            role: "direct-minter",
            authorityType: "safe",
            directMintAbility: "direct",
            threshold: 2,
            signerCount: 3,
            timelockDelaySec: 86_400,
            capDescription: "Daily cap",
            modulesOrGuardsStatus: "none-detected",
            safe: {
              owners: [
                "0x0000000000000000000000000000000000000002",
                "0x0000000000000000000000000000000000000003",
              ],
              source: "safe-api",
            },
            evidence: "Control-level evidence also stays server-side.",
            sources: [{ label: "Role", url: "https://example.com/role" }],
          },
        ],
      },
    };

    const projected = projectCoin(coin, readCanonicalClientFields());

    expect(projected.mintAuthoritySummary).toEqual({
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      controls: [{ authorityType: "safe", directMintAbility: "direct" }],
    });
    expect(JSON.stringify(projected)).not.toContain("Issuer minter can create supply");
    expect(JSON.stringify(projected)).not.toContain("Long reviewer evidence");
    expect(JSON.stringify(projected)).not.toContain("Control-level evidence");
    expect(JSON.stringify(projected)).not.toContain("Should not ship");
    expect(JSON.stringify(projected)).not.toContain("0x0000000000000000000000000000000000000002");
  });

  it("projects only the reviewed blacklist status and excludes review evidence", () => {
    const coin = {
      id: "freezable-usd",
      name: "Freezable USD",
      symbol: "FUSD",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      blacklistabilityReview: {
        reviewedStatus: "inherited",
        sources: [{ label: "Docs", url: "https://example.com/blacklist" }],
        evidence: "Long blacklist review evidence stays server-side.",
        reviewer: "pharos",
        reviewedAt: "2026-05-24",
      },
    };

    const projected = projectCoin(coin, readCanonicalClientFields());

    expect(projectBlacklistStatus(coin)).toBe("inherited");
    expect(projected.blacklistStatus).toBe("inherited");
    expect(JSON.stringify(projected)).not.toContain("Long blacklist review evidence");
    expect(JSON.stringify(projected)).not.toContain("https://example.com/blacklist");
    expect(JSON.stringify(projected)).not.toContain("2026-05-24");
  });

  it("projects only displayed GENIUS fields and excludes review evidence", () => {
    const coin = {
      id: "genius-usd",
      name: "GENIUS USD",
      symbol: "GUSD",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      genius: {
        applicability: "apparent-payment-stablecoin",
        applicabilityBasis: {
          summary: "Long applicability basis stays server-side.",
        },
        authorizationStatus: "no-public-authorization-found",
        issuerPathway: "unknown",
        issuerEntity: "Fixture Issuer",
        issuerDomicile: "United States",
        licensingRegulator: "OCC",
        primaryFederalRegulator: "OCC",
        stateRegulator: "NYDFS",
        foreignExceptionStatus: "not-applicable",
        enforcementStatus: "no-public-action-found",
        daspOfferSaleStatus: "not-yet-restricted",
        reserveDisclosurePresent: true,
        reserveDisclosureUrl: "https://example.com/reserves",
        redemptionPolicyPresent: true,
        monthlyAttestationPresent: true,
        latestReportDate: "2026-05-01",
        references: [{ label: "Disclosure", url: "https://example.com/genius", sourceKind: "issuer-disclosure" }],
        negativeEvidenceReview: {
          sourcesChecked: ["OCC public releases"],
          summary: "Long negative evidence review stays server-side.",
          reviewer: "pharos",
          reviewedAt: "2026-05-27",
        },
        reviewer: "pharos",
        reviewedAt: "2026-05-27",
      },
    };

    const projected = projectCoin(coin, readCanonicalClientFields());

    expect(projectGeniusProfile(null)).toBeNull();
    expect(projected.genius).toEqual({
      applicability: "apparent-payment-stablecoin",
      authorizationStatus: "no-public-authorization-found",
      issuerPathway: "unknown",
      issuerEntity: "Fixture Issuer",
      issuerDomicile: "United States",
      licensingRegulator: "OCC",
      stateRegulator: "NYDFS",
      reserveDisclosureUrl: "https://example.com/reserves",
      redemptionPolicyPresent: true,
      references: [{ label: "Disclosure", url: "https://example.com/genius" }],
    });
    expect(JSON.stringify(projected)).not.toContain("Long applicability basis");
    expect(JSON.stringify(projected)).not.toContain("Long negative evidence");
    expect(JSON.stringify(projected)).not.toContain("Rendered compliance note");
    expect(JSON.stringify(projected)).not.toContain("reserveDisclosurePresent");
    expect(JSON.stringify(projected)).not.toContain("monthlyAttestationPresent");
    expect(JSON.stringify(projected)).not.toContain("foreignExceptionStatus");
    expect(JSON.stringify(projected)).not.toContain("primaryFederalRegulator");
    expect(JSON.stringify(projected)).not.toContain("2026-05-01");
    expect(JSON.stringify(projected)).not.toContain("issuer-disclosure");
    expect(JSON.stringify(projected)).not.toContain("2026-05-27");
  });

  it("returns no mint-authority summary when the source profile is absent", () => {
    expect(projectMintAuthoritySummary({ id: "unknown" })).toBeUndefined();
  });
});
