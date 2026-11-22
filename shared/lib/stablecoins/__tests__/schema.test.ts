import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { StablecoinMeta, StablecoinObituary, StablecoinListingStatusReview } from "../../../types/stablecoin-meta-schemas";
import { StablecoinMetaStructuralSchema, StablecoinObituarySchema, StablecoinListingStatusReviewSchema } from "../../../types/stablecoin-meta-schemas";
import { isValidIsin, StablecoinFlagsSchema } from "../../../types/stablecoin-meta-primitives";
import {
  parseStablecoinMetaAssets,
  StablecoinComplianceSidecarSchema,
  StablecoinMetaAssetSchema,
  StablecoinMetaAssetArraySchema,
  StablecoinMetaCatalogInvariantsSchema,
  StablecoinMetaSourceAssetSchema,
  StablecoinMintAuthoritySidecarSchema,
  StablecoinRiskReviewSidecarSchema,
} from "../schema";
import { BridgeRouteRiskProfileSchema, MintAuthorityProfileSchema, OracleRiskProfileSchema } from "../../../types/stablecoin-meta-control-schemas";
import { V9DeploymentControlFactBaseSchema } from "../../../types/safety-score-v9-facts";
import { STABLECOIN_STATUS_VALUES } from "../../../types/stablecoin-taxonomy";
import { reviewedScope, weightedQuorum, SCOPE_CONTROLLER } from "../../__tests__/safety-score-v9-control-scope.test-support";
import { CANONICAL_STABLECOIN_FLAGS, makeRawStablecoinMeta as makeCoin, makeStablecoinMeta } from "./test-support";
import { makeBridgeAuthority, makeSafeControl } from "./schema.test-support";
import { makeCompiledVotingControl } from "../../__tests__/safety-score-v9-fixtures.test-support";
import { TRACKED_SOURCE_COINS, TRACKED_STABLECOINS } from "../registry";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS, LiveReservesConfigSchema } from "../../live-reserve-adapters";
import { CANONICAL_ETH_RESERVE_RISK } from "../../reserve-asset-risk";

const baseFlags = CANONICAL_STABLECOIN_FLAGS;
const mintAuthoritySource = { label: "Contract docs", url: "https://example.com/mint-authority" };
const baseObituary = {
  causeOfDeath: "abandoned", deathDate: "2026-04", epitaph: "x", obituary: "x",
  sourceUrl: "https://example.com/x", sourceLabel: "x",
};

const parseAssets = (coins: unknown[], label = "fixture") => parseStablecoinMetaAssets(coins, label);
const parseCoin = (overrides: Record<string, unknown>) => parseAssets([makeCoin(overrides)]);
const makeMintAuthority = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  mintPath: "issuer-direct-mint", authorityPosture: "partially-bounded-admin", confidence: "verified",
  summary: "Issuer minting is controlled by a reviewed Safe.", controls: [makeSafeControl()],
  review: {
    sources: [mintAuthoritySource], evidence: "The verified contract source and Safe state identify the mint authority.",
    reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24",
  },
  ...overrides,
});
const parseMint = (overrides: Record<string, unknown> = {}) => parseCoin({ mintAuthority: makeMintAuthority(overrides) });
const immutableAuthority = () => makeMintAuthority({ mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved", controls: undefined });
const inheritedAuthority = (inheritedFrom: string | undefined, extra: Record<string, unknown> = {}) =>
  makeMintAuthority({ mintPath: "wrapped-or-variant-inherited", authorityPosture: "none-resolved", inheritedFrom, controls: undefined, ...extra });

function expectIssue(
  schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } },
  input: unknown,
  path: readonly (string | number)[],
  message?: string | ReturnType<typeof expect.stringContaining>,
) {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: [...path], ...(message !== undefined ? { message } : {}) }));
}

const expectMintIssue = (input: unknown, path: readonly (string | number)[], message?: string | ReturnType<typeof expect.stringContaining>) =>
  expectIssue(MintAuthorityProfileSchema, input, path, message);

function governedMintAuthority() {
  const executionScope = reviewedScope();
  executionScope.paths[0]!.capSemantics = { kind: "unbounded", bound: null };
  const pin = { chain: "ethereum", position: "100", hash: `0x${"ab".repeat(32)}`, timestamp: "2026-10-01T00:00:00Z" };
  const review = { observedAt: "2026-10-01", reviewedAt: "2026-10-01", expiresAt: "2026-10-31", reviewer: "Fixture Reviewer", pin };
  const proofRef = "fixture-source-unknown";
  return MintAuthorityProfileSchema.parse(makeMintAuthority({
    authorityPosture: "unbounded-governed", economicCapSemantics: "unbounded",
    controls: [{
      chain: "ethereum", address: SCOPE_CONTROLLER.split(":")[1], label: "Token governor",
      role: "governor", authorityType: "dao-governor", directMintAbility: "can-authorize", executionScope,
    }],
    executionCertificates: {
      schemaVersion: 1, liabilityBookId: "fixture-book",
      evidence: [{
        id: proofRef, pin, deployment: SCOPE_CONTROLLER, kind: "verified-source", readType: null,
        function: "modeled governor source", selector: null, calldata: null, rawResult: null, sourceUrl: mintAuthoritySource.url,
        sourceLocation: "modeled authoring boundary",
        statement: "This authoring fixture identifies the source but deliberately leaves the state census unknown.", artificial: false,
      }],
      proofs: [{ id: proofRef, conclusion: "unknown", statement: "The authoring fixture does not assert a closed voting census or a positive process score.", evidenceRefIds: [proofRef] }],
      censuses: [{
        id: "fixture-census", review, targetDeployment: SCOPE_CONTROLLER, kind: "ward", role: "mint", coverage: "unknown",
        authoritativeMembers: [], observations: [],
        discovery: { kind: "source-fixed-set", fromPosition: "0", throughPosition: "100", paginationEnd: null, proofRef }, completenessProofRef: proofRef,
      }],
      classes: [], members: [],
    },
    authorityGraph: {
      id: "fixture-graph", review, liabilityBookId: "fixture-book", governorNodeId: "governor",
      nodes: [{ id: "governor", deployment: SCOPE_CONTROLLER, kind: "token-governor", terminal: true, authorityCensusIds: ["fixture-census"], runtime: null, proofRef }],
      edges: [], pathBindings: [{ path: { controlRef: SCOPE_CONTROLLER, pathId: "issuance" }, authorityNodeIds: ["governor"], provenanceNodeIds: [], closureProofRef: proofRef }],
      closureProofRef: proofRef,
    },
    governedIssuance: {
      decisionRule: "affirmative-vote", governorControlRef: SCOPE_CONTROLLER, votingPower: "lock-escrowed",
      votingPowerEvidence: "Voting weight is escrowed for the entire voting and execution interval.",
      votingControl: {
        id: "fixture-voting", governorNodeId: "governor", review, votingToken: SCOPE_CONTROLLER, totalVotingPowerRaw: null,
        pinnedVotingSupply: { deployment: SCOPE_CONTROLLER, function: "totalSupply()", raw: null, proofRef }, controllerCensusProofRef: proofRef,
        holderCensus: [], controllers: [],
        routes: [{
          id: "fixture-approval", path: { controlRef: SCOPE_CONTROLLER, pathId: "issuance" }, kind: "affirmative-approval",
          totalVotingPowerRaw: null, unilateralThresholdRaw: null, thresholdComparator: "gt", thresholdProofRef: proofRef,
          holderCensusRef: "holderCensus", controllerPowers: [], residualUpperRaw: null, residualProofRef: proofRef,
          affiliatedControllerIds: [], affiliatedAggregatePowerRaw: null, affiliatedAggregateUnilateralThresholdRaw: null,
          affiliatedAggregateThresholdComparator: "gt", affiliatedAggregateThresholdProofRef: proofRef, minorityProtectionProofRef: null,
        }],
        privilegedVoteCreation: { state: "unknown", pathRefs: [], proofRef }, forcedDelegation: { state: "unknown", pathRefs: [], proofRef },
      },
      enumerability: { authorizationEvents: ["MinterAuthorized(address)"], capacityReads: ["mintCapacity(address)"] },
      observedAt: "2026-10-01", observedBlock: 100, reviewedAt: "2026-10-01", reviewer: "Fixture Reviewer", sources: [mintAuthoritySource],
    },
  }));
}

const capSemanticsReview = {
  verdict: "bounded-by-construction" as const,
  rationale: "The verified mint implementation requires a matching collateral deposit before every issuance, including issuances authorized by administrators.",
  reviewedAt: "2026-10-01", reviewer: "Fixture Reviewer", sources: [mintAuthoritySource],
};

describe("schema-derived catalog contracts", () => {
  it("retains source defaults and canonical output types", () => {
    expectTypeOf<z.output<typeof StablecoinMetaStructuralSchema>>().toEqualTypeOf<StablecoinMeta>();
    expectTypeOf<z.output<typeof StablecoinObituarySchema>>().toEqualTypeOf<StablecoinObituary>();
    expectTypeOf<z.output<typeof StablecoinListingStatusReviewSchema>>().toEqualTypeOf<StablecoinListingStatusReview>();
    expectTypeOf<z.input<typeof StablecoinMetaSourceAssetSchema>["flags"]>().toEqualTypeOf<z.input<typeof StablecoinFlagsSchema>>();
    expectTypeOf<z.output<typeof StablecoinMetaAssetSchema>>().toEqualTypeOf<StablecoinMeta>();
    const source: z.input<typeof StablecoinMetaSourceAssetSchema> = {
      id: "fixture-usd", name: "Fixture USD", symbol: "FUSD",
      flags: { backing: "rwa-backed", governance: "centralized" },
    };
    expect(StablecoinMetaSourceAssetSchema.parse(source).flags).toEqual({
      ...source.flags, pegCurrency: "USD", yieldBearing: false, rwa: false, navToken: false,
    });
  });
});

