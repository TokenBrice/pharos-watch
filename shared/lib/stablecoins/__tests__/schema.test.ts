import { describe, expect, it } from "vitest";
import {
  parseStablecoinMetaAssets,
  StablecoinComplianceSidecarSchema,
  StablecoinMetaAssetSchema,
  StablecoinMintAuthoritySidecarSchema,
  StablecoinRiskReviewSidecarSchema,
} from "../schema";
import { BridgeRouteRiskProfileSchema, MintAuthorityProfileSchema, OracleRiskProfileSchema } from "../../../types/stablecoin-meta-control-schemas";
import { V9DeploymentControlFactBaseSchema } from "../../../types/safety-score-v9-facts";
import { STABLECOIN_STATUS_VALUES } from "../../../types/core";
import { reviewedScope, weightedQuorum, SCOPE_CONTROLLER } from "../../__tests__/safety-score-v9-control-scope.test-support";
import { CANONICAL_STABLECOIN_FLAGS, makeRawStablecoinMeta as makeCoin } from "./test-support";
import { makeBridgeAuthority, makeSafeControl } from "./schema.test-support";
import { makeCompiledVotingControl } from "../../__tests__/safety-score-v9-fixtures.test-support";
import { TRACKED_SOURCE_COINS } from "../registry";

const baseFlags = CANONICAL_STABLECOIN_FLAGS;


describe("StablecoinMeta schema — reserve and manual dependency roles", () => {
  function roleFixture(economicRole: "control-operator" | "basket-exposure") {
    return makeCoin({
      id: "usdm-mega",
      reserves: [{ name: "USDtb backing", pct: 100, risk: "low", coinId: "usdtb-ethena", depType: "collateral" }],
      dependencies: [{ id: "usdtb-ethena", weight: 0.001, type: "collateral" }],
      dependencyReview: {
        reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
        sources: [{ label: "Issuer rails", url: "https://example.com/rails" }],
        rationale: "The issuer's operator is separate from the measured reserve share.",
        relationships: [{
          id: "usdtb-ethena", weight: 0.001, type: "collateral", economicRole,
          reason: "Reviewed issuer operator role.",
        }],
      },
    });
  }

  it("admits a sourced control-operator review alongside reserves for the same upstream", () => {
    const parsed = parseStablecoinMetaAssets([roleFixture("control-operator")], "fixture");
    expect(parsed[0].dependencyReview?.relationships[0].economicRole).toBe("control-operator");
    expect(parsed[0].dependencies).toEqual([{ id: "usdtb-ethena", weight: 0.001, type: "collateral" }]);
  });

  it("rejects a redundant manual collateral basket review for a reserve-owned upstream", () => {
    expect(() => parseStablecoinMetaAssets([roleFixture("basket-exposure")], "fixture"))
      .toThrow(/redundant reserve metadata/);
  });

  it("admits a variant parent wrapper review when reserves express the same serial claim", () => {
    const parsed = parseStablecoinMetaAssets([makeCoin({
      id: "iusd-initia",
      variantOf: "ausd-agora",
      variantKind: "pure-wrapper",
      mintAuthority: makeMintAuthority({
        mintPath: "wrapped-or-variant-inherited",
        authorityPosture: "none-resolved",
        inheritedFrom: "ausd-agora",
        controls: undefined,
      }),
      reserves: [{
        name: "Agora AUSD", pct: 100, risk: "low",
        coinId: "ausd-agora", depType: "wrapper",
      }],
      dependencyReview: {
        reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
        sources: [{ label: "Issuer wrapper", url: "https://example.com/wrapper" }],
        rationale: "The reserve identity also documents the variant's serial parent.",
        relationships: [{
          id: "ausd-agora", weight: 1, type: "wrapper", economicRole: "serial-claim",
          reason: "The variant is a claim on its AUSD parent.",
        }],
      },
    }), makeCoin({
      id: "ausd-agora",
      mintAuthority: makeMintAuthority({
        mintPath: "immutable-user-collateralized",
        authorityPosture: "none-resolved",
        controls: undefined,
      }),
    })], "fixture");
    expect(parsed[0].variantOf).toBe("ausd-agora");
    expect(parsed[0].dependencyReview?.relationships[0].economicRole).toBe("serial-claim");
  });

  it("rejects mixed-source collateral that has no linked reserve identity", () => {
    const fixture = roleFixture("control-operator");
    fixture.dependencies = [{ id: "missing-upstream", weight: 0.001, type: "collateral" }];
    expect(() => parseStablecoinMetaAssets([fixture], "fixture")).toThrow(/manual-collateral-not-in-reserves/);
  });
});

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
    controls: [makeSafeControl()],
    review: {
      sources: [mintAuthoritySource],
      evidence: "The verified contract source and Safe state identify the mint authority.",
      reviewer: "Fixture Reviewer",
      reviewedAt: "2026-05-24",
    },
    ...overrides,
  };
}

