import { describe, expect, it } from "vitest";

import {
  projectCoin,
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
      canBeBlacklistedSource: "issuer docs",
      commodityOunces: null,
      infrastructures: ["circle"],
      mica: null,
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

  it("projects only the mint-authority client summary and excludes review evidence", () => {
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
      confidence: "verified",
      summary: "Issuer minter can create supply through a documented role.",
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
          timelockDelaySec: 86400,
          capDescription: "Daily cap",
          modulesOrGuardsStatus: "none-detected",
        },
      ],
      sources: [
        { label: "Docs", url: "https://example.com/docs" },
        { label: "Role", url: "https://example.com/role" },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("Long reviewer evidence");
    expect(JSON.stringify(projected)).not.toContain("Control-level evidence");
    expect(JSON.stringify(projected)).not.toContain("Should not ship");
    expect(JSON.stringify(projected)).not.toContain("0x0000000000000000000000000000000000000002");
  });

  it("returns no mint-authority summary when the source profile is absent", () => {
    expect(projectMintAuthoritySummary({ id: "unknown" })).toBeUndefined();
  });
});