describe("token identifiers", () => {
  const source = { id: "fixture-fund", name: "Fixture Fund", symbol: "FFND", flags: { backing: "rwa-backed", governance: "centralized" } } as const;

  it.each(["FR0014015LD3", "FR0014015LE1", "US0378331005", "KYG3R61G1088"])("admits ISIN %s", (isin) => {
    expect(isValidIsin(isin)).toBe(true);
    expect(StablecoinMetaSourceAssetSchema.parse({ ...source, identifiers: { isin: [isin] } }).identifiers).toEqual({ isin: [isin] });
  });

  it.each(["FR0014015LD4", "fr0014015ld3", "FR0014015LD", "0R0014015LD3"])("rejects malformed ISIN %s", (isin) => {
    expect(isValidIsin(isin)).toBe(false);
    expect(StablecoinMetaSourceAssetSchema.safeParse({ ...source, identifiers: { isin: [isin] } }).success).toBe(false);
  });

  it("rejects empty, duplicate and unknown identifier entries", () => {
    for (const identifiers of [{ isin: [] }, { isin: ["FR0014015LD3", "FR0014015LD3"] }, { cusip: "037833100" }]) {
      expect(StablecoinMetaSourceAssetSchema.safeParse({ ...source, identifiers }).success).toBe(false);
    }
  });

  it("keeps every authored registry ISIN checksum-valid and unique to one token", () => {
    const owners = new Map<string, string>();
    for (const coin of TRACKED_SOURCE_COINS) {
      for (const isin of coin.identifiers?.isin ?? []) {
        expect(owners.get(isin), `${isin} on ${coin.id}`).toBeUndefined();
        owners.set(isin, coin.id);
      }
    }
    expect(owners.get("FR0014015LD3")).toBe("eursafo-spiko");
  });
});

describe("bridge route deployment identity admission", () => {
  const address = "0x52908400098527886E0F7030069857D2E4169EE7";
  const normalizedId = "ethereum:0x52908400098527886e0f7030069857d2e4169ee7";
  const source = { label: "Fixture review", url: "https://example.com/review" };
  const fixture = makeStablecoinMeta({
    contracts: [{ chain: "ethereum", address, decimals: 18 }],
    bridgeRouteRisk: {
      tier: "single-chain-or-native", summary: "Reviewed native deployment.", reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer", confidence: "verified", sources: [source],
      routes: [{
        id: normalizedId, destinationChain: "ethereum", contractAddress: address, protocol: "Fixture issuer",
        issuanceModel: "native-issuance", routeClass: "native", riskTier: "single-chain-or-native",
        semantics: "native-mint", scope: "canonical", reviewDisposition: "reviewed", observedAt: "1970-01-01", sources: [source],
      }],
    },
  });

  it("admits a checksummed address with its normalized route ID", () => {
    expect(parseAssets([fixture], "route identity fixture")[0].bridgeRouteRisk!.routes![0].contractAddress).toBe(address);
  });

  it.each([
    "base:0x52908400098527886e0f7030069857d2e4169ee7",
    "ethereum:0x3333333333333333333333333333333333333333",
  ])("rejects mismatched route ID %s despite matching authored destination fields", (id) => {
    const coin = structuredClone(fixture);
    coin.bridgeRouteRisk!.routes![0].id = id;
    expectIssue(StablecoinMetaAssetSchema, coin, ["bridgeRouteRisk", "routes", 0, "id"], expect.stringContaining("[mint-bridge-ownership:route-deployment-identity-mismatch]"));
    expect(() => parseAssets([coin], "route identity fixture")).toThrow("[mint-bridge-ownership:route-deployment-identity-mismatch]");
  });
});

describe("calendar-only catalog dates", () => {
  const listingReview = { changedAt: "2024-02-29", reason: "Reviewed listing status." };
  const coverage = { startDate: "2024-02-29", reviewedAt: "2024-03-01", basis: "audited-replay-and-live", notes: "Reviewed continuous detector history." };
  const fields: Array<[string, (date: string) => Record<string, unknown>]> = [
    ["listingStatusReview.changedAt", (d) => ({ listingStatusReview: { ...listingReview, changedAt: d } })],
    ["listingStatusReview.reviewBy", (d) => ({ listingStatusReview: { ...listingReview, reviewBy: d } })],
    ["windDownAnnouncedAt", (d) => ({ windDownAnnouncedAt: d })],
    ["frozenAt", (d) => ({ frozenAt: d })],
    ["pegScoreCoverage.startDate", (d) => ({ pegScoreCoverage: { ...coverage, startDate: d } })],
    ["pegScoreCoverage.reviewedAt", (d) => ({ pegScoreCoverage: { ...coverage, reviewedAt: d } })],
    ["notices.0.deadline", (d) => ({ notices: [{ type: "warning", title: "T", message: "M", kind: "deadline", deadline: d }] })],
    ["notices.0.asOf", (d) => ({ notices: [{ type: "danger", title: "T", message: "M", asOf: d }] })],
  ];

  describe.each(fields)("%s", (field, overrides) => {
    it.each(["2023-02-29", "2024-02-30", "2024-04-31", "2024-13-01"])("rejects impossible calendar day %s at source admission", (date) => {
      const result = StablecoinMetaSourceAssetSchema.safeParse(makeCoin(overrides(date)));
      expect(result.success).toBe(false);
      if (result.success) throw new Error("impossible calendar date was admitted");
      expect(result.error.issues.map((e) => e.path.join("."))).toContain(field);
    });

    it("preserves a valid leap day", () => {
      const coin = makeCoin(overrides("2024-02-29"));
      expect(StablecoinMetaSourceAssetSchema.parse(coin)).toEqual(coin);
    });
  });

  it.each([{ kind: "deadline" }, { kind: "paused", deadline: "2026-11-26" }])("couples a notice deadline date to kind deadline (%o)", (extra) => {
    expect(StablecoinMetaSourceAssetSchema.safeParse(makeCoin({ notices: [{ type: "warning", title: "T", message: "M", ...extra }] })).success).toBe(false);
  });

  it.each(["2024", "2024-02", "2024-Q1", "2024-H1", "2024-02-29"])("keeps fuzzy launch-date precision %s", (date) => {
    expect(StablecoinMetaAssetSchema.parse(makeCoin({ launchDate: date })).launchDate).toBe(date);
  });
});

describe.each([StablecoinMetaAssetArraySchema, StablecoinMetaCatalogInvariantsSchema])("catalog deployment ownership", (schema) => {
  const deployment = { chain: "ethereum", address: "0xabcdef0000000000000000000000000000000000", decimals: 6 };

  // Nightly tier: parses the whole tracked source catalog.
  it("admits the full tracked source catalog", { tags: ["nightly"] }, () => {
    expect(schema.safeParse(TRACKED_SOURCE_COINS).success).toBe(true);
  });

  it.each([
    ["contracts", "contracts"], ["contracts", "tradedContracts"],
    ["tradedContracts", "contracts"], ["tradedContracts", "tradedContracts"],
  ] as const)("rejects cross-ID %s/%s deployment ownership", (firstList, listName) => {
    const coins = [
      StablecoinMetaAssetSchema.parse(makeCoin({ id: "alpha-usd", [firstList]: [deployment] })),
      StablecoinMetaAssetSchema.parse(makeCoin({ id: "beta-usd", [listName]: [{ ...deployment, address: deployment.address.toUpperCase().replace("0X", "0x") }] })),
    ];
    const result = schema.safeParse(coins);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("collision was admitted");
    expect(result.error.issues.map((e) => e.path)).toEqual([[0, firstList, 0, "address"], [1, listName, 0, "address"]]);
    expect(result.error.issues[0].message).toContain(`alpha-usd.${firstList}[0]`);
    expect(result.error.issues[0].message).toContain(`beta-usd.${listName}[0]`);
  });

  it("preserves chain separation and case-sensitive native deployment identities", () => {
    const coins = [
      makeCoin({ id: "alpha-usd", contracts: [deployment] }),
      makeCoin({ id: "beta-usd", contracts: [{ ...deployment, chain: "arbitrum" }] }),
      makeCoin({ id: "gamma-usd", contracts: [{ ...deployment, chain: "solana", address: "NativeMintAbC" }] }),
      makeCoin({ id: "delta-usd", contracts: [{ ...deployment, chain: "solana", address: "NativeMintabc" }] }),
    ].map((c) => StablecoinMetaAssetSchema.parse(c));
    expect(schema.safeParse(coins).success).toBe(true);
    expect(schema.safeParse([...coins.slice(0, 3), { ...coins[3], contracts: coins[2].contracts }]).success).toBe(false);
  });
});

describe("StablecoinMeta schema — reserve and manual dependency roles", () => {
  const roleFixture = (economicRole: "control-operator" | "basket-exposure") => makeCoin({
    id: "usdm-mega",
    reserves: [{ name: "USDtb backing", pct: 100, risk: "low", coinId: "usdtb-ethena", depType: "collateral" }],
    dependencies: [{ id: "usdtb-ethena", weight: 0.001, type: "collateral" }],
    dependencyReview: {
      reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
      sources: [{ label: "Issuer rails", url: "https://example.com/rails" }],
      rationale: "The issuer's operator is separate from the measured reserve share.",
      relationships: [{ id: "usdtb-ethena", weight: 0.001, type: "collateral", economicRole, reason: "Reviewed issuer operator role." }],
    },
  });

  it("admits a sourced control-operator review alongside reserves for the same upstream", () => {
    const parsed = parseAssets([roleFixture("control-operator")]);
    expect(parsed[0].dependencyReview?.relationships[0].economicRole).toBe("control-operator");
    expect(parsed[0].dependencies).toEqual([{ id: "usdtb-ethena", weight: 0.001, type: "collateral" }]);
  });

  it("rejects a redundant manual collateral basket review for a reserve-owned upstream", () => {
    expect(() => parseAssets([roleFixture("basket-exposure")])).toThrow(/redundant reserve metadata/);
  });

  it("admits a variant parent wrapper review when reserves express the same serial claim", () => {
    const parsed = parseAssets([
      makeCoin({
        id: "iusd-initia", variantOf: "ausd-agora", variantKind: "pure-wrapper",
        mintAuthority: inheritedAuthority("ausd-agora"),
        reserves: [{ name: "Agora AUSD", pct: 100, risk: "low", coinId: "ausd-agora", depType: "wrapper" }],
        dependencyReview: {
          reviewedAt: "2026-09-30", reviewer: "Fixture reviewer", confidence: "verified",
          sources: [{ label: "Issuer wrapper", url: "https://example.com/wrapper" }],
          rationale: "The reserve identity also documents the variant's serial parent.",
          relationships: [{ id: "ausd-agora", weight: 1, type: "wrapper", economicRole: "serial-claim", reason: "The variant is a claim on its AUSD parent." }],
        },
      }),
      makeCoin({ id: "ausd-agora", mintAuthority: immutableAuthority() }),
    ]);
    expect(parsed[0].variantOf).toBe("ausd-agora");
    expect(parsed[0].dependencyReview?.relationships[0].economicRole).toBe("serial-claim");
  });

  it("rejects mixed-source collateral that has no linked reserve identity", () => {
    const f = roleFixture("control-operator");
    f.dependencies = [{ id: "missing-upstream", weight: 0.001, type: "collateral" }];
    expect(() => parseAssets([f])).toThrow(/manual-collateral-not-in-reserves/);
  });
});