function governedMintAuthority() {
  const executionScope = reviewedScope();
  executionScope.paths[0]!.capSemantics = { kind: "unbounded", bound: null };
  const pin = { chain: "ethereum", position: "100", hash: `0x${"ab".repeat(32)}`, timestamp: "2026-10-01T00:00:00Z" };
  const review = { observedAt: "2026-10-01", reviewedAt: "2026-10-01", expiresAt: "2026-10-31", reviewer: "Fixture Reviewer", pin };
  const proofRef = "fixture-source-unknown";
  return MintAuthorityProfileSchema.parse(makeMintAuthority({
    authorityPosture: "unbounded-governed",
    economicCapSemantics: "unbounded",
    controls: [{
      chain: "ethereum",
      address: SCOPE_CONTROLLER.split(":")[1],
      label: "Token governor",
      role: "governor",
      authorityType: "dao-governor",
      directMintAbility: "can-authorize",
      executionScope,
    }],
    executionCertificates: { schemaVersion: 1, liabilityBookId: "fixture-book",
      evidence: [{ id: proofRef, pin, deployment: SCOPE_CONTROLLER, kind: "verified-source", readType: null,
        function: "modeled governor source", selector: null, calldata: null, rawResult: null, sourceUrl: mintAuthoritySource.url,
        sourceLocation: "modeled authoring boundary", statement: "This authoring fixture identifies the source but deliberately leaves the state census unknown.", artificial: false }],
      proofs: [{ id: proofRef, conclusion: "unknown", statement: "The authoring fixture does not assert a closed voting census or a positive process score.", evidenceRefIds: [proofRef] }],
      censuses: [{ id: "fixture-census", review, targetDeployment: SCOPE_CONTROLLER, kind: "ward", role: "mint", coverage: "unknown",
        authoritativeMembers: [], observations: [], discovery: { kind: "source-fixed-set", fromPosition: "0", throughPosition: "100", paginationEnd: null, proofRef }, completenessProofRef: proofRef }],
      classes: [], members: [] },
    authorityGraph: { id: "fixture-graph", review, liabilityBookId: "fixture-book", governorNodeId: "governor",
      nodes: [{ id: "governor", deployment: SCOPE_CONTROLLER, kind: "token-governor", terminal: true, authorityCensusIds: ["fixture-census"], runtime: null, proofRef }],
      edges: [], pathBindings: [{ path: { controlRef: SCOPE_CONTROLLER, pathId: "issuance" }, authorityNodeIds: ["governor"], provenanceNodeIds: [], closureProofRef: proofRef }], closureProofRef: proofRef },
    governedIssuance: {
      decisionRule: "affirmative-vote",
      governorControlRef: SCOPE_CONTROLLER,
      votingPower: "lock-escrowed",
      votingPowerEvidence: "Voting weight is escrowed for the entire voting and execution interval.",
      votingControl: { id: "fixture-voting", governorNodeId: "governor", review, votingToken: SCOPE_CONTROLLER, totalVotingPowerRaw: null,
        pinnedVotingSupply: { deployment: SCOPE_CONTROLLER, function: "totalSupply()", raw: null, proofRef }, controllerCensusProofRef: proofRef,
        holderCensus: [], controllers: [], routes: [{ id: "fixture-approval", path: { controlRef: SCOPE_CONTROLLER, pathId: "issuance" },
          kind: "affirmative-approval", totalVotingPowerRaw: null, unilateralThresholdRaw: null, thresholdComparator: "gt", thresholdProofRef: proofRef,
          holderCensusRef: "holderCensus", controllerPowers: [], residualUpperRaw: null, residualProofRef: proofRef, affiliatedControllerIds: [],
          affiliatedAggregatePowerRaw: null, affiliatedAggregateUnilateralThresholdRaw: null, affiliatedAggregateThresholdComparator: "gt",
          affiliatedAggregateThresholdProofRef: proofRef, minorityProtectionProofRef: null }],
        privilegedVoteCreation: { state: "unknown", pathRefs: [], proofRef }, forcedDelegation: { state: "unknown", pathRefs: [], proofRef } },
      enumerability: { authorizationEvents: ["MinterAuthorized(address)"], capacityReads: ["mintCapacity(address)"] },
      observedAt: "2026-10-01",
      observedBlock: 100,
      reviewedAt: "2026-10-01",
      reviewer: "Fixture Reviewer",
      sources: [mintAuthoritySource],
    },
  }));
}

const capSemanticsReview = {
  verdict: "bounded-by-construction" as const,
  rationale: "The verified mint implementation requires a matching collateral deposit before every issuance, including issuances authorized by administrators.",
  reviewedAt: "2026-10-01",
  reviewer: "Fixture Reviewer",
  sources: [mintAuthoritySource],
};

