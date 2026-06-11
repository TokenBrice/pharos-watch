import { describe, expect, it } from "vitest";
import {
  MINT_ROUTE_SCORES,
  MINT_AUTHORITY_CAPS,
  computeMintAuthorityScore,
  isMintCapableAbility,
  resolveMintAuthorityScoreBand,
  scoreMintAuthorityControl,
  scoreMintAuthorityBounds,
  stablecoinToMintAuthorityScoringInput,
  type MintAuthorityScoringInput,
} from "../mint-authority-scoring";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../stablecoins/registry";

function input(overrides: Partial<MintAuthorityScoringInput> = {}): MintAuthorityScoringInput {
  return {
    id: "test-coin",
    mintPath: "permissioned-minter",
    authorityPosture: "partially-bounded-admin",
    confidence: "verified",
    controls: [
      {
        label: "Minter admin",
        authorityType: "safe",
        directMintAbility: "can-authorize",
        threshold: 3,
        signerCount: 5,
      },
    ],
    ...overrides,
  };
}

function score(overrides: Partial<MintAuthorityScoringInput> = {}) {
  return computeMintAuthorityScore(input(overrides));
}

describe("Mint Authority Score", () => {
  it("scores every route LUT row and treats unknown routes as NR", () => {
    for (const [mintPath, routeScore] of Object.entries(MINT_ROUTE_SCORES)) {
      const result = score({ mintPath: mintPath as MintAuthorityScoringInput["mintPath"] });
      expect(result.components.route, mintPath).toBe(routeScore);
      expect(result.score, mintPath).not.toBeNull();
    }

    expect(score({ mintPath: "unknown" }).score).toBeNull();
  });

  it("classifies mint-capable abilities", () => {
    expect(isMintCapableAbility("direct")).toBe(true);
    expect(isMintCapableAbility("can-authorize")).toBe(true);
    expect(isMintCapableAbility("cap-limited")).toBe(true);
    expect(isMintCapableAbility("upgrade-only")).toBe(true);
    expect(isMintCapableAbility("parameter-only")).toBe(false);
    expect(isMintCapableAbility("none")).toBe(false);
    expect(isMintCapableAbility("unknown")).toBe(false);
  });

  it("applies multisig topology math and caps multisigs at 80", () => {
    expect(scoreMintAuthorityControl(
      { authorityType: "safe", directMintAbility: "direct", threshold: 1, signerCount: 1 },
      "permissioned-minter",
    )).toBe(25);
    expect(scoreMintAuthorityControl(
      { authorityType: "safe", directMintAbility: "direct", threshold: 3, signerCount: 5 },
      "permissioned-minter",
    )).toBe(65);
    expect(scoreMintAuthorityControl(
      {
        authorityType: "safe",
        directMintAbility: "direct",
        threshold: 4,
        signerCount: 7,
        modulesOrGuardsStatus: "none-detected",
      },
      "permissioned-minter",
    )).toBe(80);
  });

  it("uses the weakest mint-capable control", () => {
    const result = score({
      controls: [
        { label: "Governor", authorityType: "dao-governor", directMintAbility: "can-authorize" },
        { label: "Emergency key", authorityType: "unknown", directMintAbility: "direct" },
        { label: "Parameter admin", authorityType: "eoa", directMintAbility: "parameter-only" },
      ],
    });

    expect(result.components.controller).toBe(25);
    expect(result.weakestControl?.label).toBe("Emergency key");
  });

  it("implements issuer-context and attested EOA custody rules", () => {
    const issuer = computeMintAuthorityScore(input({
      mintPath: "issuer-direct-mint",
      authorityPosture: "concentrated-admin",
      controls: [{ label: "Issuer key", authorityType: "eoa", directMintAbility: "direct" }],
    }));
    expect(issuer.components.controller).toBe(40);
    expect(issuer.capsApplied).not.toContain("eoa-cap");

    const defi = computeMintAuthorityScore(input({
      mintPath: "permissioned-minter",
      controls: [{ label: "Admin key", authorityType: "eoa", directMintAbility: "direct" }],
    }));
    expect(defi.components.controller).toBe(15);
    expect(defi.capsApplied).toContain("eoa-cap");
    expect(defi.score).toBeLessThanOrEqual(MINT_AUTHORITY_CAPS.eoa);

    const attested = computeMintAuthorityScore(input({
      mintPath: "permissioned-minter",
      controls: [
        {
          label: "Attested custody",
          authorityType: "eoa",
          directMintAbility: "direct",
          keyCustodyAttestation: {
            kind: "mpc",
            sources: [{ label: "Custody disclosure", url: "https://example.com/custody" }],
          },
        },
      ],
    }));
    expect(attested.components.controller).toBe(40);
    expect(attested.capsApplied).not.toContain("eoa-cap");
    expect(attested.weakestControl?.custodyLabel).toBe("single-key address - MPC-attested");
  });

  it("scores bounds from cap-limited controls and cap-raise authority", () => {
    expect(scoreMintAuthorityBounds([], "none-resolved")).toBe(100);
    expect(scoreMintAuthorityBounds([], "partially-bounded-admin")).toBe(50);
    expect(scoreMintAuthorityBounds(
      [{ authorityType: "safe", directMintAbility: "direct" }],
      "partially-bounded-admin",
    )).toBe(30);
    expect(scoreMintAuthorityBounds(
      [
        { authorityType: "safe", directMintAbility: "cap-limited", canRaiseCap: true },
        { authorityType: "dao-governor", directMintAbility: "upgrade-only" },
      ],
      "partially-bounded-admin",
    )).toBe(75);
    expect(scoreMintAuthorityBounds(
      [
        { authorityType: "safe", directMintAbility: "cap-limited", canRaiseCap: false },
        { authorityType: "dao-governor", directMintAbility: "upgrade-only" },
      ],
      "partially-bounded-admin",
    )).toBe(85);
  });

  it("applies incident, unbounded, and confidence caps with traces", () => {
    const incident = score({
      authorityPosture: "unbounded-or-compromised",
      mintIncidents: [
        {
          date: "2026-03-22",
          summary: "Unauthorized mint route exploited.",
          sources: [{ label: "Incident", url: "https://example.com/incident" }],
        },
      ],
    });
    expect(incident.score).toBe(10);
    expect(incident.capsApplied).toContain("incident-cap");

    const unbounded = score({ authorityPosture: "unbounded-or-compromised" });
    expect(unbounded.score).toBe(25);
    expect(unbounded.capsApplied).toContain("unbounded-cap");

    const manual = computeMintAuthorityScore(input({
      mintPath: "immutable-user-collateralized",
      authorityPosture: "none-resolved",
      confidence: "manual-review",
      controls: [],
    }));
    expect(manual.score).toBe(85);
    expect(manual.capsApplied).toContain("confidence-cap");
  });

  it("resolves inherited wrapper scores without letting wrappers outscore parents", () => {
    const parent = input({
      id: "parent",
      mintPath: "immutable-user-collateralized",
      authorityPosture: "none-resolved",
      controls: [],
    });
    const wrapper = input({
      id: "wrapper",
      mintPath: "wrapped-or-variant-inherited",
      inheritedFrom: "parent",
      controls: [{ label: "Wrapper key", authorityType: "eoa", directMintAbility: "direct" }],
    });
    const resolver = (id: string) => (id === "parent" ? parent : null);
    const parentScore = computeMintAuthorityScore(parent, resolver);
    const wrapperScore = computeMintAuthorityScore(wrapper, resolver);

    expect(parentScore.score).toBe(100);
    expect(wrapperScore.inheritedFromId).toBe("parent");
    expect(wrapperScore.score).toBeLessThanOrEqual(parentScore.score!);
    expect(wrapperScore.capsApplied).toContain("eoa-cap");
  });

  it("returns NR for missing parents, cycles, and unknown confidence", () => {
    expect(computeMintAuthorityScore(input({ confidence: "unknown" })).score).toBeNull();
    expect(computeMintAuthorityScore(input({
      mintPath: "wrapped-or-variant-inherited",
      inheritedFrom: "missing",
    }), () => null).unresolvedReason).toBe("parent-not-found");

    const cyclic = input({
      id: "cycle",
      mintPath: "wrapped-or-variant-inherited",
      inheritedFrom: "cycle",
    });
    expect(computeMintAuthorityScore(cyclic, () => cyclic).unresolvedReason).toBe("inheritance-cycle");
  });

  it("maps score bands at the approved thresholds", () => {
    expect(resolveMintAuthorityScoreBand(80)).toBe("hardened");
    expect(resolveMintAuthorityScoreBand(65)).toBe("governed");
    expect(resolveMintAuthorityScoreBand(50)).toBe("managed");
    expect(resolveMintAuthorityScoreBand(35)).toBe("concentrated");
    expect(resolveMintAuthorityScoreBand(34)).toBe("exposed");
    expect(resolveMintAuthorityScoreBand(null)).toBeNull();
  });

  it("scores the current tracked registry without inherited children outscoring parents", () => {
    const resolver = (id: string) => stablecoinToMintAuthorityScoringInput(TRACKED_META_BY_ID.get(id));

    for (const coin of TRACKED_STABLECOINS) {
      const result = computeMintAuthorityScore(stablecoinToMintAuthorityScoringInput(coin), resolver);
      expect(result.score == null || (result.score >= 0 && result.score <= 100), coin.id).toBe(true);

      if (coin.mintAuthority?.mintPath === "wrapped-or-variant-inherited" && coin.mintAuthority.inheritedFrom) {
        const parent = TRACKED_META_BY_ID.get(coin.mintAuthority.inheritedFrom);
        const parentResult = computeMintAuthorityScore(stablecoinToMintAuthorityScoringInput(parent), resolver);
        if (result.score != null && parentResult.score != null) {
          expect(result.score, coin.id).toBeLessThanOrEqual(parentResult.score);
        }
      }
    }
  });
});