describe("StablecoinMeta schema — MiCA profile", () => {
  it("validates source requirements and out-of-scope rules", () => {
    expect(() => parseCoin({ id: "fixture-mica-negative", mica: { status: "non-compliant", tokenType: "EMT" } })).toThrow(/source reference/);
    expect(() => parseCoin({ id: "fixture-mica-out-of-scope", mica: { status: "out-of-scope" } })).not.toThrow();
    expect(() => parseCoin({ id: "fixture-mica-out-of-scope-token-type", mica: { status: "out-of-scope", tokenType: "EMT" } })).toThrow(/out-of-scope/);
  });
});

describe("Mint authority D14/D29 evidence admission", () => {
  it("admits sourced governance for an exact authored governor with execution scope", () => {
    const profile = governedMintAuthority();
    expect(profile.authorityPosture).toBe("unbounded-governed");
    expect(profile.governedIssuance?.governorControlRef).toBe(SCOPE_CONTROLLER);
  });

  it.each(["bounded", undefined] as const)("rejects governed issuance without unbounded economics (%s)", (economicCapSemantics) => {
    expectMintIssue({ ...governedMintAuthority(), economicCapSemantics }, ["economicCapSemantics"], "governedIssuance requires economicCapSemantics unbounded");
  });

  it("requires the governor reference to resolve exactly once", () => {
    const profile = governedMintAuthority();
    for (const controls of [[], [...profile.controls!, profile.controls![0]!]]) {
      expectMintIssue({ ...profile, controls }, ["governedIssuance", "governorControlRef"], "governedIssuance.governorControlRef must resolve to exactly one authored EVM control");
    }
  });

  it("rejects a non-governor reference and a governor without an execution certificate", () => {
    const profile = governedMintAuthority();
    const gov = profile.controls![0]!;
    expectMintIssue({ ...profile, controls: [{ ...gov, authorityType: "contract" }] }, ["governedIssuance", "governorControlRef"], "governedIssuance.governorControlRef must name a dao-governor control");
    expectMintIssue({ ...profile, controls: [{ ...gov, executionScope: undefined }] }, ["controls", 0, "executionScope"], "governedIssuance governor control requires executionScope");
  });

  it.each(["holding-period-weighted", "lock-escrowed", "past-block-checkpoint"] as const)("rejects signer-quorum claims on a %s governor", (votingPower) => {
    const profile = governedMintAuthority();
    const gov = profile.controls![0]!;
    const weighted = {
      scheme: "contract", deployment: SCOPE_CONTROLLER, signers: [{ account: gov.address!, weight: 1 }], quorum: 1,
      pin: gov.executionScope!.pin, status: "verified", reviewedAt: "2026-10-01", expiresAt: "2026-10-31", reviewer: "Fixture Reviewer", sources: [mintAuthoritySource],
    };
    for (const quorum of [{ threshold: 1 }, { signerCount: 1 }, { weightedQuorum: weighted }]) {
      expectMintIssue({ ...profile, controls: [{ ...gov, ...quorum }], governedIssuance: { ...profile.governedIssuance!, votingPower } }, ["governedIssuance", "governorControlRef"]);
    }
  });

  it.each(["live-balance", "unknown"] as const)("does not apply the token-voting quorum prohibition to %s voting power", (votingPower) => {
    const profile = governedMintAuthority();
    expect(MintAuthorityProfileSchema.parse({
      ...profile, controls: [{ ...profile.controls![0]!, threshold: 1, signerCount: 1 }],
      governedIssuance: { ...profile.governedIssuance!, votingPower },
    }).governedIssuance?.votingPower).toBe(votingPower);
  });

  it.each([{ inheritedFrom: "parent-fixture" }, { mintPath: "wrapped-or-variant-inherited" }])("rejects governed issuance on inherited or wrapped profiles (%j)", (inherited) => {
    expectMintIssue({ ...governedMintAuthority(), ...inherited }, ["governedIssuance"]);
  });

  it("rejects governed issuance when every authored execution path is bounded", () => {
    const profile = governedMintAuthority();
    profile.controls![0]!.executionScope!.paths[0]!.capSemantics = { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
    expectMintIssue(profile, ["governedIssuance"]);
  });

  it.each([
    { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "none" },
    { capSemantics: { kind: "unknown", bound: null }, claimImpairment: "none" },
    { capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "unbounded" },
    { capSemantics: { kind: "not-applicable", bound: null }, claimImpairment: "unknown" },
  ] as const)("admits unbounded economics on another authored control's parameter path (%j)", (economics) => {
    const profile = governedMintAuthority();
    const gov = profile.controls![0]!;
    gov.executionScope!.paths[0]!.capSemantics = { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } };
    const deployment = "ethereum:0x2222222222222222222222222222222222222222";
    const scope = reviewedScope({ controllerDeployment: deployment });
    scope.paths[0] = { ...scope.paths[0]!, targetDeployment: deployment, capabilities: ["parameter-change"], ...economics };
    profile.controls!.push({
      ...gov, address: deployment.split(":")[1], label: "Governed parameter control",
      authorityType: "contract", directMintAbility: "parameter-only", executionScope: scope,
    });
    expect(MintAuthorityProfileSchema.parse(profile).governedIssuance?.governorControlRef).toBe(SCOPE_CONTROLLER);
  });

  it("rejects a non-EVM governor reference", () => {
    const profile = governedMintAuthority();
    expectMintIssue(
      { ...profile, governedIssuance: { ...profile.governedIssuance!, governorControlRef: "xrpl:rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK" } },
      ["governedIssuance", "governorControlRef"], expect.stringContaining("EVM"),
    );
  });

  it("requires governed evidence only for the governed posture and an explicit decision rule", () => {
    const profile = governedMintAuthority();
    expectMintIssue({ ...profile, governedIssuance: undefined }, ["governedIssuance"]);
    expect(MintAuthorityProfileSchema.parse({ ...profile, authorityPosture: "unbounded-adverse", governedIssuance: undefined }).authorityPosture).toBe("unbounded-adverse");
    expectMintIssue({ ...profile, governedIssuance: { ...profile.governedIssuance!, decisionRule: undefined } }, ["governedIssuance", "decisionRule"]);
  });

  const veto = {
    quorumBps: 200, entrypoints: ["0x12345678"], override: "symmetric-vote-destruction",
    evidence: "The pinned governor veto rejects admission during the entire public window; canceling a veto destroys the caller's equal voting power.",
  } as const;
  const vetoProfile = (govOverrides: Record<string, unknown> = {}) => {
    const profile = governedMintAuthority();
    return { ...profile, authorityPosture: "unbounded-veto-guarded", governedIssuance: { ...profile.governedIssuance!, decisionRule: "minority-veto", veto, ...govOverrides } };
  };

  it.each([["affirmative-vote", veto], ["minority-veto", undefined]] as const)("requires veto evidence iff the decision rule is %s", (decisionRule, vetoEvidence) => {
    const profile = governedMintAuthority();
    expectMintIssue({ ...profile, authorityPosture: "unbounded-adverse", governedIssuance: { ...profile.governedIssuance!, decisionRule, veto: vetoEvidence } }, ["governedIssuance", "veto"]);
  });

  it.each([
    ["unbounded-governed", "minority-veto"],
    ["unbounded-veto-guarded", "affirmative-vote"],
    ["unbounded-veto-guarded", undefined],
  ] as const)("rejects %s without its matching process evidence (%s)", (authorityPosture, decisionRule) => {
    const profile = governedMintAuthority();
    expectMintIssue({
      ...profile, authorityPosture,
      governedIssuance: decisionRule ? { ...profile.governedIssuance!, decisionRule, veto: decisionRule === "minority-veto" ? veto : undefined } : undefined,
    }, decisionRule ? ["governedIssuance", "decisionRule"] : ["governedIssuance"]);
  });

  it.each([
    { quorumBps: 0 }, { quorumBps: 10001 }, { quorumBps: 200.5 }, { entrypoints: [] },
    { entrypoints: ["veto(address)"] }, { entrypoints: ["0x1234567A"] }, { override: "majority" }, { evidence: "x".repeat(79) }, { unexpected: true },
  ])("rejects malformed veto evidence %j", (change) => {
    expect(MintAuthorityProfileSchema.safeParse(vetoProfile({ veto: { ...veto, ...change } })).success).toBe(false);
  });

  it.each(["none", "symmetric-vote-destruction", "unknown"] as const)("preserves the reviewed %s veto override without assuming qualification", (override) => {
    const parsed = MintAuthorityProfileSchema.parse(vetoProfile({ votingPower: "holding-period-weighted", veto: { ...veto, override } }));
    expect(parsed.governedIssuance).toMatchObject({ decisionRule: "minority-veto", veto: { override } });
  });

  const monetaryPath = {
    controlRef: SCOPE_CONTROLLER, pathId: "issuance", rateCapPpm: 100000, rateChangeDelaySec: 172800, rateChangeRule: "minority-replaceable",
    evidence: "The pinned mint path is limited to deposits times a hard-capped rate times elapsed time; every rate change is minority-blockable for two days.",
  };

  it.each([{ controlRef: "ethereum:0x2222222222222222222222222222222222222222" }, { pathId: "missing-path" }])(
    "rejects unresolved monetary-policy path references %j (R-l)", (change) => {
      expectMintIssue(vetoProfile({ monetaryPolicyPaths: [{ ...monetaryPath, ...change }] }), ["governedIssuance", "monetaryPolicyPaths", 0]);
    },
  );

  it.each([
    { rateCapPpm: 0 }, { rateCapPpm: 1.5 }, { rateChangeDelaySec: -1 }, { rateChangeDelaySec: 0.5 },
    { rateChangeRule: "majority" }, { evidence: "x".repeat(79) }, { unexpected: true },
  ])("rejects malformed monetary-policy evidence %j", (change) => {
    expect(MintAuthorityProfileSchema.safeParse(vetoProfile({ monetaryPolicyPaths: [{ ...monetaryPath, ...change }] })).success).toBe(false);
  });

  it.each([{ monetaryPolicyPaths: [] }, { monetaryPolicyPaths: [monetaryPath] }])("forbids a monetary-policy inventory on affirmative voting", ({ monetaryPolicyPaths }) => {
    const profile = governedMintAuthority();
    expectMintIssue({ ...profile, governedIssuance: { ...profile.governedIssuance!, monetaryPolicyPaths } }, ["governedIssuance", "monetaryPolicyPaths"]);
  });

  const restructure = {
    entrypoints: ["0xabcdef01"], equityThresholdUnits: 1000, observedEquityUnits: 1001, dependentPaths: [],
    evidence: "Pinned equity is above the insolvency threshold; only the gated restructure can wipe share supply to zero, and ordinary redemption retains a share.",
  };

  it.each([["insolvency-gated-restructure", undefined], ["none", restructure], ["symmetric-vote-destruction", restructure]] as const)(
    "requires restructure evidence iff override is %s", (override, evidence) => {
      expectMintIssue(vetoProfile({ veto: { ...veto, override, restructure: evidence } }), ["governedIssuance", "veto", "restructure"]);
    },
  );

  it.each([
    { equityThresholdUnits: 0 }, { observedEquityUnits: -1 }, { entrypoints: [] }, { entrypoints: ["0xABCDE001"] },
    { evidence: "x".repeat(79) }, { dependentPaths: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance", unexpected: true }] }, { unexpected: true },
  ])("rejects malformed restructure evidence %j", (change) => {
    expect(MintAuthorityProfileSchema.safeParse(vetoProfile({
      veto: { ...veto, override: "insolvency-gated-restructure", restructure: { ...restructure, ...change } },
    })).success).toBe(false);
  });

  it.each(["raiseable", "bounded", "collateral-gated"] as const)("requires the correct sourced D14 verdict for %s issuance authority", (economicCapSemantics) => {
    const verdict = economicCapSemantics === "raiseable" ? "raiseable-collateral-only" : "bounded-by-construction";
    const wrongVerdict = verdict === "bounded-by-construction" ? "raiseable-collateral-only" : "bounded-by-construction";
    for (const ability of [
      { directMintAbility: "direct" }, { directMintAbility: "can-authorize" },
      { directMintAbility: "cap-limited", canRaiseCap: true }, { directMintAbility: "parameter-only", canRaiseCap: true },
      { directMintAbility: "upgrade-only", canRaiseCap: true }, { directMintAbility: "none", canRaiseCap: true }, { directMintAbility: "unknown", canRaiseCap: true },
    ]) {
      const profile = makeMintAuthority({ economicCapSemantics, controls: [makeSafeControl(ability)] });
      expectMintIssue(profile, ["capSemanticsReview"]);
      expect(MintAuthorityProfileSchema.parse({ ...profile, capSemanticsReview: { ...capSemanticsReview, verdict } }).capSemanticsReview?.verdict).toBe(verdict);
      expectMintIssue({ ...profile, capSemanticsReview: { ...capSemanticsReview, verdict: wrongVerdict } }, ["capSemanticsReview", "verdict"]);
    }
  });

  it.each([
    { directMintAbility: "cap-limited", canRaiseCap: false }, { directMintAbility: "cap-limited", canRaiseCap: "unknown" },
    { directMintAbility: "parameter-only", canRaiseCap: false }, { directMintAbility: "parameter-only", canRaiseCap: "unknown" },
    { directMintAbility: "upgrade-only", canRaiseCap: false }, { directMintAbility: "none" },
  ])("does not invent a D14 issuance trigger for %j", (ability) => {
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({ economicCapSemantics: "bounded", controls: [makeSafeControl(ability)] })).capSemanticsReview).toBeUndefined();
  });

  it.each(["unbounded", "unknown"] as const)("rejects a cap review on %s economics", (economicCapSemantics) => {
    expectMintIssue(makeMintAuthority({ economicCapSemantics, capSemanticsReview }), ["capSemanticsReview"]);
  });

  it("reserves compromised posture for an active incident in both directions", () => {
    const incident = { date: "2026-05-20", status: "active", summary: "The mint key remains compromised.", sources: [mintAuthoritySource] };
    const resolved = { ...incident, status: "resolved", resolvedAt: "2026-05-21" };
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({ authorityPosture: "compromised", mintIncidents: [incident] })).mintIncidents?.[0]?.status).toBe("active");
    for (const overrides of [{ authorityPosture: "compromised" }, { authorityPosture: "compromised", mintIncidents: [resolved] }, { authorityPosture: "unbounded-adverse", mintIncidents: [incident] }]) {
      expectMintIssue(makeMintAuthority(overrides), ["authorityPosture"]);
    }
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({ mintIncidents: [resolved] })).authorityPosture).toBe("partially-bounded-admin");
  });

  it("admits genuinely unknown authority and bounds adverse annotations on unknown mint paths", () => {
    expect(MintAuthorityProfileSchema.parse(makeMintAuthority({ mintPath: "unknown", authorityPosture: "unknown", confidence: "unknown", controls: [] })).authorityPosture).toBe("unknown");
    const profile = makeMintAuthority({ mintPath: "unknown", authorityPosture: "unbounded-adverse", confidence: "unknown" });
    for (const economicCapSemantics of [undefined, "unknown", "bounded", "raiseable", "collateral-gated"]) {
      expectMintIssue({ ...profile, economicCapSemantics }, ["authorityPosture"]);
    }
    expect(MintAuthorityProfileSchema.parse({ ...profile, economicCapSemantics: "unbounded" }).authorityPosture).toBe("unbounded-adverse");
  });

  it.each([
    { capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "bounded" },
    { capSemantics: { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } }, claimImpairment: "unbounded" },
  ] as const)("admits known unbounded execution economics without inventing aggregate semantics (%j)", (economics) => {
    const executionScope = reviewedScope();
    executionScope.paths[0] = { ...executionScope.paths[0]!, ...economics };
    const profile = MintAuthorityProfileSchema.parse(makeMintAuthority({
      mintPath: "unknown", authorityPosture: "unbounded-adverse", confidence: "manual-review",
      controls: [{ chain: "ethereum", address: SCOPE_CONTROLLER.split(":")[1], label: "Reviewed issuer authority", role: "direct-minter", authorityType: "contract", directMintAbility: "direct", executionScope }],
    }));
    expect(profile.authorityPosture).toBe("unbounded-adverse");
    expect(profile.economicCapSemantics).toBeUndefined();
  });

  it.each(["unbounded-reconciliation-unknown", "unbounded-unreconciled"])("rejects retired posture %s in profiles, sidecars, and every listing status", (authorityPosture) => {
    const mintAuthority = makeMintAuthority({ authorityPosture: "unbounded-adverse", economicCapSemantics: "unbounded" });
    expectMintIssue({ ...mintAuthority, authorityPosture }, ["authorityPosture"]);
    expectIssue(StablecoinMintAuthoritySidecarSchema, { id: "fixture-usd", mintAuthority: { ...mintAuthority, authorityPosture } }, ["mintAuthority", "authorityPosture"]);
    for (const status of STABLECOIN_STATUS_VALUES) {
      const coin = makeCoin({
        status, mintAuthority,
        ...(status === "frozen" ? { frozenAt: "2026-05-24", obituary: { ...baseObituary, deathDate: "2026-05", sourceUrl: mintAuthoritySource.url, sourceLabel: mintAuthoritySource.label } } : {}),
        ...(status === "quarantined" || status === "delisted" ? { listingStatusReview: { changedAt: "2026-05-24", reason: "The issuer's listing remains under review.", reviewBy: "2026-06-24", source: mintAuthoritySource } } : {}),
      });
      expect(() => parseAssets([coin])).not.toThrow();
      expect(() => parseAssets([{ ...coin, mintAuthority: { ...mintAuthority, authorityPosture } }])).toThrow(/authorityPosture/);
    }
  });

  it("rejects a governed posture on an unknown mint path and trims/validates strict evidence blocks", () => {
    const profile = governedMintAuthority();
    expectMintIssue({ ...profile, mintPath: "unknown" }, ["authorityPosture"]);
    const gov = profile.governedIssuance!;
    expect(MintAuthorityProfileSchema.parse({ ...profile, governedIssuance: { ...gov, votingPowerEvidence: `  ${gov.votingPowerEvidence}  ` } }).governedIssuance?.votingPowerEvidence).toBe(gov.votingPowerEvidence);
    for (const change of [
      { votingPowerEvidence: ` ${"x".repeat(39)} ` }, { sources: [] }, { observedBlock: 0 },
      { governorControlRef: SCOPE_CONTROLLER.replace("ethereum", "Ethereum") },
      { enumerability: { authorizationEvents: [], capacityReads: ["capacity()"] } }, { unexpected: true },
    ]) {
      expect(MintAuthorityProfileSchema.safeParse({ ...profile, governedIssuance: { ...gov, ...change } }).success).toBe(false);
    }
    for (const change of [{ rationale: ` ${"x".repeat(79)} ` }, { sources: [] }, { unexpected: true }]) {
      expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({ economicCapSemantics: "bounded", capSemanticsReview: { ...capSemanticsReview, ...change } })).success).toBe(false);
    }
  });
});