describe("Mint authority D14/D29 evidence admission", () => {
  it("admits sourced governance for an exact authored governor with execution scope", () => {
    const profile = governedMintAuthority();
    expect(profile.authorityPosture).toBe("unbounded-governed");
    expect(profile.governedIssuance?.governorControlRef).toBe(SCOPE_CONTROLLER);
  });

  it.each(["bounded", "raiseable", "collateral-gated", "unknown", undefined] as const)(
    "rejects governed issuance without unbounded economics (%s)", (economicCapSemantics) => {
      const profile = { ...governedMintAuthority(), economicCapSemantics };
      expect(MintAuthorityProfileSchema.safeParse(profile).error?.issues).toContainEqual(expect.objectContaining({
        path: ["economicCapSemantics"], message: "governedIssuance requires economicCapSemantics unbounded",
      }));
    },
  );

  it("requires the governor reference to resolve exactly once", () => {
    const profile = governedMintAuthority();
    for (const controls of [[], [...profile.controls!, profile.controls![0]!]]) {
      expect(MintAuthorityProfileSchema.safeParse({ ...profile, controls }).error?.issues).toContainEqual(expect.objectContaining({
        path: ["governedIssuance", "governorControlRef"],
        message: "governedIssuance.governorControlRef must resolve to exactly one authored EVM control",
      }));
    }
  });

  it("rejects a non-governor reference and a governor without an execution certificate", () => {
    const profile = governedMintAuthority();
    const governor = profile.controls![0]!;
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, controls: [{ ...governor, authorityType: "contract" }],
    }).error?.issues).toContainEqual(expect.objectContaining({
      path: ["governedIssuance", "governorControlRef"],
      message: "governedIssuance.governorControlRef must name a dao-governor control",
    }));
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, controls: [{ ...governor, executionScope: undefined }],
    }).error?.issues).toContainEqual(expect.objectContaining({
      path: ["controls", 0, "executionScope"],
      message: "governedIssuance governor control requires executionScope",
    }));
  });

  it.each(["holding-period-weighted", "lock-escrowed", "past-block-checkpoint"] as const)(
    "rejects signer-quorum claims on a %s governor", (votingPower) => {
      const profile = governedMintAuthority();
      const governor = profile.controls![0]!;
      const weightedQuorum = {
        scheme: "contract", deployment: SCOPE_CONTROLLER,
        signers: [{ account: governor.address!, weight: 1 }], quorum: 1,
        pin: governor.executionScope!.pin, status: "verified",
        reviewedAt: "2026-10-01", expiresAt: "2026-10-31",
        reviewer: "Fixture Reviewer", sources: [mintAuthoritySource],
      };
      for (const quorum of [{ threshold: 1 }, { signerCount: 1 }, { weightedQuorum }]) {
        expect(MintAuthorityProfileSchema.safeParse({
          ...profile,
          controls: [{ ...governor, ...quorum }],
          governedIssuance: { ...profile.governedIssuance!, votingPower },
        }).error?.issues).toContainEqual(expect.objectContaining({
          path: ["governedIssuance", "governorControlRef"],
        }));
      }
    },
  );

  it.each(["live-balance", "unknown"] as const)(
    "does not apply the token-voting quorum prohibition to %s voting power", (votingPower) => {
      const profile = governedMintAuthority();
      expect(MintAuthorityProfileSchema.parse({
        ...profile,
        controls: [{ ...profile.controls![0]!, threshold: 1, signerCount: 1 }],
        governedIssuance: { ...profile.governedIssuance!, votingPower },
      }).governedIssuance?.votingPower).toBe(votingPower);
    },
  );

  it.each([
    { inheritedFrom: "parent-fixture" },
    { mintPath: "wrapped-or-variant-inherited" },
    { inheritedFrom: "parent-fixture", mintPath: "wrapped-or-variant-inherited" },
  ])("rejects governed issuance on inherited or wrapped profiles (%j)", (inherited) => {
    expect(MintAuthorityProfileSchema.safeParse({
      ...governedMintAuthority(), ...inherited,
    }).error?.issues).toContainEqual(expect.objectContaining({ path: ["governedIssuance"] }));
  });

  it("rejects governed issuance when every authored execution path is bounded", () => {
    const profile = governedMintAuthority();
    profile.controls![0]!.executionScope!.paths[0]!.capSemantics = {
      kind: "bounded", bound: { amount: 1, unit: "supply-fraction" },
    };
    expect(MintAuthorityProfileSchema.safeParse(profile).error?.issues).toContainEqual(
      expect.objectContaining({ path: ["governedIssuance"] }),
    );
  });

  it.each([
    { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "none" },
    { capSemantics: { kind: "unknown", bound: null }, claimImpairment: "none" },
    { capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "unbounded" },
    { capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "unknown" },
  ] as const)("admits unbounded economics on another authored control's parameter path (%j)", (economics) => {
    const profile = governedMintAuthority();
    const governor = profile.controls![0]!;
    governor.executionScope!.paths[0]!.capSemantics = {
      kind: "bounded", bound: { amount: 1, unit: "supply-fraction" },
    };
    const deployment = "ethereum:0x2222222222222222222222222222222222222222";
    const scope = reviewedScope({ controllerDeployment: deployment });
    scope.paths[0] = {
      ...scope.paths[0]!, targetDeployment: deployment,
      capabilities: ["parameter-change"], ...economics,
    };
    profile.controls!.push({
      ...governor, address: deployment.split(":")[1], label: "Governed parameter control",
      authorityType: "contract", directMintAbility: "parameter-only", executionScope: scope,
    });
    expect(MintAuthorityProfileSchema.parse(profile).governedIssuance?.governorControlRef).toBe(SCOPE_CONTROLLER);
  });

  it.each([
    "xrpl:rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK",
    "solana:11111111111111111111111111111111",
  ])("rejects a non-EVM governor reference (%s)", (governorControlRef) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, governedIssuance: { ...profile.governedIssuance!, governorControlRef },
    }).error?.issues).toContainEqual(expect.objectContaining({
      path: ["governedIssuance", "governorControlRef"],
      message: expect.stringContaining("EVM"),
    }));
  });

  it("requires a governed evidence block only for the governed posture", () => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({ ...profile, governedIssuance: undefined }).error?.issues).toContainEqual(
      expect.objectContaining({ path: ["governedIssuance"] }),
    );
    expect(MintAuthorityProfileSchema.parse({
      ...profile, authorityPosture: "unbounded-adverse", governedIssuance: undefined,
    }).authorityPosture).toBe("unbounded-adverse");
  });

  it("requires an explicit decision rule with no legacy default", () => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, governedIssuance: { ...profile.governedIssuance!, decisionRule: undefined },
    }).error?.issues).toContainEqual(expect.objectContaining({ path: ["governedIssuance", "decisionRule"] }));
  });

  const veto = {
    quorumBps: 200, entrypoints: ["0x12345678"], override: "symmetric-vote-destruction",
    evidence: "The pinned governor veto rejects admission during the entire public window; canceling a veto destroys the caller's equal voting power.",
  } as const;

  it.each([
    ["affirmative-vote", veto], ["minority-veto", undefined],
  ] as const)("requires veto evidence iff the decision rule is %s", (decisionRule, vetoEvidence) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture: "unbounded-adverse",
      governedIssuance: { ...profile.governedIssuance!, decisionRule, veto: vetoEvidence },
    }).error?.issues).toContainEqual(expect.objectContaining({ path: ["governedIssuance", "veto"] }));
  });

  it.each([
    ["unbounded-governed", "minority-veto"],
    ["unbounded-veto-guarded", "affirmative-vote"],
    ["unbounded-veto-guarded", undefined],
  ] as const)("rejects %s without its matching process evidence (%s)", (authorityPosture, decisionRule) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture,
      governedIssuance: decisionRule ? { ...profile.governedIssuance!, decisionRule,
        veto: decisionRule === "minority-veto" ? veto : undefined } : undefined,
    }).error?.issues).toContainEqual(expect.objectContaining({
      path: decisionRule ? ["governedIssuance", "decisionRule"] : ["governedIssuance"],
    }));
  });

  it.each([
    { quorumBps: 0 }, { quorumBps: 10001 }, { quorumBps: 200.5 },
    { entrypoints: [] }, { entrypoints: ["veto(address)"] }, { entrypoints: ["0x1234567A"] },
    { override: "majority" }, { evidence: "x".repeat(79) }, { unexpected: true },
  ])("rejects malformed veto evidence %j", (change) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture: "unbounded-veto-guarded",
      governedIssuance: { ...profile.governedIssuance!, decisionRule: "minority-veto", veto: { ...veto, ...change } },
    }).success).toBe(false);
  });

  it.each(["none", "symmetric-vote-destruction", "unknown"] as const)(
    "preserves the reviewed %s veto override without assuming qualification", (override) => {
      const profile = governedMintAuthority();
      const parsed = MintAuthorityProfileSchema.parse({
        ...profile, authorityPosture: "unbounded-veto-guarded",
        governedIssuance: { ...profile.governedIssuance!, decisionRule: "minority-veto",
          votingPower: "holding-period-weighted", veto: { ...veto, override } },
      });
      expect(parsed.governedIssuance).toMatchObject({ decisionRule: "minority-veto", veto: { override } });
    },
  );

  const monetaryPath = {
    controlRef: SCOPE_CONTROLLER, pathId: "issuance", rateCapPpm: 100000,
    rateChangeDelaySec: 172800, rateChangeRule: "minority-replaceable",
    evidence: "The pinned mint path is limited to deposits times a hard-capped rate times elapsed time; every rate change is minority-blockable for two days.",
  };

  it.each([
    { controlRef: "ethereum:0x2222222222222222222222222222222222222222" },
    { pathId: "missing-path" },
  ])("rejects unresolved monetary-policy path references %j (R-l)", (change) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture: "unbounded-veto-guarded", governedIssuance: {
        ...profile.governedIssuance!, decisionRule: "minority-veto", veto,
        monetaryPolicyPaths: [{ ...monetaryPath, ...change }],
      },
    }).error?.issues).toContainEqual(expect.objectContaining({ path: ["governedIssuance", "monetaryPolicyPaths", 0] }));
  });

  it.each([
    { rateCapPpm: 0 }, { rateCapPpm: 1.5 }, { rateChangeDelaySec: -1 }, { rateChangeDelaySec: 0.5 },
    { rateChangeRule: "majority" }, { evidence: "x".repeat(79) }, { unexpected: true },
  ])("rejects malformed monetary-policy evidence %j", (change) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture: "unbounded-veto-guarded", governedIssuance: {
        ...profile.governedIssuance!, decisionRule: "minority-veto", veto,
        monetaryPolicyPaths: [{ ...monetaryPath, ...change }],
      },
    }).success).toBe(false);
  });

  it.each([{ monetaryPolicyPaths: [] }, { monetaryPolicyPaths: [monetaryPath] }])(
    "forbids a monetary-policy inventory on affirmative voting", ({ monetaryPolicyPaths }) => {
      const profile = governedMintAuthority();
      expect(MintAuthorityProfileSchema.safeParse({
        ...profile, governedIssuance: { ...profile.governedIssuance!, monetaryPolicyPaths },
      }).error?.issues).toContainEqual(expect.objectContaining({ path: ["governedIssuance", "monetaryPolicyPaths"] }));
    },
  );

  const restructure = {
    entrypoints: ["0xabcdef01"], equityThresholdUnits: 1000, observedEquityUnits: 1001,
    dependentPaths: [],
    evidence: "Pinned equity is above the insolvency threshold; only the gated restructure can wipe share supply to zero, and ordinary redemption retains a share.",
  };

  it.each([
    ["insolvency-gated-restructure", undefined], ["none", restructure], ["symmetric-vote-destruction", restructure],
  ] as const)("requires restructure evidence iff override is %s", (override, evidence) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture: "unbounded-veto-guarded", governedIssuance: {
        ...profile.governedIssuance!, decisionRule: "minority-veto", veto: { ...veto, override, restructure: evidence },
      },
    }).error?.issues).toContainEqual(expect.objectContaining({ path: ["governedIssuance", "veto", "restructure"] }));
  });

  it.each([
    { equityThresholdUnits: 0 }, { observedEquityUnits: -1 }, { entrypoints: [] },
    { entrypoints: ["0xABCDE001"] }, { evidence: "x".repeat(79) },
    { dependentPaths: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance", unexpected: true }] },
    { unexpected: true },
  ])("rejects malformed restructure evidence %j", (change) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, authorityPosture: "unbounded-veto-guarded", governedIssuance: {
        ...profile.governedIssuance!, decisionRule: "minority-veto",
        veto: { ...veto, override: "insolvency-gated-restructure", restructure: { ...restructure, ...change } },
      },
    }).success).toBe(false);
  });

  it.each(["raiseable", "bounded", "collateral-gated"] as const)(
    "requires the correct sourced D14 verdict for %s issuance authority", (economicCapSemantics) => {
      const verdict = economicCapSemantics === "raiseable" ? "raiseable-collateral-only" : "bounded-by-construction";
      for (const ability of [
        { directMintAbility: "direct" }, { directMintAbility: "can-authorize" },
        { directMintAbility: "cap-limited", canRaiseCap: true },
        { directMintAbility: "parameter-only", canRaiseCap: true },
        { directMintAbility: "upgrade-only", canRaiseCap: true },
        { directMintAbility: "none", canRaiseCap: true },
        { directMintAbility: "unknown", canRaiseCap: true },
      ]) {
        const profile = makeMintAuthority({
          economicCapSemantics, controls: [makeSafeControl(ability)],
        });
        expect(MintAuthorityProfileSchema.safeParse(profile).error?.issues).toContainEqual(
          expect.objectContaining({ path: ["capSemanticsReview"] }),
        );
        expect(MintAuthorityProfileSchema.parse({
          ...profile, capSemanticsReview: { ...capSemanticsReview, verdict },
        }).capSemanticsReview?.verdict).toBe(verdict);
        expect(MintAuthorityProfileSchema.safeParse({
          ...profile,
          capSemanticsReview: {
            ...capSemanticsReview,
            verdict: verdict === "bounded-by-construction" ? "raiseable-collateral-only" : "bounded-by-construction",
          },
        }).error?.issues).toContainEqual(expect.objectContaining({ path: ["capSemanticsReview", "verdict"] }));
      }
    },
  );

  it.each([
    { directMintAbility: "cap-limited", canRaiseCap: false },
    { directMintAbility: "cap-limited", canRaiseCap: "unknown" },
    { directMintAbility: "parameter-only", canRaiseCap: false },
    { directMintAbility: "parameter-only", canRaiseCap: "unknown" },
    { directMintAbility: "upgrade-only", canRaiseCap: false },
    { directMintAbility: "none" },
  ])("does not invent a D14 issuance trigger for %j", (ability) => {
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({
      economicCapSemantics: "bounded", controls: [makeSafeControl(ability)],
    })).capSemanticsReview).toBeUndefined();
  });

  it.each(["unbounded", "unknown"] as const)("rejects a cap review on %s economics", (economicCapSemantics) => {
    expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({
      economicCapSemantics, capSemanticsReview,
    })).error?.issues).toContainEqual(expect.objectContaining({ path: ["capSemanticsReview"] }));
  });

  it("reserves compromised posture for an active incident in both directions", () => {
    const incident = { date: "2026-05-20", status: "active", summary: "The mint key remains compromised.", sources: [mintAuthoritySource] };
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({
      authorityPosture: "compromised", mintIncidents: [incident],
    })).mintIncidents?.[0]?.status).toBe("active");
    for (const overrides of [
      { authorityPosture: "compromised" },
      { authorityPosture: "compromised", mintIncidents: [{ ...incident, status: "resolved", resolvedAt: "2026-05-21" }] },
      { authorityPosture: "unbounded-adverse", mintIncidents: [incident] },
    ]) {
      expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority(overrides)).error?.issues).toContainEqual(
        expect.objectContaining({ path: ["authorityPosture"] }),
      );
    }
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({
      mintIncidents: [{ ...incident, status: "resolved", resolvedAt: "2026-05-21" }],
    })).authorityPosture).toBe("partially-bounded-admin");
  });

  it("admits genuinely unknown authority on an unknown mint path", () => {
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({
      mintPath: "unknown", authorityPosture: "unknown", confidence: "unknown", controls: [],
    })).authorityPosture).toBe("unknown");
  });

  it("admits an unknown mint path's adverse annotation only with known unbounded economics", () => {
    const profile = makeMintAuthority({
      mintPath: "unknown", authorityPosture: "unbounded-adverse", confidence: "unknown",
    });
    for (const economicCapSemantics of [undefined, "unknown", "bounded", "raiseable", "collateral-gated"]) {
      expect(MintAuthorityProfileSchema.safeParse({ ...profile, economicCapSemantics }).error?.issues).toContainEqual(
        expect.objectContaining({ path: ["authorityPosture"] }),
      );
    }
    expect(MintAuthorityProfileSchema.parse({ ...profile, economicCapSemantics: "unbounded" }).authorityPosture)
      .toBe("unbounded-adverse");
  });

  it.each([
    { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "bounded" },
    { capSemantics: { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } }, claimImpairment: "unbounded" },
  ] as const)("admits known unbounded execution economics without inventing aggregate semantics (%j)", (economics) => {
    const executionScope = reviewedScope();
    executionScope.paths[0] = { ...executionScope.paths[0]!, ...economics };
    const profile = MintAuthorityProfileSchema.parse(makeMintAuthority({
      mintPath: "unknown", authorityPosture: "unbounded-adverse", confidence: "manual-review",
      controls: [{
        chain: "ethereum", address: SCOPE_CONTROLLER.split(":")[1], label: "Reviewed issuer authority",
        role: "direct-minter", authorityType: "contract", directMintAbility: "direct", executionScope,
      }],
    }));
    expect(profile.authorityPosture).toBe("unbounded-adverse");
    expect(profile.economicCapSemantics).toBeUndefined();
  });

  it.each(["unbounded-reconciliation-unknown", "unbounded-unreconciled"])(
    "rejects retired posture %s in profiles, sidecars, and every listing status", (authorityPosture) => {
      const mintAuthority = makeMintAuthority({
        authorityPosture: "unbounded-adverse", economicCapSemantics: "unbounded",
      });
      expect(MintAuthorityProfileSchema.safeParse({ ...mintAuthority, authorityPosture }).error?.issues)
        .toContainEqual(expect.objectContaining({ path: ["authorityPosture"] }));
      expect(StablecoinMintAuthoritySidecarSchema.safeParse({
        id: "fixture-usd", mintAuthority: { ...mintAuthority, authorityPosture },
      }).error?.issues).toContainEqual(expect.objectContaining({ path: ["mintAuthority", "authorityPosture"] }));
      for (const status of STABLECOIN_STATUS_VALUES) {
        const coin = makeCoin({
          status, mintAuthority,
          ...(status === "frozen" ? {
            frozenAt: "2026-05-24",
            obituary: {
              causeOfDeath: "abandoned", deathDate: "2026-05", epitaph: "The issuer ended issuance.",
              obituary: "The fixture issuer wound down its native stablecoin.",
              sourceUrl: mintAuthoritySource.url, sourceLabel: mintAuthoritySource.label,
            },
          } : {}),
          ...(status === "quarantined" || status === "delisted" ? {
            listingStatusReview: {
              changedAt: "2026-05-24", reason: "The issuer's listing remains under review.",
              reviewBy: "2026-06-24", source: mintAuthoritySource,
            },
          } : {}),
        });
        expect(() => parseStablecoinMetaAssets([coin], "fixture")).not.toThrow();
        expect(() => parseStablecoinMetaAssets([
          { ...coin, mintAuthority: { ...mintAuthority, authorityPosture } },
        ], "fixture")).toThrow(/authorityPosture/);
      }
    },
  );

  it("rejects a governed posture on an unknown mint path", () => {
    expect(MintAuthorityProfileSchema.safeParse({ ...governedMintAuthority(), mintPath: "unknown" }).error?.issues).toContainEqual(
      expect.objectContaining({ path: ["authorityPosture"] }),
    );
  });

  it("trims evidence and rejects undersourced or non-strict evidence blocks", () => {
    const profile = governedMintAuthority();
    const governedIssuance = profile.governedIssuance!;
    expect(MintAuthorityProfileSchema.parse({
      ...profile, governedIssuance: { ...governedIssuance, votingPowerEvidence: `  ${governedIssuance.votingPowerEvidence}  ` },
    }).governedIssuance?.votingPowerEvidence).toBe(governedIssuance.votingPowerEvidence);
    for (const change of [
      { votingPowerEvidence: ` ${"x".repeat(39)} ` }, { sources: [] }, { observedBlock: 0 },
      { governorControlRef: SCOPE_CONTROLLER.replace("ethereum", "Ethereum") },
      { enumerability: { authorizationEvents: [], capacityReads: ["capacity()"] } },
      { unexpected: true },
    ]) {
      expect(MintAuthorityProfileSchema.safeParse({
        ...profile, governedIssuance: { ...governedIssuance, ...change },
      }).success).toBe(false);
    }
    for (const change of [{ rationale: ` ${"x".repeat(79)} ` }, { sources: [] }, { unexpected: true }]) {
      expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({
        economicCapSemantics: "bounded", capSemanticsReview: { ...capSemanticsReview, ...change },
      })).success).toBe(false);
    }
  });
});

