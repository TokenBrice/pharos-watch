import { describe, expect, it } from "vitest";
import {
  MINT_ROUTE_SCORES,
  MINT_AUTHORITY_CAPS,
  MINT_AUTHORITY_INCIDENT_DECAY_YEARS,
  YEAR_MS,
  computeMintAuthorityScore,
  isMintCapableAbility,
  resolveMintAuthorityScoreBand,
  scoreMintAuthorityControl,
  scoreMintAuthorityBounds,
  stablecoinToMintAuthorityScoringInput,
  type MintAuthorityScoringInput,
} from "../mint-authority-scoring";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "../stablecoins/registry";
import { MINT_AUTHORITY_MINT_PATH_VALUES } from "../../types/core";

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

  it("keeps the route score table exhaustive for every direct scored route", () => {
    const directScoredRoutes = MINT_AUTHORITY_MINT_PATH_VALUES.filter(
      (mintPath) => mintPath !== "unknown" && mintPath !== "wrapped-or-variant-inherited",
    );

    expect(Object.keys(MINT_ROUTE_SCORES).sort()).toEqual([...directScoredRoutes].sort());
  });

  it("pins the weighted direct-profile formula", () => {
    const result = computeMintAuthorityScore(input());

    expect(result.components).toEqual({
      route: 50,
      controller: 65,
      bounds: 30,
      posture: 60,
    });
    expect(result.rawScore).toBe(55);
    expect(result.score).toBe(55);
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
    expect(
      scoreMintAuthorityControl(
        { authorityType: "safe", directMintAbility: "direct", threshold: 1, signerCount: 1 },
        "permissioned-minter",
      ),
    ).toBe(25);
    expect(
      scoreMintAuthorityControl(
        { authorityType: "safe", directMintAbility: "direct", threshold: 3, signerCount: 5 },
        "permissioned-minter",
      ),
    ).toBe(65);
    expect(
      scoreMintAuthorityControl(
        {
          authorityType: "safe",
          directMintAbility: "direct",
          threshold: 4,
          signerCount: 7,
          modulesOrGuardsStatus: "none-detected",
        },
        "permissioned-minter",
      ),
    ).toBe(80);
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
    const issuer = computeMintAuthorityScore(
      input({
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        controls: [{ label: "Issuer key", authorityType: "eoa", directMintAbility: "direct" }],
      }),
    );
    expect(issuer.components.controller).toBe(40);
    expect(issuer.capsApplied).not.toContain("eoa-cap");

    const defi = computeMintAuthorityScore(
      input({
        mintPath: "permissioned-minter",
        controls: [{ label: "Admin key", authorityType: "eoa", directMintAbility: "direct" }],
      }),
    );
    expect(defi.components.controller).toBe(15);
    expect(defi.capsApplied).toContain("eoa-cap");
    expect(defi.score).toBeLessThanOrEqual(MINT_AUTHORITY_CAPS.eoa);

    const canAuthorize = computeMintAuthorityScore(
      input({
        mintPath: "permissioned-minter",
        controls: [{ label: "Authorizer key", authorityType: "eoa", directMintAbility: "can-authorize" }],
      }),
    );
    expect(canAuthorize.weakestControl).toMatchObject({
      label: "Authorizer key",
      directMintAbility: "can-authorize",
    });
    expect(canAuthorize.capsApplied).toContain("eoa-cap");
    expect(canAuthorize.score).toBeLessThanOrEqual(MINT_AUTHORITY_CAPS.eoa);

    const attested = computeMintAuthorityScore(
      input({
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
      }),
    );
    expect(attested.components.controller).toBe(40);
    expect(attested.capsApplied).not.toContain("eoa-cap");
    expect(attested.weakestControl?.custodyLabel).toBe("Single-key address - MPC-attested");
  });

  it("scores bounds from cap-limited controls and cap-raise authority", () => {
    expect(scoreMintAuthorityBounds([], "none-resolved")).toBe(100);
    expect(scoreMintAuthorityBounds([], "partially-bounded-admin")).toBe(50);
    expect(
      scoreMintAuthorityBounds([{ authorityType: "safe", directMintAbility: "direct" }], "partially-bounded-admin"),
    ).toBe(30);
    expect(
      scoreMintAuthorityBounds(
        [
          { authorityType: "safe", directMintAbility: "cap-limited", canRaiseCap: true },
          { authorityType: "dao-governor", directMintAbility: "upgrade-only" },
        ],
        "partially-bounded-admin",
      ),
    ).toBe(75);
    expect(
      scoreMintAuthorityBounds(
        [
          { authorityType: "safe", directMintAbility: "cap-limited", canRaiseCap: false },
          { authorityType: "dao-governor", directMintAbility: "upgrade-only" },
        ],
        "partially-bounded-admin",
      ),
    ).toBe(85);
    expect(
      scoreMintAuthorityBounds(
        [
          { authorityType: "safe", directMintAbility: "cap-limited", canRaiseCap: "unknown" },
          { authorityType: "dao-governor", directMintAbility: "upgrade-only" },
        ],
        "partially-bounded-admin",
      ),
    ).toBe(75);
    expect(
      scoreMintAuthorityBounds(
        [
          { authorityType: "safe", directMintAbility: "cap-limited" },
          { authorityType: "dao-governor", directMintAbility: "upgrade-only" },
        ],
        "partially-bounded-admin",
      ),
    ).toBe(75);
  });

  it("applies incident, unbounded, and confidence caps with traces", () => {
    const unbounded = score({ authorityPosture: "unbounded-or-compromised" });
    expect(unbounded.score).toBe(25);
    expect(unbounded.capsApplied).toContain("unbounded-cap");
    expect(unbounded.capTraces).toContainEqual({ kind: "unbounded-cap", limit: 25 });

    // v1.1: purely time-based incident-cap decay against a fixed clock.
    const NOW = Date.parse("2026-06-11T00:00:00Z");
    const incidentAt = (date: string) =>
      computeMintAuthorityScore(
        input({
          authorityPosture: "unbounded-or-compromised",
          mintIncidents: [
            { date, status: "resolved", summary: "Exploit.", sources: [{ label: "S", url: "https://example.com/s" }] },
          ],
        }),
        undefined,
        0,
        new Set(),
        NOW,
      );
    const recent = incidentAt("2026-03-22");
    expect(recent.score).toBe(10); // < 2y
    expect(recent.capsApplied).toContain("incident-cap");
    expect(recent.capTraces).toContainEqual({ kind: "incident-cap", limit: 10 });
    const aging = incidentAt("2024-01-30");
    expect(aging.score).toBe(15); // 2-4y
    expect(aging.capTraces).toContainEqual({ kind: "incident-cap", limit: 15 });
    const dated = incidentAt("2022-04-02");
    expect(dated.score).toBe(20); // >= 4y, still below unbounded 25
    expect(dated.capTraces).toContainEqual({ kind: "incident-cap", limit: 20 });
    expect(incidentAt("not-a-date").score).toBe(10); // unparseable stays strictest
    // multiple incidents: the most recent one governs the tier
    const multi = computeMintAuthorityScore(
      input({
        authorityPosture: "unbounded-or-compromised",
        mintIncidents: [
          {
            date: "2022-04-02",
            status: "resolved",
            summary: "Old.",
            sources: [{ label: "S", url: "https://example.com/a" }],
          },
          {
            date: "2026-03-22",
            status: "active",
            summary: "New.",
            sources: [{ label: "S", url: "https://example.com/b" }],
          },
        ],
      }),
      undefined,
      0,
      new Set(),
      NOW,
    );
    expect(multi.score).toBe(10);

    const manual = computeMintAuthorityScore(
      input({
        mintPath: "immutable-user-collateralized",
        authorityPosture: "none-resolved",
        confidence: "manual-review",
        controls: [],
      }),
    );
    expect(manual.score).toBe(85);
    expect(manual.capsApplied).toContain("confidence-cap");
    expect(manual.capTraces).toContainEqual({ kind: "confidence-cap", limit: 85 });

    const probable = computeMintAuthorityScore(
      input({
        mintPath: "immutable-user-collateralized",
        authorityPosture: "none-resolved",
        confidence: "probable",
        controls: [],
      }),
    );
    expect(probable.score).toBe(90);
    expect(probable.capsApplied).toContain("confidence-cap");

    const verified = computeMintAuthorityScore(
      input({
        mintPath: "immutable-user-collateralized",
        authorityPosture: "none-resolved",
        confidence: "verified",
        controls: [],
      }),
    );
    expect(verified.score).toBe(100);
    expect(verified.capsApplied).not.toContain("confidence-cap");
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
    expect(wrapperScore.capTraces).toContainEqual({ kind: "eoa-cap", limit: 40 });
  });

  it("returns NR for missing parents, missing resolver, cycles, depth limits, and unknown confidence", () => {
    expect(computeMintAuthorityScore(input({ confidence: "unknown" })).score).toBeNull();
    expect(
      computeMintAuthorityScore(
        input({
          mintPath: "wrapped-or-variant-inherited",
          inheritedFrom: "missing",
        }),
        () => null,
      ).unresolvedReason,
    ).toBe("parent-not-found");
    expect(
      computeMintAuthorityScore(
        input({
          mintPath: "wrapped-or-variant-inherited",
          inheritedFrom: "missing-resolver",
        }),
      ).unresolvedReason,
    ).toBe("parent-resolver-missing");

    const cyclic = input({
      id: "cycle",
      mintPath: "wrapped-or-variant-inherited",
      inheritedFrom: "cycle",
    });
    expect(computeMintAuthorityScore(cyclic, () => cyclic).unresolvedReason).toBe("inheritance-cycle");

    const cycleA = input({ id: "cycle-a", mintPath: "wrapped-or-variant-inherited", inheritedFrom: "cycle-b" });
    const cycleB = input({ id: "cycle-b", mintPath: "wrapped-or-variant-inherited", inheritedFrom: "cycle-c" });
    const cycleC = input({ id: "cycle-c", mintPath: "wrapped-or-variant-inherited", inheritedFrom: "cycle-a" });
    const cycleParents = new Map([cycleA, cycleB, cycleC].map((entry) => [entry.id!, entry]));
    expect(computeMintAuthorityScore(cycleA, (id) => cycleParents.get(id) ?? null).unresolvedReason).toBe(
      "inheritance-cycle",
    );

    const depthParent = (id: string): MintAuthorityScoringInput | null => {
      if (id === "depth-1") return input({ id, mintPath: "wrapped-or-variant-inherited", inheritedFrom: "depth-2" });
      if (id === "depth-2") return input({ id, mintPath: "wrapped-or-variant-inherited", inheritedFrom: "depth-3" });
      if (id === "depth-3") return input({ id, mintPath: "wrapped-or-variant-inherited", inheritedFrom: "depth-4" });
      if (id === "depth-4")
        return input({
          id,
          mintPath: "immutable-user-collateralized",
          authorityPosture: "none-resolved",
          controls: [],
        });
      return null;
    };
    expect(
      computeMintAuthorityScore(
        input({ id: "depth-0", mintPath: "wrapped-or-variant-inherited", inheritedFrom: "depth-1" }),
        depthParent,
      ).unresolvedReason,
    ).toBe("parent-not-scoreable");
  });

  it("incident-cap decay boundaries respect MINT_AUTHORITY_INCIDENT_DECAY_YEARS + YEAR_MS", () => {
    const NOW = Date.parse("2026-06-11T00:00:00Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const agingMs = MINT_AUTHORITY_INCIDENT_DECAY_YEARS.aging * YEAR_MS;
    const datedMs = MINT_AUTHORITY_INCIDENT_DECAY_YEARS.dated * YEAR_MS;
    const makeInput = (incidentMs: number) =>
      computeMintAuthorityScore(
        input({
          authorityPosture: "unbounded-or-compromised",
          mintIncidents: [
            {
              date: new Date(incidentMs).toISOString().slice(0, 10),
              status: "resolved",
              summary: "Exploit.",
              sources: [{ label: "S", url: "https://example.com/s" }],
            },
          ],
        }),
        undefined,
        0,
        new Set(),
        NOW,
      );

    // Just inside the "recent" tier (< aging boundary)
    expect(makeInput(NOW - agingMs + dayMs).score).toBe(10);
    // Just past the "aging" boundary (>= aging, < dated)
    expect(makeInput(NOW - agingMs - dayMs).score).toBe(15);
    // Just inside the "dated" boundary (< dated boundary)
    expect(makeInput(NOW - datedMs + dayMs).score).toBe(15);
    // Just past the "dated" boundary (>= dated)
    expect(makeInput(NOW - datedMs - dayMs).score).toBe(20);
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