describe("Compiled issuance governance contract", () => {
  const schema = V9DeploymentControlFactBaseSchema.shape.issuanceGovernance;
  const complete = {
    coverage: "complete", incompleteReasons: [], governorAuthorityKey: SCOPE_CONTROLLER, minUnavoidableDelaySec: 172800,
    votingPower: "past-block-checkpoint", enumerable: true, nonGovernorUnboundedPathKeys: [], decisionRule: "affirmative-vote",
    vetoQuorumBps: null, vetoOverride: null, votingControl: makeCompiledVotingControl(), diagnostics: [],
  };

  it("preserves absent evidence, sorts canonical lists, and rejects invalid shapes", () => {
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse({ ...complete, coverage: "incomplete", incompleteReasons: ["review-incomplete"], minUnavoidableDelaySec: null }))
      .toMatchObject({ coverage: "incomplete", incompleteReasons: ["review-incomplete"], minUnavoidableDelaySec: null });
    expect(schema.parse({ ...complete, coverage: "incomplete", incompleteReasons: ["z", "a"], nonGovernorUnboundedPathKeys: ["z:issuance", "a:issuance"] }))
      .toMatchObject({ incompleteReasons: ["a", "z"], nonGovernorUnboundedPathKeys: ["a:issuance", "z:issuance"] });
    for (const change of [
      { coverage: "incomplete" }, { incompleteReasons: ["review-incomplete"] },
      { coverage: "incomplete", incompleteReasons: ["a", "a"] }, { nonGovernorUnboundedPathKeys: ["a:issuance", "a:issuance"] },
      { minUnavoidableDelaySec: -1 }, { minUnavoidableDelaySec: 0.5 }, { votingPower: "instant-snapshot" }, { unexpected: true },
    ]) {
      expect(schema.safeParse({ ...complete, ...change }).success).toBe(false);
    }
  });
});