describe("Compiled issuance governance contract", () => {
  const schema = V9DeploymentControlFactBaseSchema.shape.issuanceGovernance;
  const complete = {
    coverage: "complete",
    incompleteReasons: [],
    governorAuthorityKey: SCOPE_CONTROLLER,
    minUnavoidableDelaySec: 172800,
    votingPower: "past-block-checkpoint",
    enumerable: true,
    nonGovernorUnboundedPathKeys: [],
    decisionRule: "affirmative-vote",
    vetoQuorumBps: null,
    vetoOverride: null,
    votingControl: makeCompiledVotingControl(),
    diagnostics: [],
  };

  it("preserves absent evidence and a nullable minimum without inventing completeness", () => {
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse({ ...complete, coverage: "incomplete", incompleteReasons: ["review-incomplete"], minUnavoidableDelaySec: null }))
      .toMatchObject({ coverage: "incomplete", incompleteReasons: ["review-incomplete"], minUnavoidableDelaySec: null });
  });

  it("sorts canonical coverage reasons and non-governor path keys", () => {
    expect(schema.parse({
      ...complete, coverage: "incomplete", incompleteReasons: ["z", "a"],
      nonGovernorUnboundedPathKeys: ["z:issuance", "a:issuance"],
    })).toMatchObject({
      incompleteReasons: ["a", "z"], nonGovernorUnboundedPathKeys: ["a:issuance", "z:issuance"],
    });
  });

  it("rejects inconsistent coverage, duplicate keys, invalid delays, and unknown fields", () => {
    for (const change of [
      { coverage: "incomplete" }, { incompleteReasons: ["review-incomplete"] },
      { coverage: "incomplete", incompleteReasons: ["a", "a"] },
      { nonGovernorUnboundedPathKeys: ["a:issuance", "a:issuance"] },
      { minUnavoidableDelaySec: -1 }, { minUnavoidableDelaySec: 0.5 },
      { votingPower: "instant-snapshot" }, { unexpected: true },
    ]) {
      expect(schema.safeParse({ ...complete, ...change }).success).toBe(false);
    }
  });
});

