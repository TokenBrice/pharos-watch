import { describe, expect, it } from "vitest";

import {
  buildClientRegistryOutput,
  projectCoin,
  projectBlacklistStatus,
  projectGeniusProfile,
  projectMintAuthoritySummary,
  readCanonicalClientFields,
  readGeniusComplianceFields,
  readGeniusClientFields,
} from "../build-data/build-client-registry.mjs";
import {
  computeMintAuthorityScore,
  stablecoinToMintAuthorityScoringInput,
} from "../../shared/lib/mint-authority-scoring";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import {
  GENIUS_CLIENT_PROFILE_FIELDS,
  GENIUS_COMPLIANCE_PROFILE_FIELDS,
  STABLECOIN_CLIENT_META_FIELDS,
  type StablecoinClientMeta,
} from "../../shared/types/stablecoin-client-meta";

function projectedMintAuthorityInput(projected: Partial<StablecoinClientMeta> | undefined) {
  if (typeof projected?.id !== "string" || !projected.mintAuthoritySummary) return null;
  return { id: projected.id, ...projected.mintAuthoritySummary };
}

describe("client registry field contract", () => {
  it("projects only the compact listing class from the decision ledger", () => {
    const { slimCoins } = buildClientRegistryOutput();
    expect(slimCoins).toHaveLength(TRACKED_STABLECOINS.length);
    expect(slimCoins.every((coin) => typeof coin.listingClass === "string")).toBe(true);
    expect(slimCoins.find((coin) => coin.id === "susds-sky")?.listingClass).toBe("stablecoin-variant");
    expect(slimCoins.every((coin) => !("priceBasis" in coin) && !("exitMechanism" in coin))).toBe(true);
  });

  it("reads the canonical ordered field list from the shared TypeScript contract", () => {
    expect(readCanonicalClientFields()).toEqual([...STABLECOIN_CLIENT_META_FIELDS]);
  });

  it("reads the GENIUS client field list from the shared TypeScript contract", () => {
    expect(readGeniusClientFields()).toEqual([...GENIUS_CLIENT_PROFILE_FIELDS]);
  });

  it("reads the GENIUS compliance field list from the shared TypeScript contract", () => {
    expect(readGeniusComplianceFields()).toEqual([...GENIUS_COMPLIANCE_PROFILE_FIELDS]);
  });

  it("projects client registry fields in canonical order", () => {
    const coin = {
      id: "usdc-circle",
      name: "USDC",
      symbol: "USDC",
      oneLiner: "A dollar-backed stablecoin.",
      marketAvailability: "market-traded",
      priceBasis: "executable-market",
      exitMechanism: "secondary-market",
      flags: {
        pegCurrency: "USD",
        backing: "fiat",
        governance: "centralized",
      },
      pegMechanism: "fiat-backed",
      mechanismArchetype: "fiat-backed",
      mechanismArchetypeReview: {
        disposition: "resolved",
        reviewedAt: "2026-07-13",
        reviewer: "test",
        rationale: "The reviewed mechanism is fiat-backed.",
        sources: [{ label: "Docs", url: "https://example.com/docs" }],
      },
      implementationLaunchDate: "2018-09-26",
      archetypeOverride: false,
      geckoId: "usd-coin",
      protocolSlug: "circle",
      variantOf: null,
      variantKind: null,
      status: "active",
      listingStatusReview: {
        reviewedAt: "2026-07-15",
        reviewer: "test",
        rationale: "Admitted for runtime publication.",
        evidence: [{ label: "Policy", url: "https://example.com/policy" }],
      },
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

    expect(Object.keys(projectCoin(coin, readCanonicalClientFields()))).toEqual([...STABLECOIN_CLIENT_META_FIELDS]);
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
            canRaiseCap: "unknown",
            capDescription: "Daily cap",
            modulesOrGuardsStatus: "none-detected",
            safe: {
              owners: ["0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"],
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
      confidence: "verified",
      controls: [
        {
          authorityType: "safe",
          directMintAbility: "direct",
          threshold: 2,
          signerCount: 3,
          timelockDelaySec: 86_400,
          canRaiseCap: "unknown",
          modulesOrGuardsStatus: "none-detected",
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("Issuer minter");
    expect(JSON.stringify(projected)).not.toContain("Long reviewer evidence");
    expect(JSON.stringify(projected)).not.toContain("Control-level evidence");
    expect(JSON.stringify(projected)).not.toContain("Should not ship");
    expect(JSON.stringify(projected)).not.toContain("Daily cap");
    expect(JSON.stringify(projected)).not.toContain("0x0000000000000000000000000000000000000001");
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

  it("keeps only GENIUS status in the global client projection and projects full compliance evidence separately", () => {
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
        foreignExceptionEvidence: {
          summary: "Foreign exception posture is not applicable for a domestic issuer.",
          references: [
            {
              label: "Foreign exception source",
              url: "https://example.com/foreign-exception",
              sourceKind: "federal-regulator",
            },
          ],
        },
        enforcementStatus: "no-public-action-found",
        daspOfferSaleStatus: "not-yet-restricted",
        reserveDisclosurePresent: true,
        reserveDisclosureUrl: "https://example.com/reserves",
        redemptionPolicyPresent: true,
        monthlyAttestationPresent: true,
        latestReportDate: "2026-05-01",
        notes: "Rendered compliance note.",
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
    const complianceProfile = projectGeniusProfile(coin.genius, readGeniusComplianceFields());

    expect(projectGeniusProfile(null)).toBeNull();
    expect(projected.genius).toEqual({
      authorizationStatus: "no-public-authorization-found",
    });
    expect(JSON.stringify(projected)).not.toContain("Long applicability basis stays server-side");
    expect(JSON.stringify(projected)).not.toContain("Long negative evidence review stays server-side");
    expect(complianceProfile).toEqual({
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
      foreignExceptionEvidence: {
        summary: "Foreign exception posture is not applicable for a domestic issuer.",
        references: [
          {
            label: "Foreign exception source",
            url: "https://example.com/foreign-exception",
            sourceKind: "federal-regulator",
          },
        ],
      },
      enforcementStatus: "no-public-action-found",
      daspOfferSaleStatus: "not-yet-restricted",
      reserveDisclosurePresent: true,
      reserveDisclosureUrl: "https://example.com/reserves",
      redemptionPolicyPresent: true,
      monthlyAttestationPresent: true,
      latestReportDate: "2026-05-01",
      notes: "Rendered compliance note.",
      references: [{ label: "Disclosure", url: "https://example.com/genius", sourceKind: "issuer-disclosure" }],
      negativeEvidenceReview: {
        sourcesChecked: ["OCC public releases"],
        summary: "Long negative evidence review stays server-side.",
        reviewer: "pharos",
        reviewedAt: "2026-05-27",
      },
      reviewer: "pharos",
      reviewedAt: "2026-05-27",
    });
  });

  it("returns no mint-authority summary when the source profile is absent", () => {
    expect(projectMintAuthoritySummary({ id: "unknown" })).toBeUndefined();
  });

  it("keeps projected mint-authority summaries score-equivalent with full metadata", () => {
    const clientFields = readCanonicalClientFields();
    const projectedById = new Map(
      TRACKED_STABLECOINS.map((coin) => [coin.id, projectCoin(coin, clientFields)] as const),
    );
    const fullResolver = (id: string) => stablecoinToMintAuthorityScoringInput(TRACKED_META_BY_ID.get(id));
    const projectedResolver = (id: string) => {
      const projected = projectedById.get(id);
      return projectedMintAuthorityInput(projected);
    };

    for (const coin of TRACKED_STABLECOINS) {
      const full = computeMintAuthorityScore(stablecoinToMintAuthorityScoringInput(coin), fullResolver);
      const projected = projectedById.get(coin.id);
      const compact = computeMintAuthorityScore(projectedMintAuthorityInput(projected), projectedResolver);

      expect(compact.score, coin.id).toBe(full.score);
      expect(compact.rawScore, coin.id).toBe(full.rawScore);
      expect(compact.capsApplied, coin.id).toEqual(full.capsApplied);
      expect(compact.unresolvedReason, coin.id).toBe(full.unresolvedReason);
    }
  });
});