const makeInheritanceChain = (ids: string[], terminal = makeCoin({ id: "terminal", mintAuthority: immutableAuthority() })) => [
  ...ids.map((id, i) => makeCoin({ id, mintAuthority: makeMintAuthority({ mintPath: "wrapped-or-variant-inherited", inheritedFrom: ids[i + 1] ?? terminal.id, controls: undefined }) })),
  terminal,
];

describe("StablecoinMeta schema — frozen, wind-down, and listing lifecycle status", () => {
  it("enforces frozen obituary/frozenAt coupling and rejects stray obituaries on active coins", () => {
    expect(() => parseCoin({ id: "fixture-frozen-bad", status: "frozen", frozenAt: "2026-04-27" })).toThrow(/obituary/);
    expect(() => parseCoin({ id: "fixture-frozen-bad-2", status: "frozen", obituary: baseObituary })).toThrow(/frozenAt/);
    expect(() => parseCoin({ id: "fixture-active-bad", status: "active", obituary: baseObituary })).toThrow(/obituary is only allowed when status is frozen/);
  });

  it("accepts dated issuer wind-down evidence", () => {
    expect(() => parseCoin({ windDownAnnouncedAt: "2026-05-24", windDownSourceUrl: "https://issuer.example.com/wind-down" })).not.toThrow();
  });

  it("validates quarantined, delisted, and active listingStatusReview constraints", () => {
    expect(() => parseCoin({ status: "quarantined", listingStatusReview: { changedAt: "2026-07-15", reason: "Runtime price and supply coverage require remediation.", reviewBy: "2026-08-15" } })).not.toThrow();
    expect(() => parseCoin({ status: "quarantined", listingStatusReview: { changedAt: "2026-07-15", reason: "Runtime coverage is unresolved." } })).toThrow(/reviewBy/);
    expect(() => parseCoin({ status: "delisted", listingStatusReview: { changedAt: "2026-07-15", reason: "Outside stablecoin listing scope.", source: { label: "Issuer product terms", url: "https://example.com/product-terms" } } })).not.toThrow();
    expect(() => parseCoin({ status: "active", listingStatusReview: { changedAt: "2026-07-15", reason: "Stray review metadata." } })).toThrow(/only allowed/);
  });
});

describe("StablecoinMeta schema — launched pre-launch phase", () => {
  const launched = (overrides: Record<string, unknown> = {}) => makeCoin({
    status: "pre-launch", launchPhase: "launched", launchDate: "2026-10-15",
    milestones: [{ date: "2026-10-15", type: "milestone", title: "Mainnet issuance", sourceUrl: "https://example.com/launch" }],
    listingStatusReview: { changedAt: "2026-10-20", reason: "Launched on Ethereum; no admitted price lane yet.", reviewBy: "2026-12-19" },
    ...overrides,
  });

  it("accepts a dated, sourced launch with a review inside the 60-day dwell", () => {
    expect(() => parseAssets([launched()])).not.toThrow();
  });

  it.each([
    ["launched outside pre-launch", { status: "active" }, /only allowed on pre-launch rows/],
    ["missing launchDate", { launchDate: undefined }, /requires launchDate/],
    ["unsourced milestone", { milestones: [{ date: "2026-10-15", type: "milestone", title: "Unsourced launch" }] }, /sourced milestone/],
    ["milestone before launch", { milestones: [{ date: "2026-09-01", type: "announcement", title: "Pre-launch announcement", sourceUrl: "https://example.com/a" }] }, /sourced milestone/],
    ["missing listingStatusReview", { listingStatusReview: undefined }, /reviewBy/],
    ["reviewBy over 60 days", { listingStatusReview: { changedAt: "2026-10-20", reason: "No admitted price lane yet.", reviewBy: "2026-12-20" } }, /within 60 days/],
    ["entry predating launchDate", { listingStatusReview: { changedAt: "2026-10-01", reason: "No admitted price lane yet.", reviewBy: "2026-11-01" } }, /cannot predate launchDate/],
    ["review on upcoming beta row", { launchPhase: "beta" }, /only allowed/],
  ] as const)("rejects %s", (_label, overrides, pattern) => {
    expect(() => parseAssets([launched(overrides)])).toThrow(pattern);
  });
});

describe("StablecoinMeta schema — blacklistability review", () => {
  it("rejects retired canBeBlacklisted and missing sources", () => {
    expect(() => parseCoin({ id: "fixture-blacklist-legacy", canBeBlacklisted: true })).toThrow(/canBeBlacklisted/);
    expect(() => parseCoin({ blacklistabilityReview: { reviewedStatus: true, evidence: "Fixture evidence without source.", reviewer: "Fixture", reviewedAt: "2026-05-12" } })).toThrow(/sources/);
  });

  it.each([true, false, "possible", "inherited"] as const)("accepts reviewed status %s", (reviewedStatus) => {
    expect(() => parseCoin({ blacklistabilityReview: { reviewedStatus, sourceFreeRationale: "Reviewed fixture status.", evidence: "Fixture evidence for reviewed blacklistability status.", reviewer: "Fixture", reviewedAt: "2026-05-12" } })).not.toThrow();
  });

  it.each(["2026-99-99", "2026-02-30", "2025-00-12"])("rejects impossible review date %s", (reviewedAt) => {
    expect(() => parseCoin({ blacklistabilityReview: { reviewedStatus: "inherited", sourceFreeRationale: "Resolved from Pharos metadata.", evidence: "Fixture evidence for inferred upstream exposure.", reviewer: "Fixture", reviewedAt } })).toThrow(/Expected YYYY-MM-DD/);
  });
});

describe("StablecoinMeta schema — GENIUS profile", () => {
  const issuerDisclosure = { label: "Issuer disclosure", url: "https://example.com/genius", sourceKind: "issuer-disclosure", sourceDate: "2026-05-27" };
  const geniusBase = { applicability: "apparent-payment-stablecoin", issuerPathway: "unknown", reviewer: "Fixture Reviewer", reviewedAt: "2026-05-27" };

  it("accepts source-backed issuer-announced intent and rejects invalid authorization or extra fields", () => {
    const parsed = parseCoin({
      id: "fixture-genius-intent",
      genius: {
        ...geniusBase, authorizationStatus: "issuer-announced-intent", issuerEntity: "Fixture Issuer, N.A.",
        issuerDomicile: "United States", licensingRegulator: "OCC", primaryFederalRegulator: "OCC",
        foreignExceptionStatus: "not-applicable", enforcementStatus: "no-public-action-found", daspOfferSaleStatus: "not-yet-restricted",
        reserveDisclosurePresent: true, reserveDisclosureUrl: "https://example.com/reserves", redemptionPolicyPresent: true,
        monthlyAttestationPresent: true, references: [issuerDisclosure],
      },
    });
    expect(parsed[0]?.genius?.authorizationStatus).toBe("issuer-announced-intent");
    expect(() => parseCoin({ genius: { ...geniusBase, authorizationStatus: "ppsi-approved", issuerPathway: "federal-qualified-nonbank", references: [issuerDisclosure] } })).toThrow(/official authorization/);
    expect(() => parseCoin({ genius: { ...geniusBase, authorizationStatus: "no-public-authorization-found" } })).toThrow(/negative evidence review/);
    expect(() => parseCoin({ genius: { ...geniusBase, authorizationStatus: "issuer-announced-intent", references: [issuerDisclosure], complianceScore: 100 } })).toThrow(/complianceScore/);
  });
});