function makeInheritanceChain(ids: string[], terminal = makeCoin({
  id: "terminal",
  mintAuthority: makeMintAuthority({
    mintPath: "immutable-user-collateralized",
    authorityPosture: "none-resolved",
    controls: undefined,
  }),
})) {
  return [
    ...ids.map((id, index) => makeCoin({
      id,
      mintAuthority: makeMintAuthority({
        mintPath: "wrapped-or-variant-inherited",
        inheritedFrom: ids[index + 1] ?? terminal.id,
        controls: undefined,
      }),
    })),
    terminal,
  ];
}

describe("StablecoinMeta schema — frozen status", () => {
  it("accepts a well-formed frozen coin", () => {
    const json = [
      makeCoin({ id: "fixture-frozen", status: "frozen",
      frozenAt: "2026-04-27",
      obituary: {
        causeOfDeath: "abandoned",
        deathDate: "2026-04",
        epitaph: "Closed without ceremony.",
        obituary: "FXT was sunset by its issuer.",
        sourceUrl: "https://example.com/x",
        sourceLabel: "Issuer announcement",
      }, }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a frozen coin missing the obituary block", () => {
    const json = [
      makeCoin({ id: "fixture-frozen-bad", status: "frozen",
      frozenAt: "2026-04-27", }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/obituary/);
  });

  it("rejects a frozen coin missing frozenAt", () => {
    const json = [
      makeCoin({ id: "fixture-frozen-bad-2", status: "frozen",
      obituary: {
        causeOfDeath: "abandoned",
        deathDate: "2026-04",
        epitaph: "x",
        obituary: "x",
        sourceUrl: "https://example.com/x",
        sourceLabel: "x",
      }, }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/frozenAt/);
  });

  it("rejects an active coin with a stray obituary field", () => {
    const json = [
      makeCoin({ id: "fixture-active-bad", status: "active",
      obituary: {
        causeOfDeath: "abandoned",
        deathDate: "2026-04",
        epitaph: "x",
        obituary: "x",
        sourceUrl: "https://example.com/x",
        sourceLabel: "x",
      }, }),
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
  it("rejects the retired canBeBlacklisted field", () => {
    const json = [
      makeCoin({ id: "fixture-blacklist-legacy", canBeBlacklisted: true, }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/canBeBlacklisted/);
  });

  it.each([true, false, "possible", "inherited"] as const)("accepts reviewed status %s", (reviewedStatus) => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        blacklistabilityReview: {
          reviewedStatus,
          sourceFreeRationale: "Reviewed fixture status.",
          evidence: "Fixture evidence for reviewed blacklistability status.",
          reviewer: "Fixture",
          reviewedAt: "2026-05-12",
        },
      }),
    ], "fixture")).not.toThrow();
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

  it("requires a review source or rationale", () => {
    expect(() => parseStablecoinMetaAssets([makeCoin({
      blacklistabilityReview: {
        reviewedStatus: true,
        evidence: "Fixture evidence without source.",
        reviewer: "Fixture",
        reviewedAt: "2026-05-12",
      },
    })], "fixture")).toThrow(/sources/);
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
    const parsed = parseStablecoinMetaAssets([
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
          references: [issuerDisclosure],
          reviewer: "Fixture Reviewer",
          reviewedAt: "2026-05-27",
        },
      }),
    ], "fixture");
    expect(parsed[0]?.genius?.authorizationStatus).toBe("issuer-announced-intent");
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

  it("admits a budgeted headline and rejects over-long or identifier-bearing ones", () => {
    const withHeadline = (headline: string) => [makeCoin({
      id: "fixture-mint-headline",
      mintAuthority: makeMintAuthority({ headline }),
    })];
    expect(() => parseStablecoinMetaAssets(
      withHeadline("Managed — the issuer mints directly through a 3/6 multisig; supply is unbounded but reconciled."),
      "fixture",
    )).not.toThrow();
    expect(() => parseStablecoinMetaAssets(withHeadline(Array.from({ length: 26 }, () => "word").join(" ")), "fixture"))
      .toThrow(/mintAuthority\.headline has 26 words/);
    for (const identifier of [`0x${"ab".repeat(20)}`, "block 25,711,857", "345603 seconds", "D29", "v10.05 campaign pin"]) {
      expect(() => parseStablecoinMetaAssets(withHeadline(`Owner gate ${identifier} controls minting.`), "fixture"))
        .toThrow(/mintAuthority\.headline contains a raw identifier/);
    }
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
          controls: [makeSafeControl({ sources: [mintAuthoritySource] })],
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
          controls: [makeSafeControl({ threshold: 4 }, { threshold: 4 })],
        }),
      }),
    ], "fixture")).toThrow(/threshold/);
  });

  it.each([
    ["impossible uniform quorum", { threshold: 4, safe: undefined }, {}, ["threshold"]],
    ["contradictory Safe threshold", {}, { threshold: 1 }, ["safe", "threshold"]],
    ["contradictory Safe owner count", { signerCount: 4 }, {}, ["safe", "owners"]],
    ["inappropriate Safe authority type", { authorityType: "eoa" }, {}, ["safe"]],
  ] as const)("rejects %s in both mint and bridge admission", (_label, overrides, safeOverrides, path) => {
    const control = makeSafeControl(overrides, safeOverrides);
    for (const result of [
      MintAuthorityProfileSchema.safeParse(makeMintAuthority({ controls: [control] })),
      BridgeRouteRiskProfileSchema.safeParse(makeBridgeAuthority(control)),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["controls", 0, ...path] }));
    }
  });

  it("keeps consistent Safe and weighted quorums admissible in mint and bridge profiles", () => {
    const weighted = weightedQuorum();
    const separator = weighted.deployment.indexOf(":");
    for (const control of [
      makeSafeControl(),
      makeSafeControl({
        authorityType: "multisig", chain: weighted.deployment.slice(0, separator),
        address: weighted.deployment.slice(separator + 1),
        threshold: undefined, signerCount: undefined, safe: undefined, weightedQuorum: weighted,
      }),
    ]) {
      expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({ controls: [control] })).success).toBe(true);
      expect(BridgeRouteRiskProfileSchema.safeParse(makeBridgeAuthority(control)).success).toBe(true);
    }
  });

  it.each(["timelock", "multisig"])("preserves bridge %s Safe facts without admitting them as native Safe authority", (authorityType) => {
    const control = makeSafeControl({ authorityType, timelockDelaySec: 86400 });
    expect(BridgeRouteRiskProfileSchema.safeParse(makeBridgeAuthority(control)).success).toBe(true);
    expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({ controls: [control] })).success).toBe(false);
  });

  it("admits current corpus authority profiles, including weighted and same-chain system transport controls", () => {
    for (const coin of TRACKED_SOURCE_COINS) {
      if (coin.mintAuthority) {
        expect(MintAuthorityProfileSchema.safeParse(coin.mintAuthority).success, `${coin.id} mint`).toBe(true);
      }
      if (coin.bridgeRouteRisk) {
        expect(BridgeRouteRiskProfileSchema.safeParse(coin.bridgeRouteRisk).success, `${coin.id} bridge`).toBe(true);
      }
    }
    expect(TRACKED_SOURCE_COINS.some((coin) =>
      coin.bridgeRouteRisk?.controls?.some((control) => control.sameChainSystemTransport != null),
    )).toBe(true);
  });

  it("rejects a contradictory observed acrdx Safe threshold before full-catalog authority projection", () => {
    const coin = structuredClone(TRACKED_SOURCE_COINS.find((entry) => entry.id === "acrdx-anemoy-apollo")!);
    expect(StablecoinMetaAssetSchema.safeParse(coin).success).toBe(true);
    const controlIndex = coin.bridgeRouteRisk!.controls!.findIndex((control) => control.id === "acrdx-ethereum-protocolguardian-safe");
    const control = coin.bridgeRouteRisk!.controls![controlIndex]!;
    expect(control.threshold).toBe(4);
    control.safe!.threshold = 1;
    const result = StablecoinMetaAssetSchema.safeParse(coin);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ["bridgeRouteRisk", "controls", controlIndex, "safe", "threshold"],
    }));
  });

  it("requires verified Safe controls to include modules or guards status", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-mint-modules",
        mintAuthority: makeMintAuthority({
          controls: [makeSafeControl({ modulesOrGuardsStatus: undefined })],
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

  it.each(["direct", "unknown"] as const)("rejects none-resolved-mint with a %s mint control", (directMintAbility) => {
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
              directMintAbility,
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

  function externalOnlyMintAuthority(overrides: Record<string, unknown> = {}) {
    return makeMintAuthority({
      mintPath: "unknown",
      authorityPosture: "none-resolved-mint",
      controls: [],
      review: {
        sources: [mintAuthoritySource],
        evidence: "The reviewed representation has no local issuance authority.",
        reviewer: "Fixture Reviewer",
        reviewedAt: "2026-05-24",
        noLocalIssuance: {
          kind: "external-only-representation",
          reviewedAt: "2026-05-24",
          reviewer: "Fixture Reviewer",
          rationale: "The reviewed routes represent external issuance and have no local native mint path.",
        },
      },
      ...overrides,
    });
  }

  it("accepts mint-scoped resolution on an unknown path with reviewed no-local issuance", () => {
    const profile = MintAuthorityProfileSchema.parse(externalOnlyMintAuthority());
    expect(profile.authorityPosture).toBe("none-resolved-mint");
    expect(profile.mintPath).toBe("unknown");
  });

  it("rejects mint-scoped resolution on an unknown path without reviewed no-local issuance", () => {
    const result = MintAuthorityProfileSchema.safeParse(makeMintAuthority({
      mintPath: "unknown",
      authorityPosture: "none-resolved-mint",
      controls: [],
    }));
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ["authorityPosture"],
      message: "authorityPosture none-resolved-mint requires a non-privileged mintPath",
    }));
  });

  it("rejects mint authorization despite reviewed no-local issuance", () => {
    const result = MintAuthorityProfileSchema.safeParse(externalOnlyMintAuthority({
      controls: [{
        label: "Mint authorizer",
        role: "direct-minter",
        authorityType: "contract",
        directMintAbility: "can-authorize",
      }],
    }));
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ["controls", 0, "directMintAbility"],
      message: "authorityPosture none-resolved-mint cannot include a control that can mint or authorize minting",
    }));
  });

  it("rejects whole-chain resolution on an unknown path despite reviewed no-local issuance", () => {
    const result = MintAuthorityProfileSchema.safeParse(externalOnlyMintAuthority({
      authorityPosture: "none-resolved",
    }));
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      path: ["authorityPosture"],
      message: "authorityPosture none-resolved requires a non-privileged mintPath",
    }));
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

  it.each([
    [{ reconciliation: "continuous" }, "Continuous proofs reconcile all circulating native liabilities to independently verifiable backing."],
    [{ reconciliation: "periodic" }, "Monthly attestations reconcile all circulating native liabilities to the stated segregated reserves."],
    [{ reconciliation: "internal-ledger" }, "The issuer's internal ledger records all native issuance and liability settlement."],
    [{ supervision: "prudential" }, "The named prudential regime supervises the issuer entity and all native token liabilities."],
    [{ supervision: "attestation-only" }, "The named attestator reports reserves covering the issuer's entire native token liabilities."],
  ] as const)("requires a review source and substantive evidence for positive process claim %j", (claim, evidence) => {
    const review = {
      sources: [mintAuthoritySource], evidence, reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24",
    };
    const profile = makeMintAuthority({ ...claim, confidence: "manual-review", review });
    expect(MintAuthorityProfileSchema.parse(profile).review.evidence).toBe(evidence);
    expect(MintAuthorityProfileSchema.safeParse({
      ...profile, review: { ...review, sources: [], sourceFreeRationale: "No claim-supporting primary source has been located." },
    }).error?.issues).toContainEqual(expect.objectContaining({ path: ["review", "sources"] }));
    for (const shortEvidence of [undefined, "The issuer operates this.", ` ${"x".repeat(39)} `]) {
      expect(MintAuthorityProfileSchema.safeParse({
        ...profile, review: { ...review, sources: [{ label: "Issuer homepage", url: "https://example.com" }], evidence: shortEvidence },
      }).error?.issues).toContainEqual(expect.objectContaining({ path: ["review", "evidence"] }));
    }
    expect(MintAuthorityProfileSchema.parse({
      ...profile, review: { ...review, evidence: ` ${evidence} ` },
    }).review.evidence?.trim()).toBe(evidence);
    if ("reconciliation" in claim && claim.reconciliation === "internal-ledger") {
      const boundaryEvidence = "The ledger records every issued balance.";
      expect(boundaryEvidence).toHaveLength(40);
      expect(MintAuthorityProfileSchema.parse({
        ...profile, review: { ...review, evidence: ` ${boundaryEvidence} ` },
      }).review.evidence?.trim()).toBe(boundaryEvidence);
    }
  });

  it("leaves reviewed absence, applicability, and unresolved process values unbound", () => {
    // These states require no invented positive process evidence.
    for (const overrides of [
      { reconciliation: "none" },
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

  it("keeps unknown mint paths paired with unknown posture unless known unbounded authority is evidenced", () => {
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

    expect(() => parseStablecoinMetaAssets(
      makeInheritanceChain(["depth-0", "depth-1", "depth-2", "depth-3"]), "fixture",
    )).toThrow(/depth/);
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

  it("keeps single-record validation lenient on parent lookups it cannot perform", () => {
    const parsed = parseStablecoinMetaAssets([
      makeCoin({
        id: "fixture-wrapped-single",
        mintAuthority: makeMintAuthority({
          mintPath: "wrapped-or-variant-inherited",
          authorityPosture: "none-resolved",
          inheritedFrom: "parent-not-in-this-catalog",
          controls: undefined,
        }),
      }),
    ], "fixture");
    expect(parsed[0]!.mintAuthority?.authorityPosture).toBe("none-resolved");
  });

  it("accepts the last valid inheritance depth of three links", () => {
    const parsed = parseStablecoinMetaAssets(
      makeInheritanceChain(["depth-0", "depth-1", "depth-2"]), "fixture",
    );
    expect(parsed.map((coin) => coin.id)).toEqual(["depth-0", "depth-1", "depth-2", "terminal"]);
  });

  it("rejects inheritance disagreeing with variantOf even when both parents exist", () => {
    const chain = makeInheritanceChain(["child"], makeCoin({
      id: "mint-parent", mintAuthority: makeMintAuthority(),
    }));
    chain[0]!.variantOf = "other-parent";
    chain[0]!.variantKind = "savings-passthrough";
    expect(() => parseStablecoinMetaAssets([
      ...chain, makeCoin({ id: "other-parent", mintAuthority: makeMintAuthority() }),
    ], "fixture")).toThrow(/inheritedFrom must match variantOf/);
  });

  it("allows mint-only none-resolved inheritance from an administered parent", () => {
    const parent = makeCoin({ id: "admin-parent", mintAuthority: makeMintAuthority() });
    const child = makeCoin({
      id: "child",
      variantOf: parent.id,
      variantKind: "savings-passthrough",
      mintAuthority: makeMintAuthority({
        mintPath: "wrapped-or-variant-inherited",
        authorityPosture: "none-resolved-mint",
        inheritedFrom: parent.id,
        controls: undefined,
      }),
    });
    const parsed = parseStablecoinMetaAssets([parent, child], "fixture");
    expect(parsed[1]!.mintAuthority?.authorityPosture).toBe("none-resolved-mint");
  });
});

describe("StablecoinMeta schema — variantOf / pegReferenceId coherence (Rule 1)", () => {
  function variantMintAuthority(parentId: string) {
    return makeMintAuthority({
      mintPath: "wrapped-or-variant-inherited",
      authorityPosture: "none-resolved",
      inheritedFrom: parentId,
      controls: undefined,
    });
  }

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
      makeCoin({ id: "fixture-variant-ok", variantOf: "variant-parent-ok",
      variantKind: "savings-passthrough",
      pegReferenceId: "variant-parent-ok",
      mintAuthority: makeMintAuthority({
        mintPath: "wrapped-or-variant-inherited",
        authorityPosture: "none-resolved",
        inheritedFrom: "variant-parent-ok",
        controls: undefined,
      }), }),
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
      makeCoin({ id: "fixture-variant-no-peg", variantOf: "variant-parent-no-peg",
      variantKind: "savings-passthrough",
      mintAuthority: makeMintAuthority({
        mintPath: "wrapped-or-variant-inherited",
        authorityPosture: "none-resolved",
        inheritedFrom: "variant-parent-no-peg",
        controls: undefined,
      }), }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects a coin with pegReferenceId only (no variantOf)", () => {
    const json = [
      makeCoin({ id: "fixture-peg-only", pegReferenceId: "usdt-tether", }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/pegReferenceId requires variantOf/);
  });

  it("rejects a coin where variantOf and pegReferenceId disagree", () => {
    const json = [
      makeCoin({ id: "fixture-variant-mismatch", variantOf: "usdt-tether",
      variantKind: "savings-passthrough",
      pegReferenceId: "usdc-circle", }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/pegReferenceId/);
  });

  it("requires risk-absorption variants to declare whether the wrapper operator is native or third-party", () => {
    const parentId = "risk-parent";
    const parent = makeCoin({
      id: parentId,
      mintAuthority: makeMintAuthority({
        mintPath: "immutable-user-collateralized",
        authorityPosture: "none-resolved",
        controls: undefined,
      }),
    });
    const child = makeCoin({
      id: "risk-child",
      flags: { ...baseFlags, navToken: true },
      variantOf: parentId,
      variantKind: "risk-absorption",
      pegReferenceId: parentId,
      mintAuthority: variantMintAuthority(parentId),
    });

    expect(() => parseStablecoinMetaAssets([parent, child], "fixture")).toThrow(/wrapperOperator/);
    expect(() => parseStablecoinMetaAssets([
      parent,
      { ...child, wrapperOperator: "third-party" },
    ], "fixture")).not.toThrow();
  });

  it("rejects wrapperOperator on unambiguous variant kinds", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({
        id: "strategy-child",
        variantOf: "strategy-parent",
        variantKind: "strategy-vault",
        wrapperOperator: "third-party",
      }),
    ], "fixture")).toThrow(/wrapperOperator/);
  });
});

// Rule 2 (reserves wrapper depType requires coinId) is NOT enforced in the schema because
// srusd-reservoir has depType "wrapper" without coinId — its wrapped parent (rusd-reservoir)
// is not a tracked coin. Curator fix needed before this invariant can be added.
// See: shared/data/stablecoins/coins/srusd-reservoir.json reserves[0]
describe("StablecoinMeta schema — reserves depType valid cases", () => {
  it("rejects authored linked reserves without depType", () => {
    expect(() => parseStablecoinMetaAssets([
      makeCoin({ id: "fixture-untyped", reserves: [
        { name: "Parent token", pct: 100, risk: "low", coinId: "usdt-tether" },
      ] }),
    ], "fixture")).toThrow(/linked reserve slices require depType/);
  });

  it("accepts a reserves entry with depType 'wrapper' and coinId set", () => {
    const json = [
      makeCoin({ id: "fixture-wrapper-ok", reserves: [
        { name: "Parent token shares", pct: 100, risk: "low", coinId: "usdt-tether", depType: "wrapper" },
      ], }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("accepts a reserves entry with depType 'collateral' and no coinId (real-world asset)", () => {
    const json = [
      makeCoin({ id: "fixture-collateral-no-coinid", reserves: [
        { name: "Tokenized Treasury Bonds", pct: 100, risk: "low", depType: "collateral" },
      ], }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).not.toThrow();
  });

  it("rejects curated reserves that do not describe a full composition", () => {
    const json = [
      makeCoin({ id: "fixture-reserves-partial", reserves: [
        { name: "USDC", pct: 40, risk: "low" },
        { name: "Treasuries", pct: 20, risk: "very-low" },
      ], }),
    ];
    expect(() => parseStablecoinMetaAssets(json, "fixture")).toThrow(/Reserve composition must sum to 100%/);
  });
});

describe("StablecoinMeta schema — error formatting", () => {
  it.each([8, 9])("formats exactly %i missing-field issues", (count) => {
    // Each otherwise-valid record omits only its name: one issue per row.
    const json = Array.from({ length: count }, (_, index) =>
      makeCoin({ id: `missing-name-${index}`, name: undefined }),
    );
    let error: unknown;
    try {
      parseStablecoinMetaAssets(json, "format-boundary");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("format-boundary");
    expect(message).toContain("0.name");
    expect(message).toContain("7.name");
    if (count === 8) {
      expect(message).not.toMatch(/more\)/);
    } else {
      expect(message).toContain("… (+1 more)");
      expect(message).not.toContain("8.name");
    }
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

  it("rejects the retired blacklistability override", () => {
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      canBeBlacklisted: true,
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

  it("requires a dated stand-in and preserves report/composition chronology", () => {
    const withReport = (report: Record<string, unknown>, compositionAsOf = "2026-06-30") =>
      makeCoin({
        ...coin(compositionAsOf),
        proofOfReserves: { type: "self-reported", url: "https://example.com/por", latestReport: report },
      });
    const standin = { ...latestReport, publishedAtBasis: "signed-date-standin" };
    expect(parseStablecoinMetaAssets([withReport(standin)], "fixture")[0].proofOfReserves?.latestReport)
      .toMatchObject({ publishedAt: "2026-07-10", publishedAtBasis: "signed-date-standin" });
    expect(() => parseStablecoinMetaAssets([withReport({ ...standin, publishedAt: undefined })], "fixture"))
      .toThrow(/publishedAtBasis requires publishedAt/);
    expect(() => parseStablecoinMetaAssets([withReport({ ...standin, publishedAt: "2026-06-29" })], "fixture"))
      .toThrow(/cannot precede periodEnd/);
    expect(() => parseStablecoinMetaAssets([withReport(standin, "2026-07-12")], "fixture"))
      .toThrow(/PoR lockstep/);
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