describe("StablecoinMeta schema — mint authority", () => {
  it("accepts a verified Safe mint authority profile", () => {
    expect(() => parseMint({})).not.toThrow();
  });

  it.each([
    ["chain", { name: "ethereum" }], ["address", { value: "0x1234" }], ["threshold", "2"], ["signerCount", Number.NaN],
    ["timelockDelaySec", { seconds: 3600 }], ["capDescription", ["cap"]], ["role", "invalid"], ["authorityType", "invalid"],
    ["directMintAbility", "invalid"], ["canRaiseCap", "invalid"], ["modulesOrGuardsStatus", "invalid"],
  ] as const)("rejects malformed mint-authority control %s at catalog admission", (field, value) => {
    expectMintIssue(makeMintAuthority({ controls: [makeSafeControl({ [field]: value })] }), ["controls", 0, field]);
  });

  it.each(["mintPath", "authorityPosture", "confidence"])("rejects invalid profile %s at catalog admission", (field) => {
    expectMintIssue(makeMintAuthority({ [field]: "invalid" }), [field]);
  });

  it("rejects stray sources and enforces source-link, control-presence, and Safe constraints", () => {
    expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({ sources: [mintAuthoritySource] })).error?.issues)
      .toContainEqual(expect.objectContaining({ code: "unrecognized_keys", keys: ["sources"] }));
    const reviewNoSource = { sourceFreeRationale: "Internal review.", evidence: "Omits profile source link.", reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24" };
    expect(() => parseMint({ review: reviewNoSource })).toThrow(/source link/);
    expect(() => parseMint({ review: reviewNoSource, controls: [makeSafeControl({ sources: [mintAuthoritySource] })] })).not.toThrow();
    expect(() => parseMint({ controls: [] })).toThrow(/requires at least one control/);
    expect(() => parseMint({ confidence: "probable", controls: [makeSafeControl({ threshold: undefined }, { threshold: 4 })] })).toThrow(/threshold/);
    expect(() => parseMint({ controls: [makeSafeControl({ modulesOrGuardsStatus: undefined })] })).toThrow(/modulesOrGuardsStatus/);
    expect(() => parseMint({
      confidence: "probable",
      controls: [{ label: "Unresolved Safe", role: "direct-minter", authorityType: "safe", directMintAbility: "direct", modulesOrGuardsStatus: "unknown", safe: { source: "manual" } }],
    })).toThrow(/caps confidence/);
  });

  it.each([
    ["impossible uniform quorum", { threshold: 4, safe: undefined }, {}, ["threshold"]],
    ["contradictory Safe threshold", {}, { threshold: 1 }, ["safe", "threshold"]],
    ["contradictory Safe owner count", { signerCount: 4 }, {}, ["safe", "owners"]],
    ["inappropriate Safe authority type", { authorityType: "eoa" }, {}, ["safe"]],
  ] as const)("rejects %s in both mint and bridge admission", (_label, overrides, safeOverrides, path) => {
    const control = makeSafeControl(overrides, safeOverrides);
    expectMintIssue(makeMintAuthority({ controls: [control] }), ["controls", 0, ...path]);
    expectIssue(BridgeRouteRiskProfileSchema, makeBridgeAuthority(control), ["controls", 0, ...path]);
  });

  it("keeps consistent Safe and weighted quorums admissible in mint and bridge profiles", () => {
    const weighted = weightedQuorum();
    const sep = weighted.deployment.indexOf(":");
    for (const control of [
      makeSafeControl(),
      makeSafeControl({ authorityType: "multisig", chain: weighted.deployment.slice(0, sep), address: weighted.deployment.slice(sep + 1), threshold: undefined, signerCount: undefined, safe: undefined, weightedQuorum: weighted }),
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

  // Nightly tier: projects every authored mint-authority and bridge-risk profile in the catalog.
  it("admits current corpus authority profiles, including weighted and same-chain system transport controls", { tags: ["nightly"] }, () => {
    for (const coin of TRACKED_SOURCE_COINS) {
      if (coin.mintAuthority) expect(MintAuthorityProfileSchema.safeParse(coin.mintAuthority).success, `${coin.id} mint`).toBe(true);
      if (coin.bridgeRouteRisk) expect(BridgeRouteRiskProfileSchema.safeParse(coin.bridgeRouteRisk).success, `${coin.id} bridge`).toBe(true);
    }
    expect(TRACKED_SOURCE_COINS.some((c) => c.bridgeRouteRisk?.controls?.some((ctrl) => ctrl.sameChainSystemTransport != null))).toBe(true);
  });

  it("rejects a contradictory observed acrdx Safe threshold before full-catalog authority projection", () => {
    const coin = structuredClone(TRACKED_SOURCE_COINS.find((e) => e.id === "acrdx-anemoy-apollo")!);
    expect(StablecoinMetaAssetSchema.safeParse(coin).success).toBe(true);
    const idx = coin.bridgeRouteRisk!.controls!.findIndex((c) => c.id === "acrdx-ethereum-protocolguardian-safe");
    expect(coin.bridgeRouteRisk!.controls![idx]!.threshold).toBe(4);
    coin.bridgeRouteRisk!.controls![idx]!.safe!.threshold = 1;
    expectIssue(StablecoinMetaAssetSchema, coin, ["bridgeRouteRisk", "controls", idx, "safe", "threshold"]);
  });

  it.each([
    ["none-resolved", true, true], ["none-resolved", false, false], ["none-resolved", "unknown", false],
    ["none-resolved", undefined, false], ["none-resolved-mint", true, false],
  ] as const)("checks %s cap-raising authority %s at merged admission", (authorityPosture, canRaiseCap, rejected) => {
    const coin = makeCoin({
      mintAuthority: makeMintAuthority({
        mintPath: "immutable-user-collateralized", authorityPosture, economicCapSemantics: "raiseable",
        capSemanticsReview: { ...capSemanticsReview, verdict: "raiseable-collateral-only", reviewedAt: "2026-05-24" },
        controls: [{ label: "Cap administrator", role: "cap-admin", authorityType: "contract", directMintAbility: "none", canRaiseCap, evidence: "The reviewed controller can raise the cap but cannot directly mint tokens." }],
      }),
    });
    if (rejected) {
      expect(StablecoinMetaAssetSchema.safeParse(coin).error?.issues).toEqual([{
        code: "custom", path: ["mintAuthority", "controls", 0, "canRaiseCap"],
        message: "authorityPosture none-resolved cannot include cap-raising controls",
      }]);
    } else {
      expect(parseAssets([coin], "cap authority fixture")).toHaveLength(1);
    }
  });

  it("preserves complete ordered mint-authority issues across independent invariants", () => {
    expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({
      mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved",
      review: { sources: [mintAuthoritySource], evidence: "Unresolved control evidence.", reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24", disposition: "unresolved" },
      controls: [{ label: "Unreviewed Safe", role: "direct-minter", authorityType: "safe", directMintAbility: "direct", modulesOrGuardsStatus: "unknown" }],
    })).error?.issues).toEqual([
      { code: "custom", path: ["review", "unresolvedQuestions"], message: "unresolved mint-authority disposition requires unresolvedQuestions" },
      { code: "custom", path: ["confidence"], message: "unresolved mint-authority disposition requires unknown confidence" },
      { code: "custom", path: ["controls", 0, "address"], message: "non-addressable controls require evidence, sources, sourceFreeRationale, or unresolvedQuestions" },
      { code: "custom", path: ["controls", 0, "safe"], message: "authorityType safe requires safe details" },
      { code: "custom", path: ["controls", 0, "threshold"], message: "verified safe or multisig controls require threshold" },
      { code: "custom", path: ["controls", 0, "signerCount"], message: "verified safe or multisig controls require signerCount" },
      { code: "custom", path: ["controls", 0, "modulesOrGuardsStatus"], message: "unknown Safe modules/guards status caps confidence at manual-review" },
      { code: "custom", path: ["controls", 0, "directMintAbility"], message: "authorityPosture none-resolved cannot include mint-capable controls" },
    ]);

    expect(MintAuthorityProfileSchema.safeParse(makeMintAuthority({
      mintPath: "unknown", authorityPosture: "compromised", economicCapSemantics: "unknown", controls: [],
      capSemanticsReview: { ...capSemanticsReview, verdict: "raiseable-collateral-only", reviewedAt: "2026-05-24" },
    })).error?.issues).toEqual([
      { code: "custom", path: ["capSemanticsReview"], message: "capSemanticsReview is not allowed with economicCapSemantics unknown" },
      { code: "custom", path: ["authorityPosture"], message: "authorityPosture compromised requires an active mint incident" },
      { code: "custom", path: ["authorityPosture"], message: "mintPath unknown should use authorityPosture unknown unless known unbounded authority supports unbounded-adverse or reviewed noLocalIssuance supports none-resolved-mint" },
    ]);
  });

  it("enforces none-resolved vs none-resolved-mint control domain rules", () => {
    expect(() => parseMint({ mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved", controls: [{ label: "Not passive", role: "direct-minter", authorityType: "contract", directMintAbility: "can-authorize" }] })).toThrow(/none-resolved/);
    const upgradeOnly = [{ label: "Upgrade admin", role: "proxy-admin" as const, authorityType: "contract" as const, directMintAbility: "upgrade-only" as const, evidence: "Upgrade admin with no mint ability." }];
    expect(() => parseMint({ mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved-mint", controls: upgradeOnly })).not.toThrow();
    expect(() => parseMint({ mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved", controls: upgradeOnly })).toThrow(/none-resolved cannot include mint-capable controls/);
    for (const directMintAbility of ["direct", "unknown"] as const) {
      expect(() => parseMint({ mintPath: "immutable-user-collateralized", authorityPosture: "none-resolved-mint", controls: [{ label: "Real minter", role: "direct-minter", authorityType: "contract", directMintAbility }] }))
        .toThrow(/none-resolved-mint cannot include a control that can mint/);
    }
    expect(() => parseMint({ mintPath: "issuer-direct-mint", authorityPosture: "none-resolved-mint", controls: undefined })).toThrow(/none-resolved-mint requires a non-privileged mintPath/);
  });

  it("enforces reviewed noLocalIssuance for external-only representations on unknown mint paths", () => {
    const externalOnly = (overrides: Record<string, unknown> = {}) => makeMintAuthority({
      mintPath: "unknown", authorityPosture: "none-resolved-mint", controls: [],
      review: {
        sources: [mintAuthoritySource], evidence: "The reviewed representation has no local issuance authority.",
        reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24",
        noLocalIssuance: { kind: "external-only-representation", reviewedAt: "2026-05-24", reviewer: "Fixture Reviewer", rationale: "The reviewed routes represent external issuance and have no local native mint path." },
      },
      ...overrides,
    });
    expect(MintAuthorityProfileSchema.parse(externalOnly())).toMatchObject({ authorityPosture: "none-resolved-mint", mintPath: "unknown" });
    expectMintIssue(makeMintAuthority({ mintPath: "unknown", authorityPosture: "none-resolved-mint", controls: [] }), ["authorityPosture"], "authorityPosture none-resolved-mint requires a non-privileged mintPath");
    expectMintIssue(externalOnly({ controls: [{ label: "Mint authorizer", role: "direct-minter", authorityType: "contract", directMintAbility: "can-authorize" }] }), ["controls", 0, "directMintAbility"], "authorityPosture none-resolved-mint cannot include a control that can mint or authorize minting");
    expectMintIssue(externalOnly({ authorityPosture: "none-resolved" }), ["authorityPosture"], "authorityPosture none-resolved requires a non-privileged mintPath");
  });

  it("binds scored economic-control claims to review evidence and leaves unbound states alone", () => {
    const brief = { sources: [mintAuthoritySource], evidence: "The reviewer checked this.", reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24" };
    expect(() => parseMint({ reconciliation: "periodic", review: brief })).toThrow(/reconciliation periodic requires a review evidence sentence/);
    expect(() => parseMint({ supervision: "prudential", review: brief })).toThrow(/supervision prudential requires a review evidence sentence/);
    expect(() => parseMint({ reconciliation: "continuous", supervision: "prudential", review: brief })).toThrow(/reconciliation continuous and supervision prudential/);
    for (const overrides of [{ reconciliation: "none" }, { reconciliation: "not-applicable" }, { reconciliation: "unknown" }, { supervision: "none" }, { supervision: "unknown" }]) {
      expect(() => parseMint({ ...overrides, review: brief })).not.toThrow();
    }
    expect(() => parseMint({
      reconciliation: "periodic", supervision: "prudential",
      review: { ...brief, evidence: "Monthly attestations reconcile circulating supply against segregated reserves, and the issuer holds an e-money licence from the named competent authority." },
    })).not.toThrow();
    expect(() => parseMint({
      mintPath: "unknown", authorityPosture: "bounded-admin", confidence: "unknown", controls: undefined,
      review: { sourceFreeRationale: "No public source.", evidence: "Unknown mint authority review.", reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24" },
    })).toThrow(/mintPath unknown/);
  });

  it.each([
    [{ reconciliation: "continuous" }, "Continuous proofs reconcile all circulating native liabilities to independently verifiable backing."],
    [{ reconciliation: "periodic" }, "Monthly attestations reconcile all circulating native liabilities to the stated segregated reserves."],
    [{ reconciliation: "internal-ledger" }, "The issuer's internal ledger records all native issuance and liability settlement."],
    [{ supervision: "prudential" }, "The named prudential regime supervises the issuer entity and all native token liabilities."],
    [{ supervision: "attestation-only" }, "The named attestator reports reserves covering the issuer's entire native token liabilities."],
  ] as const)("requires a review source and substantive evidence for positive process claim %j", (claim, evidence) => {
    const review = { sources: [mintAuthoritySource], evidence, reviewer: "Fixture Reviewer", reviewedAt: "2026-05-24" };
    const profile = makeMintAuthority({ ...claim, confidence: "manual-review", review });
    expect(MintAuthorityProfileSchema.parse(profile).review.evidence).toBe(evidence);
    expectMintIssue({ ...profile, review: { ...review, sources: [], sourceFreeRationale: "No claim-supporting primary source has been located." } }, ["review", "sources"]);
    for (const shortEvidence of [undefined, "The issuer operates this.", ` ${"x".repeat(39)} `]) {
      expectMintIssue({ ...profile, review: { ...review, sources: [{ label: "Issuer homepage", url: "https://example.com" }], evidence: shortEvidence } }, ["review", "evidence"]);
    }
    expect(MintAuthorityProfileSchema.parse({ ...profile, review: { ...review, evidence: ` ${evidence} ` } }).review.evidence?.trim()).toBe(evidence);
    if ("reconciliation" in claim && claim.reconciliation === "internal-ledger") {
      const boundary = "The ledger records every issued balance.";
      expect(boundary).toHaveLength(40);
      expect(MintAuthorityProfileSchema.parse({ ...profile, review: { ...review, evidence: ` ${boundary} ` } }).review.evidence?.trim()).toBe(boundary);
    }
  });

  it("validates inherited mint authority references, depth limits, cycles, and parent posture coupling", () => {
    const immutableParent = makeCoin({ id: "parent-usd", mintAuthority: immutableAuthority() });
    expect(() => parseAssets([immutableParent, makeCoin({ id: "wrapped-usd", variantOf: "parent-usd", variantKind: "savings-passthrough", mintAuthority: inheritedAuthority("parent-usd") })])).not.toThrow();
    expect(() => parseAssets([makeCoin({ id: "other-usd" }), makeCoin({ id: "missing-parent-wrapper", mintAuthority: inheritedAuthority("ghost-usd", { authorityPosture: "unknown", confidence: "manual-review" }) })])).toThrow(/inheritedFrom/);
    expect(() => parseAssets([immutableParent, makeCoin({ id: "implicit-wrapper-usd", variantOf: "parent-usd", variantKind: "savings-passthrough", mintAuthority: inheritedAuthority(undefined) })])).toThrow(/requires inheritedFrom/);
    expect(() => parseCoin({ id: "variant-without-mint-review", variantOf: "parent-usd", variantKind: "savings-passthrough" })).toThrow(/active variants require mintAuthority review/);
    expect(() => parseAssets([
      makeCoin({ id: "frozen-parent-usd", status: "frozen", frozenAt: "2026-06-01", obituary: baseObituary, mintAuthority: immutableAuthority() }),
      makeCoin({ id: "active-wrapper-of-frozen-usd", mintAuthority: inheritedAuthority("frozen-parent-usd") }),
    ])).toThrow(/must reference an active tracked stablecoin/);
    expect(() => parseAssets([
      makeCoin({ id: "cycle-a", mintAuthority: inheritedAuthority("cycle-b", { authorityPosture: "partially-bounded-admin" }) }),
      makeCoin({ id: "cycle-b", mintAuthority: inheritedAuthority("cycle-a", { authorityPosture: "partially-bounded-admin" }) }),
    ])).toThrow(/must not form a cycle/);
    expect(() => parseAssets(makeInheritanceChain(["depth-0", "depth-1", "depth-2", "depth-3"]))).toThrow(/depth/);
    expect(parseAssets(makeInheritanceChain(["depth-0", "depth-1", "depth-2"])).map((c) => c.id)).toEqual(["depth-0", "depth-1", "depth-2", "terminal"]);

    const adminParent = makeCoin({ id: "admin-parent-usd", mintAuthority: makeMintAuthority() });
    expect(() => parseAssets([adminParent, makeCoin({ id: "wrapped-admin-usd", variantOf: "admin-parent-usd", variantKind: "savings-passthrough", mintAuthority: inheritedAuthority("admin-parent-usd") })])).toThrow(/parent is none-resolved/);
    expect(parseMint(inheritedAuthority("parent-not-in-this-catalog"))[0]!.mintAuthority?.authorityPosture).toBe("none-resolved");

    const mismatchChain = makeInheritanceChain(["child"], makeCoin({ id: "mint-parent", mintAuthority: makeMintAuthority() }));
    Object.assign(mismatchChain[0]!, { variantOf: "other-parent", variantKind: "savings-passthrough" });
    expect(() => parseAssets([...mismatchChain, makeCoin({ id: "other-parent", mintAuthority: makeMintAuthority() })])).toThrow(/inheritedFrom must match variantOf/);

    const mintOnlyChild = makeCoin({ id: "child", variantOf: "admin-parent-usd", variantKind: "savings-passthrough", mintAuthority: inheritedAuthority("admin-parent-usd", { authorityPosture: "none-resolved-mint" }) });
    expect(parseAssets([adminParent, mintOnlyChild])[1]!.mintAuthority?.authorityPosture).toBe("none-resolved-mint");
  });
});

describe("StablecoinMeta schema — variantOf / pegReferenceId coherence (Rule 1)", () => {
  it("validates pegReferenceId and wrapperOperator rules", () => {
    const parent = makeCoin({ id: "variant-parent-ok", mintAuthority: immutableAuthority() });
    expect(() => parseAssets([parent, makeCoin({ id: "fixture-variant-ok", variantOf: "variant-parent-ok", variantKind: "savings-passthrough", pegReferenceId: "variant-parent-ok", mintAuthority: inheritedAuthority("variant-parent-ok") })])).not.toThrow();
    expect(() => parseCoin({ id: "fixture-peg-only", pegReferenceId: "usdt-tether" })).toThrow(/pegReferenceId requires variantOf/);
    expect(() => parseCoin({ id: "fixture-variant-mismatch", variantOf: "usdt-tether", variantKind: "savings-passthrough", pegReferenceId: "usdc-circle" })).toThrow(/pegReferenceId/);

    const riskChild = makeCoin({ id: "risk-child", flags: { ...baseFlags, navToken: true }, variantOf: "variant-parent-ok", variantKind: "risk-absorption", pegReferenceId: "variant-parent-ok", mintAuthority: inheritedAuthority("variant-parent-ok") });
    expect(() => parseAssets([parent, riskChild])).toThrow(/wrapperOperator/);
    expect(() => parseAssets([parent, { ...riskChild, wrapperOperator: "third-party" }])).not.toThrow();
    expect(() => parseCoin({ id: "strategy-child", variantOf: "strategy-parent", variantKind: "strategy-vault", wrapperOperator: "third-party" })).toThrow(/wrapperOperator/);
  });
});

describe("StablecoinMeta schema — reserves depType valid cases", () => {
  it("validates depType requirements and 100% reserve sum", () => {
    expect(() => parseCoin({ id: "fixture-untyped", reserves: [{ name: "Parent token", pct: 100, risk: "low", coinId: "usdt-tether" }] })).toThrow(/linked reserve slices require depType/);
    expect(() => parseCoin({ id: "fixture-wrapper-ok", reserves: [{ name: "Parent token shares", pct: 100, risk: "low", coinId: "usdt-tether", depType: "wrapper" }] })).not.toThrow();
    expect(() => parseCoin({ id: "fixture-collateral-no-coinid", reserves: [{ name: "Tokenized Treasury Bonds", pct: 100, risk: "low", depType: "collateral" }] })).not.toThrow();
    expect(() => parseCoin({ id: "fixture-reserves-partial", reserves: [{ name: "USDC", pct: 40, risk: "low" }, { name: "Treasuries", pct: 20, risk: "very-low" }] })).toThrow(/Reserve composition must sum to 100%/);
  });
});

describe("Stablecoin research sidecar schemas", () => {
  const mintAuthority = {
    mintPath: "unknown", authorityPosture: "unknown", confidence: "unknown",
    summary: "The fixture mint authority remains unresolved.",
    review: { sourceFreeRationale: "Schema fixture without external research.", evidence: "The fixture records enough evidence text for strict schema validation.", reviewer: "test", reviewedAt: "2026-07-09" },
  };
  const blacklistabilityReview = {
    reviewedStatus: true, sourceFreeRationale: "Schema fixture without external research.",
    evidence: "The fixture models a direct blacklistability control surface.", reviewer: "test", reviewedAt: "2026-07-09",
  };

  it("accepts each supported research-domain shape and rejects empty or unknown-key sidecars", () => {
    expect(StablecoinMintAuthoritySidecarSchema.safeParse({ id: "fixture-usd", mintAuthority }).success).toBe(true);
    expect(StablecoinComplianceSidecarSchema.safeParse({
      id: "fixture-usd", mica: { status: "out-of-scope" },
      genius: { applicability: "unclear", authorizationStatus: "unknown", issuerPathway: "unknown", reviewer: "test", reviewedAt: "2026-07-09" },
    }).success).toBe(true);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd", blacklistabilityReview,
      oracleRisk: { tier: "opaque-or-unknown", summary: "The fixture oracle design remains unknown." },
      bridgeRouteRisk: { tier: "opaque-or-unknown", summary: "The fixture bridge route remains unknown.", reviewedAt: "2026-07-09", reviewer: "test", confidence: "unknown", sourceFreeRationale: "Schema fixture without external research." },
    }).success).toBe(true);

    expect(StablecoinComplianceSidecarSchema.safeParse({ id: "fixture-usd" }).success).toBe(false);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({ id: "fixture-usd" }).success).toBe(false);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({ id: "fixture-usd", canBeBlacklisted: true }).success).toBe(false);
    expect(StablecoinMintAuthoritySidecarSchema.safeParse({ id: "fixture-usd", mintAuthority, notes: "not owned here" }).success).toBe(false);
    expect(StablecoinComplianceSidecarSchema.safeParse({ id: "fixture-usd", mica: { status: "out-of-scope" }, jurisdiction: { country: "US" } }).success).toBe(false);
    expect(StablecoinRiskReviewSidecarSchema.safeParse({ id: "fixture-usd", blacklistabilityReview, governanceQuality: "single-entity" }).success).toBe(false);
  });

  it("enforces oracle branchApplicability consistency", () => {
    const branch = { id: "eth", label: "ETH", tier: "standard-external", summary: "The branch fixture supplies a valid independently reviewed feed path." };
    const applicability = (disposition: "branches-required" | "not-applicable") => ({
      disposition, reviewedAt: "2026-07-13", reviewer: "test",
      rationale: "Each collateral market has independent oracle and liquidation behavior.",
      sources: [{ label: "Docs", url: "https://example.com/docs" }],
    });
    const base = { tier: "standard-external", summary: "The fixture records a multi-market collateral oracle design." };
    expect(OracleRiskProfileSchema.safeParse({ ...base, branchApplicability: applicability("branches-required") }).success).toBe(false);
    expect(OracleRiskProfileSchema.safeParse({ ...base, branchModel: "multi-branch", branches: [branch], branchApplicability: applicability("branches-required") }).success).toBe(true);
    expect(OracleRiskProfileSchema.safeParse({ ...base, branchModel: "multi-branch", branches: [branch], branchApplicability: applicability("not-applicable") }).success).toBe(false);
  });

  it("requires route-level sources for reviewed bridge routes while accepting evidence-honest unresolved routes", () => {
    const missingSources = StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      bridgeRouteRisk: {
        tier: "issuer-native-burn-mint", summary: "Issuer-native deployment.", reviewedAt: "2026-07-13", reviewer: "test", confidence: "verified",
        sources: [{ label: "Issuer docs", url: "https://example.com/issuer" }],
        routes: [{ id: "ethereum:0xabc", destinationChain: "ethereum", contractAddress: "0xabc", protocol: "Issuer", issuanceModel: "native-issuance", routeClass: "native", riskTier: "issuer-native-burn-mint", semantics: "native-mint", scope: "canonical", reviewDisposition: "reviewed", observedAt: "2026-07-13" }],
      },
    });
    expect(missingSources.success).toBe(false);
    if (!missingSources.success) expect(missingSources.error.message).toContain("route-level sources");

    expect(StablecoinRiskReviewSidecarSchema.safeParse({
      id: "fixture-usd",
      bridgeRouteRisk: {
        tier: "opaque-or-unknown", summary: "Bridge route remains unresolved.", reviewedAt: "2026-07-13", reviewer: "test", confidence: "unknown",
        sourceFreeRationale: "No route-level deployment evidence was available.",
        routes: [{ id: "base:0xdef", destinationChain: "base", contractAddress: "0xdef", protocol: "unresolved route", issuanceModel: "unknown", routeClass: "unknown", riskTier: "opaque-or-unknown", semantics: "unknown", scope: "unknown", reviewDisposition: "unresolved", reviewNote: "Route semantics and scope remain unresolved." }],
      },
    }).success).toBe(true);
  });
});

describe("StablecoinMeta schema — PoR / composition lockstep", () => {
  const reserves = [{ name: "US Treasury bills", pct: 100, risk: "low" }];
  const latestReport = {
    periodEnd: "2026-06-30", publishedAt: "2026-07-10", assuranceMethod: "examination", scope: "assets-only",
    liabilityReconciliation: "none", reviewer: "Fixture Reviewer", confidence: "verified",
    sources: [{ label: "Attestation", url: "https://example.com/attestation" }],
  };
  const reserveReview = (compositionAsOf: string) => ({
    reviewedAt: "2026-07-12", reviewer: "Fixture Reviewer", confidence: "verified",
    sources: [{ label: "Attestation", url: "https://example.com/attestation" }],
    rationale: "Curated composition drawn from the attestation.", compositionBasis: "Attestation breakdown table",
    compositionAsOf, scope: "full-composition", knownUnknownExposure: "None identified.", knownUnknownExposurePct: 0,
  });
  const coin = (compositionAsOf: string, report: Record<string, unknown> | undefined = latestReport) => makeCoin({
    id: "fixture-lockstep", reserves,
    proofOfReserves: { type: "self-reported", url: "https://example.com/por", ...(report ? { latestReport: report } : {}) },
    reserveReview: reserveReview(compositionAsOf),
  });

  it("enforces report/composition chronology, dated stand-ins, and silence when one side is absent", () => {
    expect(() => parseAssets([coin("2026-06-30")])).not.toThrow();
    expect(() => parseAssets([coin("2026-05-31")])).toThrow(/PoR lockstep/);
    const standin = { ...latestReport, publishedAtBasis: "signed-date-standin" };
    expect(parseAssets([coin("2026-06-30", standin)])[0].proofOfReserves?.latestReport).toMatchObject({ publishedAt: "2026-07-10", publishedAtBasis: "signed-date-standin" });
    expect(() => parseAssets([coin("2026-06-30", { ...standin, publishedAt: undefined })])).toThrow(/publishedAtBasis requires publishedAt/);
    expect(() => parseAssets([coin("2026-06-30", { ...standin, publishedAt: "2026-06-29" })])).toThrow(/cannot precede periodEnd/);
    expect(() => parseAssets([coin("2026-07-12", standin)])).toThrow(/PoR lockstep/);
    expect(() => parseCoin({ id: "fixture-lockstep-no-composition", reserves, proofOfReserves: { type: "self-reported", url: "https://example.com/por", latestReport } })).not.toThrow();
    expect(() => parseAssets([coin("2026-06-30", undefined)])).not.toThrow();
  });
});

describe("StablecoinMeta catalog — live reserve invariants", () => {
  it("uses explicit breaker scopes when a live-reserve adapter is reused across multiple coins", () => {
    const liveCoins = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig);
    const counts = new Map<string, number>();
    for (const c of liveCoins) counts.set(c.liveReservesConfig!.adapter, (counts.get(c.liveReservesConfig!.adapter) ?? 0) + 1);
    const missingScopes = liveCoins
      .filter((c) => (counts.get(c.liveReservesConfig!.adapter) ?? 0) > 1 && !c.liveReservesConfig!.breakerScope)
      .map((c) => `${c.id}:${c.liveReservesConfig!.adapter}`);
    expect(missingScopes).toEqual([]);
  });

  it("keeps curated-validated live reserve configs aligned with onchain contracts and curated reserve slices", () => {
    const curatedCoins = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig?.adapter === "curated-validated");
    const contractIssues = curatedCoins.flatMap((c) => {
      const primary = c.liveReservesConfig!.inputs.primary;
      if (primary.kind !== "onchain-evm" && primary.kind !== "onchain-solana") return [`${c.id}:primary:${primary.kind}`];
      const expectedChain = primary.kind === "onchain-solana" ? "solana" : primary.chain;
      const ok = c.contracts?.some((k) => k.chain === expectedChain && (primary.kind === "onchain-solana" ? k.address.length > 0 : k.address.startsWith("0x"))) ?? false;
      return ok ? [] : [`${c.id}:contract:${expectedChain}`];
    });
    expect(contractIssues).toEqual([]);
    expect(curatedCoins.filter((c) => (c.reserves?.length ?? 0) === 0).map((c) => c.id)).toEqual([]);
  });

  it("does not let one breaker scope cover multiple distinct live-reserve source configs", () => {
    const scopeSourceGroups = new Map<string, Set<string>>();
    for (const c of TRACKED_STABLECOINS) {
      const cfg = c.liveReservesConfig;
      if (!cfg) continue;
      const scope = cfg.breakerScope ?? cfg.adapter;
      const id = JSON.stringify({ adapter: cfg.adapter, version: cfg.version, semantics: cfg.semantics, inputs: cfg.inputs, params: cfg.params ?? null });
      const set = scopeSourceGroups.get(scope) ?? new Set<string>();
      set.add(id);
      scopeSourceGroups.set(scope, set);
    }
    expect(Array.from(scopeSourceGroups.entries()).filter(([, s]) => s.size > 1).map(([scope]) => scope)).toEqual([]);
  });

  it("keeps configured live reserve inputs compatible with adapter input-kind constraints and exposes no suspended configs", () => {
    const issues = TRACKED_STABLECOINS.filter((c) => c.liveReservesConfig).flatMap((c) => {
      const cfg = c.liveReservesConfig!;
      expect(cfg.suspended, c.id).toBeUndefined();
      const parsed = LiveReservesConfigSchema.safeParse(cfg);
      const allowed = LIVE_RESERVE_ADAPTER_DEFINITIONS[cfg.adapter].primaryInputKinds as readonly string[];
      const invalid = [cfg.inputs.primary.kind, ...(cfg.inputs.fallbacks ?? []).map((f) => f.kind)].filter((k) => !allowed.includes(k));
      return [
        ...(parsed.success ? [] : [`${c.id}:schema:${parsed.error.issues[0]?.message ?? "invalid"}`]),
        ...invalid.map((k) => `${c.id}:${cfg.adapter}:${k}`),
      ];
    });
    expect(issues).toEqual([]);
  });

  it("keeps direct ETH and WETH reserve mappings aligned with the canonical ETH risk tier", () => {
    const mismatches: string[] = [];
    for (const coin of TRACKED_STABLECOINS) {
      for (const slice of coin.reserves ?? []) {
        if ((slice.name === "ETH" || slice.name === "WETH" || slice.name === "WETH (wrapped Ether)") && slice.risk !== CANONICAL_ETH_RESERVE_RISK) {
          mismatches.push(`${coin.id}:reserve:${slice.name}:${slice.risk}`);
        }
      }
      const params = coin.liveReservesConfig?.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) continue;
      const p = params as { branches?: Array<{ name?: string; risk?: string }>; label?: string; risk?: string; riskMap?: Record<string, string> };
      for (const b of p.branches ?? []) {
        if (b?.name === "WETH" && b.risk !== CANONICAL_ETH_RESERVE_RISK) mismatches.push(`${coin.id}:branch:${b.name}:${b.risk ?? "missing"}`);
      }
      if (p.label === "ETH" && p.risk !== CANONICAL_ETH_RESERVE_RISK) mismatches.push(`${coin.id}:single-asset:ETH:${p.risk ?? "missing"}`);
      if (p.riskMap?.ETH && p.riskMap.ETH !== CANONICAL_ETH_RESERVE_RISK) mismatches.push(`${coin.id}:risk-map:ETH:${p.riskMap.ETH}`);
    }
    expect(mismatches).toEqual([]);
  });
});
