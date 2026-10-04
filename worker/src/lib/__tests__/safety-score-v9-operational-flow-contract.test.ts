import { describe, expect, it } from "vitest";
import { computeV1005AuthorityStateHash, compileReviewedMintControlScopes, resolveV1005MintAuthorityProfile } from "@shared/lib/safety-score-v9/control-scope";
import { reviewedScope, SCOPE_CONTROLLER } from "@shared/lib/__tests__/safety-score-v9-control-scope.test-support";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { deriveV9MintPosture } from "@shared/lib/safety-score-v9/control-primitives";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import { makeEconomicControlArgs, makeReviewedMintInput } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { MintAuthorityProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import { V9AssetFactsV3Schema } from "@shared/types/safety-score-v9-facts";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import type { MintAuthorityProfile } from "@shared/types/core";
import type { V1005ExecutionCertificates, V1005AuthorityGraph, V1005OperationalIssuance } from "@shared/types/safety-score-v9-control-scope";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import ghoSidecar from "@shared/data/stablecoins/domains/mint-authority/gho-aave.json";
import daiSidecar from "@shared/data/stablecoins/domains/mint-authority/dai-makerdao.json";
import usdsSidecar from "@shared/data/stablecoins/domains/mint-authority/usds-sky.json";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput, compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension, materializeSafetyScoreV9FactSetExtension } from "../safety-score-v9/fact-set";
import { admitSafetyScoreV9ExtensionAsset, admitSafetyScoreV9FactSetExtension, SafetyScoreV9FactSetExtensionV2Schema } from "../safety-score-v9/fact-set-schema";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";
import { alphaMeta, metaMap } from "./safety-score-v9-fact-set.test-support";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK = Date.parse("2026-10-05T12:00:00Z") / 1000;
const PROGRAM = "ethereum:0x2222222222222222222222222222222222222222";
const HOLDER = "ethereum:0x3333333333333333333333333333333333333333";
const HASH: `0x${string}` = `0x${"ab".repeat(32)}`;
const CODE_HASH = `0x${"cd".repeat(32)}`;
const pin = { chain: "ethereum", position: "100", hash: HASH, timestamp: "2026-10-04T12:00:00Z" };
const review = { observedAt: "2026-10-04", reviewedAt: "2026-10-04", expiresAt: "2026-10-31", reviewer: "Modeled compiler fixture", pin };
const source = { label: "Modeled reviewed source", url: "https://example.com/compiler-model" };

/** Deliberately modeled source/state observations, never catalog evidence. */
function modeledProfile(): MintAuthorityProfile {
  const scopePin = { position: pin.position, hash: pin.hash, runtimeIdentity: CODE_HASH, signerIdentity: "Descriptive custody identity only" };
  const governor = reviewedScope({ controllerDeployment: SCOPE_CONTROLLER, ...review, pin: scopePin, observedState: scopePin });
  const program = reviewedScope({ controllerDeployment: PROGRAM, ...review, pin: scopePin, observedState: scopePin });
  governor.paths = [{ ...governor.paths[0]!, targetDeployment: SCOPE_CONTROLLER, affectedLiabilityIds: ["alpha"],
    affectedDeployments: [SCOPE_CONTROLLER, PROGRAM], capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", unavoidableDelaySec: 172800 }];
  program.paths = ["interest", "repeat", "raise"].map((id) => ({ ...program.paths[0]!, id, targetDeployment: PROGRAM,
    affectedLiabilityIds: ["alpha"], affectedDeployments: [PROGRAM], capabilities: id === "raise" ? ["parameter-change"] : ["mint"],
    capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", unavoidableDelaySec: id === "raise" ? 172800 : 0,
    permissionChangeRefs: id === "raise" ? [] : ["raise"] }));
  const evidence: V1005ExecutionCertificates["evidence"] = [SCOPE_CONTROLLER, PROGRAM].map((deployment, index) => ({
    id: `code-${index}`, pin, deployment, kind: "onchain-read", readType: "code", function: "eth_getCode", selector: null,
    calldata: null, rawResult: null, codeHash: CODE_HASH, codeSize: 100, sourceUrl: source.url, sourceLocation: "modeled runtime identity",
    statement: "Modeled pinned runtime observation for this compiler-only fixture.", artificial: false,
  }));
  evidence.push({ id: "source", pin, deployment: PROGRAM, kind: "verified-source", readType: null, function: "reviewed executable model",
    selector: null, calldata: null, rawResult: null, sourceUrl: source.url, sourceLocation: "modeled invariants",
    statement: "Modeled source enforces principal, monotone time, real beneficiaries, a finite reward envelope and governor-only changes.", artificial: false });
  evidence.push({ id: "supply", pin, deployment: SCOPE_CONTROLLER, kind: "onchain-read", readType: "evm-call", function: "votingSupply()",
    selector: "0x12345678", calldata: "0x12345678", rawResult: `0x${100n.toString(16).padStart(64, "0")}`,
    sourceUrl: source.url, sourceLocation: "modeled voting denominator", statement: "The source-defined voting denominator is exactly one hundred units.", artificial: false });
  evidence.push({ id: "native-supply", pin, deployment: PROGRAM, kind: "onchain-read", readType: "evm-call", function: "totalSupply()",
    selector: "0x18160ddd", calldata: "0x18160ddd", rawResult: `0x${100000000n.toString(16).padStart(64, "0")}`,
    sourceUrl: source.url, sourceLocation: "modeled native denominator", statement: "Unique native supply is one hundred million units, without duplicate claims.", artificial: false });
  const certificates: V1005ExecutionCertificates = { schemaVersion: 1, liabilityBookId: "book", evidence,
    proofs: ["closed", "runtime-source", "principal", "time", "beneficiary", "units", "aggregate", "activity"].map((id) => ({ id, conclusion: "closed",
      statement: "This modeled source and pinned state establish the named executable invariant.", evidenceRefIds: ["source", "supply", "native-supply"] })),
    censuses: [{ id: "mint-census", review, targetDeployment: PROGRAM, kind: "ward", role: "native-mint", coverage: "complete",
      authoritativeMembers: [SCOPE_CONTROLLER, PROGRAM], discovery: { kind: "full-history-and-constructor", fromPosition: "0", throughPosition: "100", paginationEnd: "complete", proofRef: "closed" },
      observations: [SCOPE_CONTROLLER, PROGRAM].map((memberRef, index) => ({ memberRef, authorized: true, evidenceRefIds: [`code-${index}`] })), completenessProofRef: "closed" }], classes: [], members: [] };
  const runtimeIdentity = { runtimeHash: CODE_HASH, normalizedRuntimeHash: null, proxyKind: "none" as const, implementation: null,
    implementationRuntimeHash: null, normalizedImplementationRuntimeHash: null, sourceRuntimeMatch: "exact" as const, normalization: [] };
  const runtimeRef = `0x${sha256Hex(stableJsonStringifyV1(runtimeIdentity))}`;
  const graph: V1005AuthorityGraph = { id: "graph", review, liabilityBookId: "book", governorNodeId: "governor",
    nodes: [{ id: "governor", deployment: SCOPE_CONTROLLER, kind: "token-governor", terminal: true, authorityCensusIds: ["mint-census"], runtime: { ref: runtimeRef }, proofRef: "closed" },
      { id: "operational-program", deployment: PROGRAM, kind: "fixed-program", terminal: true, authorityCensusIds: ["mint-census"], runtime: { ref: runtimeRef }, proofRef: "closed" },
      { id: "holder", deployment: HOLDER, kind: "eoa", terminal: true, authorityCensusIds: [], runtime: null, proofRef: "closed" }], edges: [],
    runtimeIdentities: [{ id: runtimeRef, identity: runtimeIdentity, proofRef: "runtime-source", evidenceRefIds: ["source", "code-0", "code-1"] }],
    pathBindings: [{ path: { controlRef: SCOPE_CONTROLLER, pathId: "issuance" }, authorityNodeIds: ["governor"], provenanceNodeIds: [], closureProofRef: "closed" },
      ...program.paths.map((path) => ({ path: { controlRef: PROGRAM, pathId: path.id }, authorityNodeIds: [path.id === "raise" ? "governor" : "operational-program"], provenanceNodeIds: ["operational-program"], closureProofRef: "closed" }))], closureProofRef: "closed" };
  const binding = { graphId: graph.id, authorityStateHash: computeV1005AuthorityStateHash(graph), observedAuthorityStateHash: computeV1005AuthorityStateHash(graph) };
  governor.authorityBinding = binding; program.authorityBinding = binding;
  const envelope = { setterNodeIds: ["governor"], raisePathRefs: [{ controlRef: PROGRAM, pathId: "raise" }], enforcementProofRef: "closed", raiseClosureProofRef: "closed" };
  const operational: V1005OperationalIssuance = { review, liabilityBookId: "book", paths: [
    { kind: "formula-interest", path: { controlRef: PROGRAM, pathId: "interest" }, principal: { kind: "deposited-principal", sourceDeployment: PROGRAM,
      getter: "principal()", units: "native", claimIdentity: "unique-principal", observedPrincipalRaw: "100000000", proofRef: "principal" },
      time: { clock: "timestamp", getter: "lastAccrued()", proofRef: "time" }, beneficiaryProofRef: "beneficiary", accountingProofRef: "closed",
      rate: { rawCap: "500000", rawUnits: "ppm-per-year", convention: "simple-apr", yearSec: 31536000, operationalAnnualRatePpmUpper: 500000,
        conversionFormula: "exact source APR", capProofRef: "closed", unitsCompoundingProofRef: "units" }, envelope },
    { kind: "keeper-incentive", path: { controlRef: PROGRAM, pathId: "repeat" }, lifecycle: "repeat", liabilityBookId: "book", principalProvenanceProofRef: "principal",
      eligibilityProofRef: "activity", debtBookChargeProofRef: "closed", proportionalRewardPpm: 1000, fixedRewardRaw: "1", rewardUnits: "native", minimumRepeatSec: 3600,
      repeatScope: "funded-activity", initialCompensation: null, chosenRecipient: false, sameActivityMayRepeat: true, lifetimeBudgetEnforced: false, envelope }],
    interestAggregate: { liabilityBookId: "book", pathRefs: [{ controlRef: PROGRAM, pathId: "interest" }], principalClaimIds: ["unique-principal"], principalRaw: "100000000",
      principalUnits: "native", annualGrowthPpmUpper: 500000, formula: "unique-claim maximum", deduplicationProofRef: "aggregate", compoundingProofRef: "units", scopeProofRef: "closed" },
    keeperAggregate: { liabilityBookId: "book", pathRefs: [{ controlRef: PROGRAM, pathId: "repeat" }], denominatorRaw: "100000000", denominatorUnits: "native",
      denominatorEvidenceRefIds: ["native-supply"], windowSec: 86400, upperRepeatRewardRaw: "264000", rewardUnits: "native",
      repeatGroups: [{ id: "repeat-group", pathRefs: [{ controlRef: PROGRAM, pathId: "repeat" }], inFlightCapRaw: "1000000", minimumPaidAuctionRaw: "100",
        fixedRewardRawUpper: "1", proportionalRewardPpmUpper: 1000, maxRepeatsPerWindow: 24, capAndMultiplicityProofRef: "aggregate", repeatAndBoundaryProofRef: "activity" }],
      repeatCouplingGroups: [], formula: "stock times source-enforced recurrence", activityAntiFarmingProofRef: "activity", deduplicationProofRef: "aggregate",
      initialAndBoundaryProofRef: "activity", scopeProofRef: "closed" } };
  return { mintPath: "user-collateralized-governed", authorityPosture: "unbounded-operationally-governed", confidence: "verified",
    summary: "Modeled economically unbounded operationally governed issuance.", economicCapSemantics: "unbounded", reconciliation: "none", supervision: "none",
    review: { reviewer: review.reviewer, reviewedAt: review.reviewedAt, evidence: "The modeled fixture closes every native issuance path at its evidence pin.", disposition: "scoreable", sources: [source] },
    controls: [{ chain: "ethereum", address: SCOPE_CONTROLLER.split(":")[1], label: "Token governor", role: "governor", authorityType: "dao-governor", directMintAbility: "can-authorize", executionScope: governor, sources: [source] },
      { chain: "ethereum", address: PROGRAM.split(":")[1], label: "Operational program", role: "direct-minter", authorityType: "contract", directMintAbility: "direct", executionScope: program, sources: [source] }],
    executionCertificates: certificates, authorityGraph: graph, operationalIssuance: operational,
    governedIssuance: { decisionRule: "affirmative-vote", governorControlRef: SCOPE_CONTROLLER, votingPower: "lock-escrowed",
      votingPowerEvidence: "Locked voting positions cannot be sourced by a same-transaction loan.", enumerability: { authorizationEvents: ["Ward(address)"], capacityReads: ["capacity(address)"] },
      observedAt: review.observedAt, observedBlock: 100, reviewedAt: review.reviewedAt, reviewer: review.reviewer, sources: [source],
      votingControl: { id: "voting", governorNodeId: "governor", review, votingToken: SCOPE_CONTROLLER, totalVotingPowerRaw: "100",
        pinnedVotingSupply: { deployment: SCOPE_CONTROLLER, function: "votingSupply()", raw: "100", proofRef: "closed" }, controllerCensusProofRef: "closed",
        holderCensus: [{ id: "own-position", deployment: HOLDER, balanceRaw: "60", votingPowerRaw: "60", delegate: null, ownerControllerId: "dominant-own-holder", evidenceRefIds: ["source"], provenance: "own" },
          { id: "small-position", deployment: PROGRAM, balanceRaw: "40", votingPowerRaw: "40", delegate: null, ownerControllerId: "small-holder", evidenceRefIds: ["source"], provenance: "own" }],
        controllers: [{ id: "dominant-own-holder", accounts: [HOLDER], votingPowerRaw: "60", affiliation: "unknown", beneficialControl: "unknown", voteAuthorityNodeIds: ["holder"],
          holderRevocation: "onchain-at-will", revocationProofRef: "closed", ownedPositionIds: ["own-position"], ownVoteOwnershipProofRef: "closed", otherHolderVoteAuthorityProofRef: "closed", voteReplacementApproval: "not-applicable", attributionProofRef: "closed" },
          { id: "small-holder", accounts: [PROGRAM], votingPowerRaw: "40", affiliation: "unknown", beneficialControl: "unknown", voteAuthorityNodeIds: ["operational-program"],
            holderRevocation: "unknown", revocationProofRef: "closed", ownedPositionIds: ["small-position"], ownVoteOwnershipProofRef: "closed", otherHolderVoteAuthorityProofRef: "closed", voteReplacementApproval: "not-applicable", attributionProofRef: "closed" }],
        routes: [{ id: "approval", path: { controlRef: SCOPE_CONTROLLER, pathId: "issuance" }, kind: "affirmative-approval", totalVotingPowerRaw: "100", unilateralThresholdRaw: "50", thresholdComparator: "gt", thresholdProofRef: "closed",
          holderCensusRef: "holderCensus", controllerPowers: [], residualUpperRaw: "0", residualProofRef: "closed", affiliatedControllerIds: [], affiliatedAggregatePowerRaw: "0", affiliatedAggregateUnilateralThresholdRaw: "50", affiliatedAggregateThresholdComparator: "gt", affiliatedAggregateThresholdProofRef: "closed", minorityProtectionProofRef: null }],
        privilegedVoteCreation: { state: "none", pathRefs: [], proofRef: "closed" }, forcedDelegation: { state: "none", pathRefs: [], proofRef: "closed" } } } };
}

function restamp(profile: MintAuthorityProfile): void {
  const hash = computeV1005AuthorityStateHash(profile.authorityGraph!);
  for (const control of profile.controls ?? []) if (control.executionScope) control.executionScope.authorityBinding = { graphId: profile.authorityGraph!.id, authorityStateHash: hash, observedAuthorityStateHash: hash };
}
function compile(profile = modeledProfile(), assetId = "alpha", sharedProfiles: readonly V9ExtensionRegistryMeta[] = [], registryFields: Partial<V9ExtensionRegistryMeta> = {}) {
  const fixed = makeV9FixedInput({ assetId, clockSec: CLOCK });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(alphaMeta({ ...registryFields, id: assetId, mintAuthority: profile }), ...sharedProfiles) });
  if (extension.assets[0]!.admissionQuarantine) throw new Error(JSON.stringify(extension.assets[0]!.admissionQuarantine));
  const input = normalizeSafetyScoreV9CompilerInput(fixed);
  const { factSet, quarantines } = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(input, materializeSafetyScoreV9FactSetExtension(input, extension));
  if (quarantines.length > 0) throw new Error(JSON.stringify(quarantines));
  const rows = factSet.assets[0]!.controls.filter((row) => row.controlKey.startsWith(`mint-meta:${assetId}:`));
  const asset = factSet.assets[0]!;
  return { rows, governance: asset.issuanceFacts?.governance!, process: asset.issuanceFacts?.process, asset, extension };
}
function failProof(profile: MintAuthorityProfile, id: string): void {
  profile.executionCertificates!.proofs.find((proof) => proof.id === id)!.conclusion = "open";
}

function modeledVetoProfile(): MintAuthorityProfile {
  const profile = modeledProfile();
  delete profile.operationalIssuance;
  profile.authorityPosture = "unbounded-veto-guarded";
  const governed = profile.governedIssuance!;
  governed.decisionRule = "minority-veto"; governed.votingPower = "holding-period-weighted";
  governed.veto = { quorumBps: 200, entrypoints: ["0xdeadbeef"], override: "none",
    evidence: "The modeled source requires a public veto window for every native expansion, and the selector-complete governor can block each identified native minter without an independent override." };
  const governor = profile.controls![0]!.executionScope!, minter = profile.controls![1]!.executionScope!;
  governor.paths = [{ ...governor.paths[0]!, id: "veto", targetDeployment: PROGRAM, capabilities: ["parameter-change"], entrypoints: ["0xdeadbeef"],
    capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } }, claimImpairment: "none", unavoidableDelaySec: 0 }];
  minter.paths = [{ ...minter.paths[0]!, id: "issuance", permissionChangeRefs: [], unavoidableDelaySec: 1209600 }];
  profile.authorityGraph!.pathBindings = [{ path: { controlRef: SCOPE_CONTROLLER, pathId: "veto" }, authorityNodeIds: ["governor"], provenanceNodeIds: [], closureProofRef: "closed" },
    { path: { controlRef: PROGRAM, pathId: "issuance" }, authorityNodeIds: ["governor"], provenanceNodeIds: [], closureProofRef: "closed" }];
  governed.votingControl.routes[0]!.path = { controlRef: SCOPE_CONTROLLER, pathId: "veto" };
  governed.votingControl.routes[0]!.kind = "veto-neutralization";
  restamp(profile);
  return profile;
}

function bindPath(profile: MintAuthorityProfile, pathId: string, controlRef = PROGRAM): void {
  profile.authorityGraph!.pathBindings.push({ path: { controlRef, pathId }, authorityNodeIds: ["governor"], provenanceNodeIds: [], closureProofRef: "closed" });
  restamp(profile);
}

function modeledClassProfile(): MintAuthorityProfile {
  const profile = modeledProfile();
  const control = profile.controls![1]!, scope = control.executionScope!;
  const runtime = { deployment: PROGRAM, runtimeHash: CODE_HASH, normalizedRuntimeHash: null, proxyKind: "none" as const, implementation: null,
    implementationRuntimeHash: null, normalizedImplementationRuntimeHash: null, sourceRuntimeMatch: "exact" as const, normalization: [], matchProofRef: "closed", evidenceRefIds: ["code-1", "source"] };
  profile.executionCertificates!.classes = [{ id: "program-class", review, runtimeVariants: [runtime], invariants: ["closed"], requiredConditions: [], memberRefs: [PROGRAM], closure: scope.closure,
    paths: scope.paths.map(({ targetDeployment, activation, unavoidableDelaySec, affectedLiabilityIds, affectedDeployments, ...template }) => ({ ...template, proofRef: "closed" })) }];
  profile.executionCertificates!.members = [{ memberRef: PROGRAM, classId: "program-class", censusIds: ["mint-census"], review, runtime, conditions: [], extensions: scope.extensions,
    pathBindings: scope.paths.map((path) => ({ templateId: path.id, targetDeployment: path.targetDeployment, activation: path.activation, unavoidableDelaySec: path.unavoidableDelaySec,
      affectedLiabilityIds: path.affectedLiabilityIds, affectedDeployments: path.affectedDeployments, authorityNodeIds: [path.id === "raise" ? "governor" : "operational-program"], provenanceNodeIds: ["operational-program"], proofRef: "closed" })) }];
  delete control.executionScope; control.executionClassRef = { classId: "program-class", memberRef: PROGRAM };
  return profile;
}

function nativeRegistryFields(address: string): Pick<V9ExtensionRegistryMeta, "contracts" | "bridgeRouteRisk"> {
  const deployment = `ethereum:${address}`;
  return { contracts: [{ chain: "ethereum", address, decimals: 18 }], bridgeRouteRisk: {
    tier: "single-chain-or-native", summary: "Modeled reviewed native token deployment for shared-book selection.",
    reviewedAt: review.reviewedAt, reviewer: review.reviewer, confidence: "verified", sources: [source],
    routes: [{ id: deployment, destinationChain: "ethereum", canonicalChain: "ethereum", contractAddress: address,
      protocol: "Modeled native book", issuanceModel: "native-issuance", routeClass: "native", riskTier: "single-chain-or-native",
      semantics: "native-mint", scope: "canonical", reviewDisposition: "reviewed", observedAt: review.observedAt, sources: [source] }],
  } };
}

function modeledSharedProfiles() {
  const sourceAddress = "0x6666666666666666666666666666666666666666", targetAddress = "0x7777777777777777777777777777777777777777";
  const sourceDeployment = `ethereum:${sourceAddress}`, targetDeployment = `ethereum:${targetAddress}`;
  const sourceProfile = modeledProfile();
  for (const control of sourceProfile.controls!) control.deploymentRefs = [sourceDeployment];
  const profile = structuredClone(sourceProfile);
  const sharedBookRef = { assetId: "shared-source", liabilityBookId: "book", authorityGraphId: "graph", authorityStateHash: computeV1005AuthorityStateHash(sourceProfile.authorityGraph!) };
  profile.executionCertificates = { schemaVersion: 1, liabilityBookId: "book", sharedBookRef, evidence: [], proofs: [], censuses: [], classes: [], members: [] };
  delete profile.authorityGraph; delete profile.governedIssuance; delete profile.operationalIssuance;
  profile.controls = [{ ...profile.controls![0]!, deploymentRefs: [targetDeployment] }];
  const sourceMeta = alphaMeta({ ...nativeRegistryFields(sourceAddress), id: "shared-source", mintAuthority: sourceProfile });
  return { sourceProfile, profile, sharedBookRef, sourceMeta, targetFields: nativeRegistryFields(targetAddress), sourceDeployment, targetDeployment };
}

describe("v10.05 source-bound operational and voting compilation", () => {
  it("reuses only strictly admitted frozen asset identities and rejects an altered external clone", () => {
    const { extension } = compile(), original = extension.assets[0]!;
    const admitted = admitSafetyScoreV9ExtensionAsset(original, CLOCK);
    expect(admitted).toBe(original);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.issuanceFacts!.process!.votingControl)).toBe(true);
    expect(Reflect.set(admitted.issuanceFacts!, "ref", "forged")).toBe(false);
    const retained = admitSafetyScoreV9FactSetExtension(extension, (asset) => asset);
    expect(retained.assets[0]).toBe(original);
    const external = structuredClone(extension);
    const parsed = admitSafetyScoreV9FactSetExtension(external, (asset) => asset);
    expect(parsed.assets[0]).not.toBe(external.assets[0]);
    expect(parsed.assets[0]).toEqual(original);
    const review = external.assets[0]!.controlReview;
    if (!review || !("controls" in review)) throw new Error("Expected native control review");
    review.controls[0]!.issuanceFactsRef = "forged";
    const rejected = admitSafetyScoreV9FactSetExtension(external, (asset) => asset);
    expect(rejected.assets[0]!.admissionQuarantine).toMatchObject({ code: "fact-validation-failed" });
    expect(rejected.assets[0]!.issuanceFacts).toBeUndefined();
    expect(admitSafetyScoreV9ExtensionAsset(external.assets[0], CLOCK).admissionQuarantine).toMatchObject({ code: "fact-validation-failed" });
  });

  it("batch-admits producer scope roots and contributors without mutating or trusting external roots", () => {
    const { extension } = compile(), external = structuredClone(extension.assets[0]!);
    const review = external.controlReview;
    if (!review || !("controls" in review)) throw new Error("Expected native control review");
    const control = review.controls.find((row) => row.executionScope)!;
    control.executionScopeContributors = [{ authorityKey: SCOPE_CONTROLLER, scope: structuredClone(control.executionScope!) }];
    const original = control.executionScope;
    const admitted = admitSafetyScoreV9ExtensionAsset(external, CLOCK);
    const admittedReview = admitted.controlReview;
    if (!admittedReview || !("controls" in admittedReview)) throw new Error("Expected admitted native control review");
    const admittedControl = admittedReview.controls.find((row) => row.controlKey === control.controlKey)!;
    expect(admittedControl.executionScope).not.toBe(original);
    expect(admittedControl.executionScopeContributors![0]!.scope).toBe(admittedControl.executionScope);
    expect(Object.isFrozen(admittedControl.executionScope!.paths)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    expect(control.executionScope).toBe(original);
    control.executionScopeContributors[0]!.scope!.paths[0]!.permissionChangeRefs = ["missing-path"];
    const rejected = admitSafetyScoreV9ExtensionAsset(external, CLOCK);
    expect(rejected.admissionQuarantine).toMatchObject({ code: "fact-validation-failed" });
    expect(rejected.issuanceFacts).toBeUndefined();
  });

  it("interns equal strictly parsed producer facts before sealing and rejects an invalid external fact", () => {
    const { extension } = compile(), external = structuredClone(extension.assets[0]!);
    const bundle = external.issuanceFacts!;
    bundle.process!.votingControl = structuredClone(bundle.governance!.votingControl!);
    expect(bundle.process!.votingControl).not.toBe(bundle.governance!.votingControl);
    const admitted = admitSafetyScoreV9ExtensionAsset(external, CLOCK);
    expect(admitted.issuanceFacts!.process!.votingControl).toBe(admitted.issuanceFacts!.governance!.votingControl);
    expect(Object.isFrozen(admitted.issuanceFacts!.process!.votingControl)).toBe(true);
    expect(Object.isFrozen(bundle)).toBe(false);
    expect(bundle.process!.votingControl).not.toBe(bundle.governance!.votingControl);
    expect(admitSafetyScoreV9ExtensionAsset(admitted, CLOCK)).toBe(admitted);
    bundle.process!.matchedMemberCount = -1;
    const rejected = admitSafetyScoreV9ExtensionAsset(external, CLOCK);
    expect(rejected.admissionQuarantine).toMatchObject({ code: "fact-validation-failed" });
    expect(rejected.issuanceFacts).toBeUndefined();
  });

  it.each(["missing-bundle", "mismatch", "mixed-governance", "mixed-process", "mixed-diagnostics", "missing-native-ref", "bridge-ref"] as const)("joins the canonical bundle and rejects the single %s reference gate", (failure) => {
    const positive = compile();
    expect(V9AssetFactsV3Schema.safeParse(positive.asset).success).toBe(true);
    expect(SafetyScoreV9FactSetExtensionV2Schema.safeParse(positive.extension).success).toBe(true);
    const asset = structuredClone(positive.asset), extension = structuredClone(positive.extension);
    const authored = extension.assets[0]!;
    if (!authored.controlReview || !("controls" in authored.controlReview)) throw new Error("Expected native control review");
    const row = asset.controls.find((control) => control.issuanceFactsRef)!;
    const producerRow = authored.controlReview.controls.find((control) => control.issuanceFactsRef)!;
    if (failure === "missing-bundle") { delete asset.issuanceFacts; delete authored.issuanceFacts; }
    else for (const control of [row, producerRow]) {
      if (failure === "mismatch") control.issuanceFactsRef = "unresolved-bundle";
      if (failure === "mixed-governance") control.issuanceGovernance = positive.governance;
      if (failure === "mixed-process") control.issuanceProcess = positive.process;
      if (failure === "mixed-diagnostics") control.processDiagnostics = [];
      if (failure === "missing-native-ref") delete control.issuanceFactsRef;
      if (failure === "bridge-ref") control.controlKind = "bridge";
    }
    expect(V9AssetFactsV3Schema.safeParse(asset).success).toBe(false);
    expect(SafetyScoreV9FactSetExtensionV2Schema.safeParse(extension).success).toBe(false);
  });

  it("allows caller-designated formula-bound keeper compensation, not a discretionary amount", () => {
    const profile = modeledProfile(), entry = profile.operationalIssuance!.paths[1]!;
    if (entry.kind !== "keeper-incentive") throw new Error("Expected keeper fixture");
    entry.chosenRecipient = true;
    expect(compile(profile).process).toMatchObject({ coverage: "complete", keeperQualified: true });
    entry.fixedRewardRaw = null;
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "keeper-activity-unproved", gate: "H2", pathId: "repeat" }));
  });

  it("compares the formula kick award against penalty rather than the entire debt base", () => {
    const profile = modeledProfile(), entry = profile.operationalIssuance!.paths[1]!, aggregate = profile.operationalIssuance!.keeperAggregate!;
    if (entry.kind !== "keeper-incentive") throw new Error("Expected keeper fixture");
    entry.lifecycle = "initial-kick"; entry.sameActivityMayRepeat = false;
    entry.initialCompensation = { newDebtAdmission: "immediate", minimumNewPositionDebtRaw: "1000", rewardDebtRawAtMinimum: "1100",
      liquidationPenaltyChargeRawAtMinimum: "100", historicalStockDebtRaw: "1000", historicalDebtPositionCountUpper: "1",
      historicalPaidLiquidationCountUpper: "1", historicalStockKickRewardRawUpper: "2",
      newDebtReachProofRef: "closed", minimumAndPenaltyProofRef: "closed", historicalStockProofRef: "closed", oncePerLiquidationProofRef: "closed" };
    aggregate.repeatGroups = []; aggregate.upperRepeatRewardRaw = "0";
    expect(compile(profile).process).toMatchObject({ coverage: "complete", keeperQualified: true, keeperInitialPathCount: 1 });
    entry.initialCompensation.liquidationPenaltyChargeRawAtMinimum = "2";
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "keeper-activity-unproved", field: "initialCompensation.minimumAndPenalty" }));
  });

  it("proves full-history census closure without a getter-pagination sentinel", () => {
    const profile = modeledProfile(), census = profile.executionCertificates!.censuses[0]!;
    census.discovery.paginationEnd = null;
    expect(compile(profile).process?.coverage).toBe("complete");
    census.discovery.kind = "exhaustive-getter";
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "authority-census-incomplete" }));
  });

  it("accepts a source-proved immutable stock without inventing an envelope setter", () => {
    const profile = modeledProfile(), path = profile.controls![1]!.executionScope!.paths[0]!;
    path.capSemantics = { kind: "bounded", bound: { amount: 1000, unit: "token-units" } }; path.claimImpairment = "bounded";
    path.controlRefs = []; path.reactivationRefs = []; path.permissionChangeRefs = []; path.upgradeRefs = []; path.bypassRefs = [];
    profile.operationalIssuance!.paths[0] = { kind: "bounded-stock", path: { controlRef: PROGRAM, pathId: "interest" },
      invariantProofRef: "principal", economicReachProofRef: "closed", envelope: null };
    profile.operationalIssuance!.interestAggregate = null;
    expect(compile(profile).process).toMatchObject({ coverage: "complete", otherClassesQualified: true });
    path.permissionChangeRefs = ["raise"];
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "economic-reach-unclosed", gate: "H4", pathId: "interest" }));
    path.permissionChangeRefs = []; failProof(profile, "principal");
    expect(compile(profile).process?.otherClassesQualified).toBe(false);
  });

  it("distinguishes an existing open authority proof from an unresolved reference", () => {
    const profile = modeledProfile();
    profile.executionCertificates!.proofs.push({ id: "root-closure", conclusion: "closed",
      statement: "The modeled exhaustive authority census closes this particular governor execution root.", evidenceRefIds: ["source"] });
    profile.authorityGraph!.nodes[0]!.proofRef = "root-closure"; restamp(profile);
    expect(compile(profile).process?.coverage).toBe("complete");
    failProof(profile, "root-closure");
    const open = compile(profile);
    expect(open.governance.diagnostics).toContainEqual(expect.objectContaining({ code: "economic-reach-unclosed", field: "authorityGraph.nodes.governor.proofRef" }));
    expect(open.governance.diagnostics.some((row) => row.code === "graph-reference-unresolved" && row.field === "authorityGraph.nodes.governor")).toBe(false);
    profile.executionCertificates!.proofs = profile.executionCertificates!.proofs.filter((proof) => proof.id !== "root-closure");
    expect(compile(profile).governance.diagnostics).toContainEqual(expect.objectContaining({ code: "graph-reference-unresolved", field: "authorityGraph.nodes.governor" }));
  });

  it.each(["terminal-governor", "census", "census-expired", "cycle-proof", "key-alternative"] as const)("closes a certified governor-containing component but fails the single %s cycle gate", (failure) => {
    const profile = modeledProfile(), graph = profile.authorityGraph!;
    graph.nodes.push({ ...graph.nodes[1]!, id: "cycle-agent", kind: "contract", terminal: false });
    graph.pathBindings[0]!.authorityNodeIds = ["cycle-agent"];
    profile.executionCertificates!.proofs.push({ id: "cycle-closure", conclusion: "closed",
      statement: "The modeled exhaustive role census and source invariant close the governor and agent authority component.", evidenceRefIds: ["source"] });
    for (const [id, from, to] of [["agent-governor", "cycle-agent", "governor"], ["governor-agent", "governor", "cycle-agent"], ["agent-self", "cycle-agent", "cycle-agent"]]) {
      graph.edges.push({ id: id!, from: from!, to: to!, kind: "upgrade", pathRefs: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance" }],
        selectors: [], role: "governed-replacement", activation: "active", publicDelaySec: 172800, calldataBound: true, proofRef: "cycle-closure" });
    }
    restamp(profile);
    expect(compile(profile).process?.coverage).toBe("complete");
    if (failure === "terminal-governor") graph.nodes[0]!.terminal = false;
    if (failure === "census") profile.executionCertificates!.censuses[0]!.coverage = "partial";
    if (failure === "census-expired") profile.executionCertificates!.censuses[0]!.review = { ...review, expiresAt: "2026-10-04" };
    if (failure === "cycle-proof") failProof(profile, "cycle-closure");
    if (failure === "key-alternative") graph.edges.push({ id: "external-key", from: "cycle-agent", to: "holder", kind: "admin",
      pathRefs: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance" }], selectors: [], role: "independent-admin", activation: "active",
      publicDelaySec: 172800, calldataBound: true, proofRef: "closed" });
    restamp(profile);
    const denied = compile(profile);
    expect(denied.process?.coverage).toBe("incomplete");
    expect(denied.process?.diagnostics).toContainEqual(expect.objectContaining({ controlRef: SCOPE_CONTROLLER, pathId: "issuance",
      code: failure === "key-alternative" ? "discretionary-root-independent" : "graph-cycle-unclosed" }));
  });

  it("joins compact codeHash reads only through the content-bound reviewed member table", () => {
    const profile = modeledClassProfile(), certificates = profile.executionCertificates!, klass = certificates.classes[0]!;
    profile.controls![1]!.executionScope = modeledProfile().controls![1]!.executionScope;
    delete profile.controls![1]!.executionClassRef; certificates.members = [];
    klass.sourcePathRefs = [{ controlRef: PROGRAM, pathId: "interest" }];
    klass.compactMembers = [{ deployment: PROGRAM, codeHash: CODE_HASH, codeSize: 100, immutables: {}, state: {}, evidenceRefIds: ["code-1"] }];
    Object.assign(certificates.evidence.find((row) => row.id === "code-1")!, { readType: "read-bundle", codeHash: undefined, codeSize: undefined,
      captureHash: HASH, fieldReads: [{ field: "codeHash", function: "eth_getCode", selector: null, returnKind: "code-hash", target: "row-deployment", readType: "code" }] });
    expect(compile(profile).process?.diagnostics).toEqual([]);
    klass.compactMembers[0]!.codeHash = HASH;
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "runtime-unmatched", memberRef: PROGRAM }));
  });

  it("compiles one neutral process and voting object once per asset with exact native references", () => {
    const { rows, governance, process, asset } = compile();
    expect(governance.votingControl).toMatchObject({ observationState: "known", qualified: true, largestSingleControllerShareBps: 6000 });
    expect(process).toMatchObject({ coverage: "complete", maxAnnualInterestGrowthPpm: 500000, maxKeeperProportionalRewardPpm: 1000,
      minKeeperRecurringIntervalSec: 3600, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 2640,
      minDiscretionaryPublicDelaySec: 172800, minOperationalExerciseDelaySec: 0, envelopeTransitionPathCount: 1,
      memberCount: 2, matchedMemberCount: 2, unknownMemberCount: 0 });
    expect(rows.every((row) => row.issuanceFactsRef === asset.issuanceFacts!.ref)).toBe(true);
    expect(rows.every((row) => row.issuanceProcess === undefined && row.issuanceGovernance === undefined && row.processDiagnostics === undefined)).toBe(true);
    expect(deriveV9MintPosture(rows[0]!, makeReviewedMintInput(rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, asset.issuanceFacts)).toBe("unbounded-operationally-governed");
  });

  it.each(["affiliated", "other-holder", "omitted-holder", "unknown-ownership", "privilege"] as const)("denies the single D32 %s gate without erasing known unbounded facts", (failure) => {
    const profile = modeledProfile();
    const voting = profile.governedIssuance!.votingControl;
    if (failure === "affiliated") { voting.controllers[0]!.affiliation = "team"; voting.routes[0]!.affiliatedControllerIds = ["dominant-own-holder"]; voting.routes[0]!.affiliatedAggregatePowerRaw = "60"; }
    if (failure === "other-holder") { voting.holderCensus[0]!.provenance = "other"; voting.controllers[0]!.voteReplacementApproval = "key-discretion"; }
    if (failure === "omitted-holder") voting.holderCensus.shift();
    if (failure === "unknown-ownership") voting.holderCensus[0]!.provenance = "unknown";
    if (failure === "privilege") voting.privilegedVoteCreation.state = "independent";
    const { rows, governance, process } = compile(profile);
    expect(governance.votingControl.qualified).toBe(false);
    const code = failure === "affiliated" ? "voting-affiliated-unilateral" : failure === "other-holder" ? "voting-other-holder-operator" : failure === "omitted-holder" ? "voting-census-unreconciled" : failure === "privilege" ? "voting-privilege-independent" : "voting-provenance-unknown";
    expect(governance.diagnostics).toContainEqual(expect.objectContaining({ code, gate: "D32" }));
    expect(process?.coverage).toBe("incomplete");
    expect(rows.some((row) => row.capSemantics.kind === "unbounded" && row.claimImpairment === "unbounded")).toBe(true);
  });

  it("keeps below-threshold unknown ownership admissible and reconciles all three row lists", () => {
    const profile = modeledProfile();
    const voting = profile.governedIssuance!.votingControl;
    voting.routes[0]!.controllerPowers = [{ controllerId: "small-holder", ownHolderRowIds: [], otherHolderRowIds: [], unknownProvenanceHolderRowIds: ["small-position"], unilateralThresholdRaw: "50", thresholdComparator: "gt", thresholdProofRef: "closed" }];
    expect(compile(profile).governance.votingControl).toMatchObject({ qualified: true, censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
    voting.routes[0]!.controllerPowers[0]!.ownHolderRowIds = ["small-position"];
    expect(compile(profile).governance.votingControl.diagnostics).toContainEqual(expect.objectContaining({ code: "voting-census-unreconciled" }));
  });

  it.each(["principal", "time", "beneficiary", "units", "activity", "aggregate"])("retains neutral measurements while failing the single %s proof", (proof) => {
    const profile = modeledProfile(); failProof(profile, proof);
    const { process, rows } = compile(profile);
    expect(process?.coverage).toBe("incomplete");
    const code = proof === "principal" ? "formula-principal-unproved" : proof === "time" ? "formula-time-unproved" : proof === "beneficiary" ? "formula-beneficiary-unproved" : proof === "units" ? "rate-units-unproved" : proof === "activity" ? "keeper-activity-unproved" : "aggregate-flow-unproved";
    expect(process?.diagnostics).toContainEqual(expect.objectContaining({ code }));
    expect(rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it.each(["D29", "D30", "H"] as const)("applies the same own-lock and positive affiliation gate to %s", (family) => {
    const profile = family === "D30" ? modeledVetoProfile() : modeledProfile();
    if (family === "D29") {
      delete profile.operationalIssuance; profile.authorityPosture = "unbounded-governed";
      profile.controls![1]!.executionScope!.paths.forEach((path) => { path.unavoidableDelaySec = 172800; });
      profile.authorityGraph!.pathBindings.forEach((binding) => { binding.authorityNodeIds = ["governor"]; }); restamp(profile);
    }
    const positive = compile(profile), control = positive.rows.find((row) => row.capSemantics.kind === "unbounded" && row.capabilities.includes("mint"))!;
    expect(positive.governance.votingControl.qualified).toBe(true);
    expect(deriveV9MintPosture(control, makeReviewedMintInput(control.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, positive.asset.issuanceFacts))
      .toBe(family === "D29" ? "unbounded-governed" : family === "D30" ? "unbounded-veto-guarded" : "unbounded-operationally-governed");
    const voting = profile.governedIssuance!.votingControl;
    voting.controllers[0]!.affiliation = "team"; voting.routes[0]!.affiliatedControllerIds = ["dominant-own-holder"]; voting.routes[0]!.affiliatedAggregatePowerRaw = "60";
    const denied = compile(profile);
    expect(denied.governance.votingControl).toMatchObject({ qualified: false, largestSingleControllerShareBps: 6000 });
    expect(denied.governance.diagnostics).toContainEqual(expect.objectContaining({ code: "voting-affiliated-unilateral", gate: "D32" }));
  });

  it("does not let dominant own stake waive a disclosed other-holder key replacement", () => {
    const profile = modeledProfile(), voting = profile.governedIssuance!.votingControl;
    voting.routes[0]!.controllerPowers = [{ controllerId: "dominant-own-holder", ownHolderRowIds: [], otherHolderRowIds: ["small-position"],
      unknownProvenanceHolderRowIds: [], unilateralThresholdRaw: "50", thresholdComparator: "gt", thresholdProofRef: "closed" }];
    voting.controllers[0]!.voteReplacementApproval = "key-discretion";
    expect(compile(profile).governance.votingControl).toMatchObject({ qualified: false, otherHolderVoteOperatorControllerIds: ["dominant-own-holder"] });
  });
  it("keeps dominant proven own stake admissible when extra unknown provenance cannot be decisive", () => {
    const profile = modeledProfile(), voting = profile.governedIssuance!.votingControl;
    voting.routes[0]!.controllerPowers = [{ controllerId: "dominant-own-holder", ownHolderRowIds: [], otherHolderRowIds: [],
      unknownProvenanceHolderRowIds: ["small-position"], unilateralThresholdRaw: "50", thresholdComparator: "gt", thresholdProofRef: "closed" }];
    expect(compile(profile).governance.votingControl).toMatchObject({ qualified: true, unknownAboveThresholdVoteOwnershipControllerIds: [] });
    voting.holderCensus[0]!.provenance = "unknown";
    expect(compile(profile).governance.votingControl).toMatchObject({ qualified: false, unknownAboveThresholdVoteOwnershipControllerIds: ["dominant-own-holder"] });
  });


  it("keeps source-known delay and vote-age measurements neutral rather than clearing missing source", () => {
    const profile = modeledProfile();
    delete profile.operationalIssuance;
    profile.authorityPosture = "unbounded-governed";
    profile.controls![1]!.executionScope!.paths.forEach((path) => { path.unavoidableDelaySec = 172800; });
    profile.authorityGraph!.pathBindings.forEach((binding) => { binding.authorityNodeIds = ["governor"]; });
    restamp(profile);
    expect(compile(profile).governance).toMatchObject({ coverage: "complete", minUnavoidableDelaySec: 172800, nonGovernorUnboundedPathKeys: [] });
    profile.governedIssuance!.votingPower = "live-balance";
    profile.controls![1]!.executionScope!.paths[0]!.unavoidableDelaySec = 60;
    const short = compile(profile);
    expect(short.governance).toMatchObject({ coverage: "complete", minUnavoidableDelaySec: 60, votingPower: "live-balance" });
    expect(deriveV9MintPosture(short.rows[0]!, makeReviewedMintInput(short.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, short.asset.issuanceFacts)).toBe("unbounded-adverse");
    profile.controls![1]!.executionScope!.paths[0]!.unavoidableDelaySec = null;
    expect(compile(profile).governance.minUnavoidableDelaySec).toBeNull();
    profile.controls![1]!.executionScope!.inventory = "partial";
    expect(compile(profile).governance.coverage).toBe("incomplete");
  });

  it.each(["inactive", "missing-selector", "wrong-target", "unbounded-bypass"] as const)("requires the single D30 %s veto gate", (failure) => {
    const profile = modeledVetoProfile();
    expect(compile(profile).governance).toMatchObject({ coverage: "complete", decisionRule: "minority-veto", minUnavoidableDelaySec: 1209600 });
    const veto = profile.controls![0]!.executionScope!.paths[0]!;
    if (failure === "inactive") veto.activation = "disabled-reactivatable";
    if (failure === "missing-selector") veto.entrypoints = ["0x12345678"];
    if (failure === "wrong-target") veto.targetDeployment = SCOPE_CONTROLLER;
    if (failure === "unbounded-bypass") { veto.capSemantics = { kind: "unbounded", bound: null }; veto.claimImpairment = "unbounded"; }
    const governance = compile(profile).governance;
    expect(governance.coverage).toBe("incomplete");
    expect(governance.diagnostics).toContainEqual(expect.objectContaining({ gate: "D30", code: failure === "unbounded-bypass" ? "governor-carries-unbounded-path" : "governor-without-veto-path" }));
  });

  it("does not substitute delayed public admission for the admitted minter's actual zero-delay path", () => {
    const profile = modeledVetoProfile();
    profile.controls![1]!.executionScope!.paths[0]!.unavoidableDelaySec = 0;
    const compiled = compile(profile);
    expect(compiled.governance).toMatchObject({ coverage: "complete", minUnavoidableDelaySec: 0 });
    const minter = compiled.rows.find((row) => row.capabilities.includes("mint"))!;
    expect(deriveV9MintPosture(minter, makeReviewedMintInput(minter.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, compiled.asset.issuanceFacts)).toBe("unbounded-adverse");
  });

  it.each(["unlisted", "short-change", "unknown-rule", "unbounded"] as const)("requires the single D30-S %s rate-path gate", (failure) => {
    const profile = modeledVetoProfile();
    const scope = profile.controls![1]!.executionScope!;
    scope.paths.push({ ...scope.paths[0]!, id: "rate", capSemantics: { kind: "raiseable", bound: null }, claimImpairment: "bounded", unavoidableDelaySec: 0 });
    bindPath(profile, "rate");
    profile.governedIssuance!.monetaryPolicyPaths = [{ controlRef: PROGRAM, pathId: "rate", rateCapPpm: 500000,
      rateChangeDelaySec: V9_CANDIDATE_POLICY_V1.policy.semantic.control.governedIssuance.minorityVeto.monetaryPolicy.minRateChangeDelaySec,
      rateChangeRule: "minority-replaceable", evidence: "The modeled interest rate is a reviewed raiseable parameter; the source requires delayed changes and minority replacement rather than admitting a new unbacked chosen-recipient principal route." }];
    expect(compile(profile).governance).toMatchObject({ coverage: "complete", minUnavoidableDelaySec: 1209600 });
    if (failure === "unlisted") delete profile.governedIssuance!.monetaryPolicyPaths;
    if (failure === "short-change") profile.governedIssuance!.monetaryPolicyPaths![0]!.rateChangeDelaySec = 0;
    if (failure === "unknown-rule") profile.governedIssuance!.monetaryPolicyPaths![0]!.rateChangeRule = "unknown";
    if (failure === "unbounded") scope.paths[1]!.capSemantics = { kind: "unbounded", bound: null };
    expect(compile(profile).governance.diagnostics).toContainEqual(expect.objectContaining({ gate: "D30", code: failure === "unlisted" ? "monetary-policy-path-unreviewed" : "monetary-policy-path-inadmissible" }));
  });

  it("excludes a restructure-dependent dormant bypass only while its exact equity gate is unreachable", () => {
    const profile = modeledVetoProfile(), governor = profile.controls![0]!.executionScope!, minter = profile.controls![1]!.executionScope!;
    governor.paths.push({ ...governor.paths[0]!, id: "restructure", entrypoints: ["0xfeedbeef"] }); bindPath(profile, "restructure", SCOPE_CONTROLLER);
    minter.paths.push({ ...minter.paths[0]!, id: "bootstrap", activation: "disabled-reactivatable", unavoidableDelaySec: 0 }); bindPath(profile, "bootstrap");
    profile.governedIssuance!.veto!.override = "insolvency-gated-restructure";
    const threshold = 100;
    profile.governedIssuance!.veto!.restructure = { entrypoints: ["0xfeedbeef"], equityThresholdUnits: threshold,
      observedEquityUnits: threshold * V9_CANDIDATE_POLICY_V1.policy.semantic.control.governedIssuance.minorityVeto.restructureMinEquityMultiple,
      dependentPaths: [{ controlRef: PROGRAM, pathId: "bootstrap" }],
      evidence: "The exact modeled restructure selector can reactivate the dormant bootstrap only beneath the source equity threshold. The reviewed equity observation meets the required multiplicative exclusion gate." };
    expect(compile(profile).governance).toMatchObject({ coverage: "complete", minUnavoidableDelaySec: 1209600 });
    profile.governedIssuance!.veto!.restructure!.observedEquityUnits = 0;
    expect(compile(profile).governance).toMatchObject({ coverage: "incomplete", minUnavoidableDelaySec: 0 });
    expect(compile(profile).governance.diagnostics).toContainEqual(expect.objectContaining({ code: "restructure-reachable" }));
  });

  it("replaces descriptive signer rooting with every typed authority OR route", () => {
    const profile = modeledProfile();
    const scope = profile.controls![0]!.executionScope!;
    scope.pin.signerIdentity = "Safe, multisig, owners, signatures; descriptive only";
    scope.observedState.signerIdentity = "Different descriptive prose";
    expect(compile(profile).process?.coverage).toBe("complete");
    profile.authorityGraph!.edges.push({ id: "council-alternative", from: "governor", to: "holder", kind: "admin",
      pathRefs: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance" }], selectors: ["0x40c10f19"], role: "approval", activation: "active", publicDelaySec: 172800, calldataBound: true, proofRef: "closed" });
    restamp(profile);
    const failed = compile(profile);
    expect(failed.process?.diagnostics).toContainEqual(expect.objectContaining({ code: "discretionary-root-independent", controlRef: SCOPE_CONTROLLER, pathId: "issuance" }));
    expect(failed.governance.nonGovernorUnboundedPathKeys).toContain(`${SCOPE_CONTROLLER}#issuance`);
  });

  it("fails a cycle and a changed authority state instead of retaining favorable graph credit", () => {
    const profile = modeledProfile();
    profile.authorityGraph!.nodes[0]!.terminal = false;
    profile.authorityGraph!.edges.push({ id: "cycle", from: "governor", to: "governor", kind: "owner", pathRefs: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance" }], selectors: [], role: null, activation: "active", publicDelaySec: 172800, calldataBound: true, proofRef: "closed" });
    restamp(profile);
    expect(compile(profile).governance.diagnostics).toContainEqual(expect.objectContaining({ code: "graph-cycle-unclosed" }));
    const changed = modeledProfile(); changed.authorityGraph!.nodes[0]!.terminal = false;
    expect(compile(changed).governance.diagnostics).toContainEqual(expect.objectContaining({ code: "authority-state-mismatch" }));
  });

  it.each(["descriptor", "captured-code", "missing-scope"] as const)("retains per-control diagnostics when the single %s source join is missing", (failure) => {
    const profile = modeledProfile();
    if (failure === "descriptor") { profile.authorityGraph!.nodes[0]!.runtime = null; restamp(profile); }
    if (failure === "captured-code") profile.executionCertificates!.evidence.find((row) => row.id === "code-0")!.codeHash = HASH;
    if (failure === "missing-scope") delete profile.controls![0]!.executionScope;
    const { process, governance, rows } = compile(profile);
    expect(process).toMatchObject({ coverage: "incomplete", unknownMemberCount: 1 });
    expect(governance.diagnostics).toContainEqual(expect.objectContaining({ controlRef: SCOPE_CONTROLLER, memberRef: SCOPE_CONTROLLER,
      code: failure === "missing-scope" ? "execution-scope-unreviewed" : "runtime-unmatched" }));
    expect(rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it("requires reviewed runtime source correspondence beyond successful pinned code capture", () => {
    const profile = modeledProfile();
    expect(compile(profile).process?.coverage).toBe("complete");
    profile.executionCertificates!.proofs.find((proof) => proof.id === "runtime-source")!.evidenceRefIds = ["code-0", "code-1"];
    const { process, rows } = compile(profile);
    expect(process).toMatchObject({ coverage: "incomplete", unknownMemberCount: 2 });
    expect(process?.diagnostics).toContainEqual(expect.objectContaining({ code: "runtime-unmatched", controlRef: SCOPE_CONTROLLER, memberRef: SCOPE_CONTROLLER }));
    expect(rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it("does not award H to a council mislabeled as the typed token governor", () => {
    const profile = modeledProfile();
    expect(compile(profile).process?.coverage).toBe("complete");
    Object.assign(profile.controls![0]!, { authorityType: "multisig", threshold: 2, signerCount: 3, modulesOrGuardsStatus: "none-detected" });
    const { process, rows, asset } = compile(profile);
    expect(process).toMatchObject({ coverage: "incomplete", authorityCoverage: "incomplete" });
    expect(process?.diagnostics).toContainEqual(expect.objectContaining({ code: "governor-not-governance", controlRef: SCOPE_CONTROLLER }));
    expect(deriveV9MintPosture(rows[0]!, makeReviewedMintInput(rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, asset.issuanceFacts)).not.toBe("unbounded-operationally-governed");
  });

  it("does not silently omit an authorized zero-current or stopped member", () => {
    const profile = modeledProfile();
    const missing = "ethereum:0x4444444444444444444444444444444444444444";
    const census = profile.executionCertificates!.censuses[0]!;
    census.authoritativeMembers.push(missing); census.observations.push({ memberRef: missing, authorized: true, evidenceRefIds: ["source"] });
    const { process, rows } = compile(profile);
    expect(process).toMatchObject({ coverage: "incomplete", memberCount: 3, unknownMemberCount: 1 });
    expect(process?.diagnostics).toContainEqual(expect.objectContaining({ memberRef: missing, code: "runtime-unmatched" }));
    expect(rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it("derives a coupled fractional greedy repeat upper and rejects an authored understatement", () => {
    const profile = modeledProfile();
    const keeper = profile.operationalIssuance!.keeperAggregate!;
    keeper.repeatCouplingGroups = [{ id: "shared", repeatGroupIds: ["repeat-group"], sharedInFlightCapRaw: "500000", capAndSlackProofRef: "aggregate" }];
    expect(compile(profile).process?.keeperSupplyScreenBasis?.maxRepeatRewardRawPer86400Sec).toBe("132000");
    keeper.upperRepeatRewardRaw = "131999";
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "aggregate-flow-unproved" }));
  });

  it("joins typed native-denominator scales and rejects a repeated getter or favorable authored drift", () => {
    const profile = modeledProfile(), keeper = profile.operationalIssuance!.keeperAggregate!;
    keeper.denominatorTerms = [{ evidenceRefId: "native-supply", deployment: PROGRAM, function: "totalSupply()", scaleNumerator: "2", scaleDenominator: "1", unitsProofRef: "units" }];
    keeper.denominatorRaw = "200000000";
    expect(compile(profile).process).toMatchObject({ coverage: "complete", maxKeeperRepeatRewardSupplyPpmPer86400Sec: 1320 });
    keeper.denominatorRaw = "200000001";
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "aggregate-flow-unproved" }));
    keeper.denominatorRaw = "400000000";
    keeper.denominatorTerms.push({ ...keeper.denominatorTerms[0]! });
    expect(compile(profile).process?.coverage).toBe("incomplete");
  });

  it("does not reinterpret the token root's own-vote provenance as an executable key bypass", () => {
    const profile = modeledProfile();
    profile.authorityGraph!.edges.push({ id: "own-vote-origin", from: "governor", to: "holder", kind: "vote-origin",
      pathRefs: [{ controlRef: SCOPE_CONTROLLER, pathId: "issuance" }], selectors: [], role: "own-locked-votes", activation: "active", publicDelaySec: 0, calldataBound: false, proofRef: "closed" });
    restamp(profile);
    expect(compile(profile).process?.coverage).toBe("complete");
  });

  it("treats a finite governor-raised stock and external paired accounting separately from Backing", () => {
    const profile = modeledProfile();
    const path = profile.controls![1]!.executionScope!.paths[0]!;
    path.capSemantics = { kind: "bounded", bound: { amount: 1000, unit: "token-units" } }; path.claimImpairment = "bounded";
    const envelope = profile.operationalIssuance!.paths[0]!.envelope!;
    profile.operationalIssuance!.paths[0] = { kind: "bounded-stock", path: { controlRef: PROGRAM, pathId: "interest" }, invariantProofRef: "closed", economicReachProofRef: "closed", envelope };
    profile.operationalIssuance!.interestAggregate = null;
    profile.executionCertificates!.proofs.push({ id: "external-strategy", conclusion: "unknown",
      statement: "The external strategy asset report remains an unknown Backing input beyond the proved finite native stock.", evidenceRefIds: ["source"] });
    profile.authorityGraph!.nodes.push({ id: "external-strategy", deployment: HOLDER, kind: "unknown", terminal: false, authorityCensusIds: [], runtime: null, proofRef: "external-strategy" });
    profile.authorityGraph!.edges.push({ id: "external-report", from: "operational-program", to: "external-strategy", kind: "credit-origin",
      pathRefs: [{ controlRef: PROGRAM, pathId: "interest" }], selectors: [], role: "strategy-assets", activation: "active", publicDelaySec: null, calldataBound: "unknown", proofRef: "external-strategy" });
    restamp(profile);
    expect(compile(profile).process).toMatchObject({ coverage: "complete", otherClassesQualified: true });
    profile.operationalIssuance!.paths[0] = { kind: "paired-accounting", path: { controlRef: PROGRAM, pathId: "interest" }, invariantProofRef: "closed", economicReachProofRef: "closed", envelope: null, externalAccountingTrust: "strategy-reported-assets" };
    path.capSemantics = { kind: "unbounded", bound: null };
    expect(compile(profile).process).toMatchObject({ coverage: "complete", diagnostics: [expect.objectContaining({ code: "external-accounting-trust" })] });
    failProof(profile, "closed");
    expect(compile(profile).process?.coverage).toBe("incomplete");
  });

  it("expands a reusable class and rejects a mismatched member runtime", () => {
    const profile = modeledClassProfile();
    expect(compile(profile).process).toMatchObject({ coverage: "complete", matchedMemberCount: 2 });
    const member = profile.executionCertificates!.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    member.runtime.runtimeHash = HASH;
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "runtime-unmatched", classId: "program-class", memberRef: PROGRAM }));
  });

  it("rejects a member capability override instead of weakening the class source invariant", () => {
    const profile = modeledClassProfile(), member = profile.executionCertificates!.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    expect(MintAuthorityProfileSchema.safeParse(profile).success).toBe(true);
    Object.assign(member.pathBindings[0]!, { capabilities: [] });
    expect(MintAuthorityProfileSchema.safeParse(profile).success).toBe(false);
  });

  it("requires each class member's exact observed instance condition", () => {
    const profile = modeledClassProfile(), klass = profile.executionCertificates!.classes[0]!, member = profile.executionCertificates!.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    klass.requiredConditions = [{ id: "native-parent", kind: "authorization", description: "Modeled native parent authorization",
      test: { kind: "equal", value: PROGRAM }, proofRef: "closed" }];
    member.conditions = [{ conditionId: "native-parent", observedValue: PROGRAM, proofRef: "closed" }];
    expect(compile(profile).process).toMatchObject({ coverage: "complete", matchedMemberCount: 2 });
    member.conditions[0]!.observedValue = HOLDER;
    expect(compile(profile).process).toMatchObject({ coverage: "incomplete", unknownMemberCount: 1 });
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "instance-state-unmatched", classId: klass.id, memberRef: PROGRAM }));
  });

  it("retains an instance-shortened public envelope clock without inheriting the class's favorable delay", () => {
    const profile = modeledClassProfile(), member = profile.executionCertificates!.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    expect(compile(profile).process?.minEnvelopeRaisePublicDelaySec).toBe(172800);
    member.pathBindings.find((binding) => binding.templateId === "raise")!.unavoidableDelaySec = 0;
    const { process, rows, asset } = compile(profile);
    expect(process).toMatchObject({ coverage: "complete", minEnvelopeRaisePublicDelaySec: 0 });
    expect(deriveV9MintPosture(rows[0]!, makeReviewedMintInput(rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, asset.issuanceFacts)).not.toBe("unbounded-operationally-governed");
  });

  it("accepts equal-strength member runtime joins without descriptor-free graph closure", () => {
    const profile = modeledClassProfile();
    profile.authorityGraph!.nodes[1]!.runtime = null; restamp(profile);
    expect(compile(profile).process).toMatchObject({ coverage: "complete", matchedMemberCount: 2 });
    const member = profile.executionCertificates!.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    member.runtime.evidenceRefIds = ["source"];
    expect(compile(profile).process).toMatchObject({ coverage: "incomplete", unknownMemberCount: 1 });
  });

  it("rejects a changed proxy implementation instead of inheriting the original class certificate", () => {
    const profile = modeledClassProfile(), certificates = profile.executionCertificates!, member = certificates.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    const implementation = "ethereum:0x5555555555555555555555555555555555555555";
    const runtime = { ...member.runtime, proxyKind: "uups" as const, implementation, implementationRuntimeHash: HASH, matchProofRef: "proxy-runtime",
      evidenceRefIds: ["source", "implementation-source", "code-1", "implementation-code"] };
    certificates.evidence.push({ ...certificates.evidence[0]!, id: "implementation-code", deployment: implementation, codeHash: HASH },
      { ...certificates.evidence.find((row) => row.id === "source")!, id: "implementation-source", deployment: implementation,
        statement: "Modeled reviewed implementation source matches the independently captured pinned implementation runtime." });
    certificates.proofs.push({ id: "proxy-runtime", conclusion: "closed",
      statement: "Modeled proxy and implementation source correspond to their actual pinned runtime identities and implementation state.",
      evidenceRefIds: ["source", "implementation-source", "code-1", "implementation-code"] });
    member.runtime = runtime; certificates.classes[0]!.runtimeVariants = [structuredClone(runtime)];
    const { deployment, matchProofRef, evidenceRefIds, normalization, ...identityFields } = runtime;
    void deployment;
    const identity = { ...identityFields, normalization: normalization.map(({ evidenceRefIds: ignored, ...row }) => { void ignored; return row; }) };
    const id = `0x${sha256Hex(stableJsonStringifyV1(identity))}`;
    profile.authorityGraph!.runtimeIdentities!.push({ id, identity, proofRef: matchProofRef, evidenceRefIds });
    profile.authorityGraph!.nodes[1]!.runtime = { ref: id }; restamp(profile);
    expect(compile(profile).process).toMatchObject({ coverage: "complete", matchedMemberCount: 2 });
    member.runtime.implementationRuntimeHash = CODE_HASH;
    expect(compile(profile).process?.diagnostics).toContainEqual(expect.objectContaining({ code: "implementation-unmatched", classId: "program-class", memberRef: PROGRAM }));
  });

  it("does not require a funded recurrence clock for a source-proven zero-reward keeper", () => {
    const profile = modeledProfile(), entry = profile.operationalIssuance!.paths[1]!, keeper = profile.operationalIssuance!.keeperAggregate!;
    if (entry.kind !== "keeper-incentive") throw new Error("Expected keeper fixture");
    entry.fixedRewardRaw = "0"; entry.proportionalRewardPpm = 0; entry.minimumRepeatSec = null;
    keeper.repeatGroups[0]!.fixedRewardRawUpper = "0"; keeper.repeatGroups[0]!.proportionalRewardPpmUpper = 0; keeper.upperRepeatRewardRaw = "0";
    expect(compile(profile).process).toMatchObject({ coverage: "complete", keeperRecurringPathCount: 1, fundedKeeperRecurringPathCount: 0,
      minKeeperRecurringIntervalSec: null, maxKeeperRepeatRewardSupplyPpmPer86400Sec: 0 });
    failProof(profile, "activity");
    expect(compile(profile).process?.coverage).toBe("incomplete");
  });

  it.each(["runtime", "proof"] as const)("expands explicit member inheritance and applies a %s override before checking the source invariant", (failure) => {
    const profile = modeledClassProfile(), certificates = profile.executionCertificates!, klass = certificates.classes[0]!, member = certificates.members[0]!;
    if (!("memberRef" in member)) throw new Error("Expected explicit member fixture");
    const { deployment, ...runtime } = member.runtime;
    klass.memberTemplates = [{ id: "base", censusIds: member.censusIds, review: member.review,
      runtime: { ...runtime, runtimeHash: HASH }, conditions: member.conditions, extensions: member.extensions }];
    klass.pathBindingTemplates = member.pathBindings.map((binding) => ({ ...binding, targetDeployment: null, targetIsMember: true,
      affectedDeployments: [], affectedIncludesMember: true }));
    certificates.members = [{ deployment, classId: klass.id, templateRef: "base", overrides: { runtime: { runtimeHash: CODE_HASH } },
      pathBindingOverrides: [{ templateId: "interest", unavoidableDelaySec: 0 }] }];
    expect(compile(profile).process).toMatchObject({ coverage: "complete", matchedMemberCount: 2, minOperationalExerciseDelaySec: 0 });
    if (failure === "runtime") certificates.members[0] = { deployment, classId: klass.id, templateRef: "missing" };
    else failProof(profile, "closed");
    const failed = compile(profile);
    expect(failed.process?.coverage).toBe("incomplete");
    expect(failed.process?.diagnostics).toContainEqual(expect.objectContaining({ code: failure === "runtime" ? "execution-class-unmatched" : "economic-reach-unclosed", memberRef: deployment }));
    expect(failed.rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it.each(["missing", "mismatch", "stale"] as const)("resolves the same-snapshot shared book, then fails the single %s reference gate", (failure) => {
    const { sourceProfile, profile, sharedBookRef, sourceMeta, targetFields } = modeledSharedProfiles();
    expect(MintAuthorityProfileSchema.safeParse(profile).success).toBe(true);
    expect(compile(profile, "alpha", [sourceMeta], targetFields).process).toMatchObject({ coverage: "complete", memberCount: 2 });
    if (failure === "mismatch") sharedBookRef.authorityStateHash = HASH;
    if (failure === "stale") sourceProfile.review.reviewedAt = "2020-01-01";
    const failed = compile(profile, "alpha", failure === "missing" ? [] : [sourceMeta], targetFields);
    expect(failed.rows.every((row) => row.executionScopeComplete === false)).toBe(true);
    expect(failed.asset.issuanceFacts?.diagnostics).toContainEqual(expect.objectContaining({ code: failure === "missing" ? "shared-book-unresolved" : failure === "mismatch" ? "shared-book-mismatch" : "shared-book-stale" }));
    expect(failed.rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it.each(["source-registry", "target-registry", "missing-selection", "foreign-selection", "non-native"] as const)("rebinds shared native selection before merging and fails the single %s mapping gate", (failure) => {
    const { sourceProfile, profile, sourceMeta, targetFields, sourceDeployment, targetDeployment } = modeledSharedProfiles();
    const snapshot = metaMap(sourceMeta, alphaMeta({ ...targetFields, mintAuthority: profile }));
    const resolved = resolveV1005MintAuthorityProfile(profile, "alpha", snapshot, CLOCK, 90 * 86400);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.profile.controls).toHaveLength(sourceProfile.controls!.length);
    expect(resolved.profile.controls!.every((control) => control.deploymentRefs?.length === 1 && control.deploymentRefs[0] === targetDeployment)).toBe(true);
    expect(sourceProfile.controls!.every((control) => control.deploymentRefs?.[0] === sourceDeployment)).toBe(true);
    expect(resolved.profile.authorityGraph).toBe(sourceProfile.authorityGraph);
    expect(resolved.profile.controls![0]!.executionScope).toEqual(sourceProfile.controls![0]!.executionScope);
    expect(compile(profile, "alpha", [sourceMeta], targetFields).process?.coverage).toBe("complete");
    if (failure === "source-registry") sourceMeta.contracts = [];
    if (failure === "target-registry") targetFields.contracts = [];
    if (failure === "missing-selection") delete profile.controls![0]!.deploymentRefs;
    if (failure === "foreign-selection") profile.controls![0]!.deploymentRefs = [sourceDeployment];
    if (failure === "non-native") Object.assign(targetFields.bridgeRouteRisk!.routes![0]!, {
      routeClass: "canonical", issuanceModel: "bridge-representation", semantics: "lock-mint", scope: "peripheral", riskTier: "canonical-rollup-bridge",
    });
    const denied = resolveV1005MintAuthorityProfile(profile, "alpha",
      metaMap(sourceMeta, alphaMeta({ ...targetFields, mintAuthority: profile })), CLOCK, 90 * 86400);
    expect(denied.diagnostics).toContainEqual(expect.objectContaining({ code: "shared-book-unresolved", field: "executionCertificates.sharedBookRef.deploymentRefs" }));
    if (failure === "foreign-selection" || failure === "non-native") {
      const fixed = makeV9FixedInput({ clockSec: CLOCK });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(sourceMeta, alphaMeta({ ...targetFields, mintAuthority: profile })) });
      expect(extension.assets[0]!.admissionQuarantine).toMatchObject({ code: "fact-build-failed", path: "registry.mintBridgeOwnership" });
      const facts = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
      expect(facts.assets[0]!.controls).toEqual([]);
      expect(facts.assets[0]!.issuanceFacts).toBeUndefined();
      return;
    }
    const failed = compile(profile, "alpha", [sourceMeta], targetFields);
    expect(failed.rows.every((row) => row.executionScopeComplete === false)).toBe(true);
    expect(failed.asset.issuanceFacts?.diagnostics).toContainEqual(expect.objectContaining({ code: "shared-book-unresolved", field: "executionCertificates.sharedBookRef.deploymentRefs" }));
    expect(failed.rows.some((row) => row.claimImpairment === "unbounded")).toBe(true);
  });

  it("keeps H evidence coverage policy neutral above a calibrated numerical screen", () => {
    const profile = modeledProfile();
    const formula = profile.operationalIssuance!.paths[0]!;
    if (formula.kind !== "formula-interest") throw new Error("Expected formula fixture");
    formula.rate.operationalAnnualRatePpmUpper = 500001;
    profile.operationalIssuance!.interestAggregate!.annualGrowthPpmUpper = 500001;
    const { process, rows, asset } = compile(profile);
    expect(process?.coverage).toBe("complete");
    const control = rows.find((row) => row.capabilities.includes("mint"))!;
    expect(deriveV9MintPosture(control, makeReviewedMintInput(control.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, asset.issuanceFacts)).not.toBe("unbounded-operationally-governed");
  });

  it("requires affirmative native evidence for either an H block or annotation", () => {
    const positive = modeledProfile();
    expect(MintAuthorityProfileSchema.safeParse(positive).success).toBe(true);
    for (const field of ["governedIssuance", "operationalIssuance", "executionCertificates", "authorityGraph"] as const) {
      const failed = structuredClone(positive); delete failed[field];
      expect(MintAuthorityProfileSchema.safeParse(failed).success).toBe(false);
    }
    expect(MintAuthorityProfileSchema.safeParse({ ...positive, economicCapSemantics: "bounded" }).success).toBe(false);
    expect(MintAuthorityProfileSchema.safeParse({ ...positive, mintPath: "wrapped-or-variant-inherited", inheritedFrom: "parent" }).success).toBe(false);
    expect(MintAuthorityProfileSchema.safeParse({ ...positive, governedIssuance: { ...positive.governedIssuance!, decisionRule: "minority-veto", veto: { quorumBps: 200, entrypoints: ["0x12345678"], override: "none", evidence: "A minority window is a veto and not affirmative operational token governance. It does not certify rule H." } } }).success).toBe(false);
  });

  it("keeps GHO's chosen-recipient Council mint at 25 with no operational grant", () => {
    const profile = MintAuthorityProfileSchema.parse(ghoSidecar.mintAuthority);
    const { asset, process } = compile(profile, "gho-aave", [], ACTIVE_META_BY_ID.get("gho-aave")!);
    expect(process).toBeUndefined();
    const result = evaluateV9EconomicControl(makeEconomicControlArgs({ facts: asset, mint: asset.economicControlReview.mint }));
    expect(result.components.filter((component) => component.kind === "mint").map((component) => ({ score: component.score }))).toEqual(expect.arrayContaining([expect.objectContaining({ score: 25 })]));
  });

  it("uses one full authoritative Vat book for DAI and USDS without duplicate conversion claims", () => {
    const dai = MintAuthorityProfileSchema.parse(daiSidecar.mintAuthority);
    const authoredUsds = MintAuthorityProfileSchema.parse(usdsSidecar.mintAuthority);
    const snapshot = metaMap({ ...ACTIVE_META_BY_ID.get("dai-makerdao")!, mintAuthority: dai },
      { ...ACTIVE_META_BY_ID.get("usds-sky")!, mintAuthority: authoredUsds });
    const resolved = resolveV1005MintAuthorityProfile(authoredUsds, "usds-sky", snapshot, CLOCK, 90 * 86400);
    expect(resolved.diagnostics).toEqual([]);
    const usds = resolved.profile;
    expect(usds.controls!.every((control) => control.deploymentRefs?.length === 1 && control.deploymentRefs[0] === "ethereum:0xdc035d45d973e3ec169d2276ddab16f1e407384f")).toBe(true);
    expect(dai.controls!.every((control) => control.deploymentRefs?.length === 1 && control.deploymentRefs[0] === "ethereum:0x6b175474e89094c44da98b954eedeac495271d0f")).toBe(true);
    const vat = "ethereum:0x35d1b3f3d7966a1dfe207aa4514c12a259a0492b";
    const members = (profile: MintAuthorityProfile) => [...new Set(profile.executionCertificates!.censuses.filter((census) => census.kind === "ward" && census.targetDeployment === vat).flatMap((census) => census.authoritativeMembers))].sort();
    expect(members(dai)).toHaveLength(129); expect(members(usds)).toEqual(members(dai));
    const projections = compileReviewedMintControlScopes(dai, "dai-makerdao", CLOCK, 90 * 86400);
    expect(projections).toHaveLength(dai.controls!.length);
    expect(dai.executionCertificates!.liabilityBookId).toBe(usds.executionCertificates!.liabilityBookId);
  });
});

describe("governance public-clock and replacement-approval admission", () => {
  function governanceProfile(family: "D29" | "D30" | "H"): MintAuthorityProfile {
    if (family === "D30") return modeledVetoProfile();
    const profile = modeledProfile();
    if (family === "D29") {
      delete profile.operationalIssuance; profile.authorityPosture = "unbounded-governed";
      profile.controls![1]!.executionScope!.paths.forEach((path) => { path.unavoidableDelaySec = 172800; });
      profile.authorityGraph!.pathBindings.forEach((binding) => { binding.authorityNodeIds = ["governor"]; });
      restamp(profile);
    }
    return profile;
  }

  function posture(asset: V9AssetFactsV3) {
    const control = asset.controls.find((row) => row.capSemantics.kind === "unbounded" && row.capabilities.includes("mint"))!;
    return deriveV9MintPosture(control, makeReviewedMintInput(control.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, asset.issuanceFacts);
  }

  describe.each(["D29", "D30"] as const)("%s public-clock admission", (family) => {
    it.each(["zero", "short", "null", "calldata-unbound", "calldata-unknown"] as const)("denies the single %s clock gate on the fastest authority alternative", (failure) => {
      const profile = governanceProfile(family), graph = profile.authorityGraph!;
      const delay = family === "D29" ? 172800 : 1209600;
      const ref = { controlRef: family === "D29" ? SCOPE_CONTROLLER : PROGRAM, pathId: "issuance" };
      graph.nodes.push({ ...graph.nodes[1]!, id: "public-clock-route", kind: "timelock", terminal: false });
      graph.pathBindings.find((binding) => binding.path.controlRef === ref.controlRef && binding.path.pathId === ref.pathId)!.authorityNodeIds = ["public-clock-route"];
      for (const id of ["slow-public-route", "fast-public-route"]) {
        graph.edges.push({ id, from: "public-clock-route", to: "governor", kind: "admin", pathRefs: [ref],
          selectors: [], role: "governor-execution", activation: "active", publicDelaySec: delay, calldataBound: true, proofRef: "closed" });
      }
      restamp(profile);
      const positive = compile(profile);
      expect(positive.governance).toMatchObject({ coverage: "complete", minUnavoidableDelaySec: delay, nonGovernorUnboundedPathKeys: [],
        votingControl: { qualified: true } });
      expect(posture(positive.asset)).toBe(family === "D29" ? "unbounded-governed" : "unbounded-veto-guarded");

      const fast = graph.edges.find((edge) => edge.id === "fast-public-route")!;
      if (failure === "zero") fast.publicDelaySec = 0;
      if (failure === "short") fast.publicDelaySec = delay - 1;
      if (failure === "null") fast.publicDelaySec = null;
      if (failure === "calldata-unbound") fast.calldataBound = false;
      if (failure === "calldata-unknown") fast.calldataBound = "unknown";
      restamp(profile);
      const denied = compile(profile);
      const authoredPath = profile.controls!.find((control) => `ethereum:${control.address}` === ref.controlRef)!.executionScope!.paths.find((path) => path.id === ref.pathId)!;
      expect(authoredPath.unavoidableDelaySec).toBe(delay);
      expect(denied.governance).toMatchObject({ coverage: "complete", nonGovernorUnboundedPathKeys: [], votingControl: { qualified: true },
        minUnavoidableDelaySec: failure === "zero" ? 0 : failure === "short" ? delay - 1 : null });
      expect(posture(denied.asset)).toBe("unbounded-adverse");
    });
  });

  it.each(["D29", "D30", "H"] as const)("requires known program approval for actual other-holder authority even when own stake passes %s", (family) => {
    const profile = governanceProfile(family), voting = profile.governedIssuance!.votingControl;
    const controller = voting.controllers[0]!;
    controller.voteAuthorityNodeIds = ["operational-program"];
    controller.voteReplacementApproval = "onchain-token-holder-approval";
    voting.routes[0]!.controllerPowers = [{ controllerId: "dominant-own-holder", ownHolderRowIds: [], otherHolderRowIds: ["small-position"],
      unknownProvenanceHolderRowIds: [], unilateralThresholdRaw: "50", thresholdComparator: "gt", thresholdProofRef: "closed" }];
    const positive = compile(profile);
    expect(positive.governance.votingControl).toMatchObject({ qualified: true, largestSingleControllerShareBps: 10000,
      unknownAboveThresholdVoteOwnershipControllerIds: [], otherHolderVoteOperatorControllerIds: [],
      censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
    expect(posture(positive.asset)).toBe(family === "D29" ? "unbounded-governed" : family === "D30" ? "unbounded-veto-guarded" : "unbounded-operationally-governed");
    if (family === "H") expect(positive.process?.minOperationalExerciseDelaySec).toBe(0);

    controller.voteReplacementApproval = "unknown";
    const denied = compile(profile);
    expect(denied.governance.votingControl).toMatchObject({ qualified: false, largestSingleControllerShareBps: 10000,
      unknownAboveThresholdVoteOwnershipControllerIds: ["dominant-own-holder"], otherHolderVoteOperatorControllerIds: [],
      censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
    expect(denied.governance.diagnostics).toContainEqual(expect.objectContaining({ code: "voting-control-unproved", gate: "D32",
      field: "controllers.dominant-own-holder.voteReplacementApproval" }));
    expect(posture(denied.asset)).toBe("unbounded-adverse");
    if (family === "H") expect(denied.process?.coverage).toBe("incomplete");
  });

  it("does not demand other-holder approval from a controller voting only its own proved stake", () => {
    const profile = governanceProfile("D29");
    profile.governedIssuance!.votingControl.controllers[0]!.voteReplacementApproval = "unknown";
    const compiled = compile(profile);
    expect(compiled.governance.votingControl).toMatchObject({ qualified: true, unknownAboveThresholdVoteOwnershipControllerIds: [] });
    expect(posture(compiled.asset)).toBe("unbounded-governed");
  });
});

describe("authority clock, cycle, and compact runtime admission", () => {
  const authority = (profile: MintAuthorityProfile, pathId: string) => compileReviewedMintControlScopes(
    profile, "alpha", CLOCK, 90 * 86400,
  )[0]!.authorityPaths!.get(`${PROGRAM}#${pathId}`);

  it.each([
    [0, "null-delay"], [172800, "null-delay"],
    [0, "unbound-calldata"], [172800, "unbound-calldata"],
  ] as const)("keeps an unknown inner clock unknown beneath a %s-second outer edge (%s)", (outerDelay, failure) => {
    const profile = modeledProfile(), graph = profile.authorityGraph!;
    graph.nodes.push({ ...graph.nodes[1]!, id: "outer-authority", kind: "contract", terminal: false },
      { ...graph.nodes[1]!, id: "inner-authority", kind: "contract", terminal: false });
    graph.pathBindings.find((binding) => binding.path.controlRef === PROGRAM && binding.path.pathId === "raise")!.authorityNodeIds = ["outer-authority"];
    graph.edges.push({ id: "outer-clock", from: "outer-authority", to: "inner-authority", kind: "execution-hop",
      pathRefs: [{ controlRef: PROGRAM, pathId: "raise" }], selectors: [], role: null, activation: "active",
      publicDelaySec: outerDelay, calldataBound: true, proofRef: "closed" },
    { id: "inner-clock", from: "inner-authority", to: "governor", kind: "execution-hop",
      pathRefs: [{ controlRef: PROGRAM, pathId: "raise" }], selectors: [], role: null, activation: "active",
      publicDelaySec: 172800, calldataBound: true, proofRef: "closed" });
    restamp(profile);
    expect(authority(profile, "raise")).toMatchObject({ closed: true, governorRooted: true, publicDelaySec: 172800 });
    const positive = compile(profile);
    expect(positive.process?.coverage).toBe("complete");
    expect(deriveV9MintPosture(positive.rows[0]!, makeReviewedMintInput(positive.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, positive.asset.issuanceFacts)).toBe("unbounded-operationally-governed");
    const inner = graph.edges.find((edge) => edge.id === "inner-clock")!;
    if (failure === "null-delay") inner.publicDelaySec = null;
    else inner.calldataBound = false;
    restamp(profile);
    expect(authority(profile, "raise")).toMatchObject({ closed: true, governorRooted: true, publicDelaySec: null });
    const denied = compile(profile);
    expect(denied.process).toMatchObject({ coverage: "incomplete", minDiscretionaryPublicDelaySec: null });
    expect(denied.process?.diagnostics).toContainEqual(expect.objectContaining({ code: "delay-unproved", gate: "H1", controlRef: PROGRAM, pathId: "raise" }));
    expect(deriveV9MintPosture(denied.rows[0]!, makeReviewedMintInput(denied.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, denied.asset.issuanceFacts)).toBe("unbounded-adverse");
  });

  it.each(["self-loop", "two-node-cycle"] as const)("denies a terminal fixed-program %s without a certified governor component", (cycle) => {
    const profile = modeledProfile(), graph = profile.authorityGraph!;
    const edge = { kind: "owner" as const, pathRefs: [{ controlRef: PROGRAM, pathId: "interest" }],
      selectors: [], role: null, activation: "active" as const, publicDelaySec: 0, calldataBound: true, proofRef: "closed" };
    if (cycle === "two-node-cycle") {
      graph.nodes.push({ ...graph.nodes[1]!, id: "fixed-leaf" });
      graph.edges.push({ ...edge, id: "program-leaf", from: "operational-program", to: "fixed-leaf" });
    }
    restamp(profile);
    expect(authority(profile, "interest")).toMatchObject({ closed: true, governorRooted: false, publicDelaySec: 0 });
    const positive = compile(profile);
    expect(positive.process?.coverage).toBe("complete");
    expect(deriveV9MintPosture(positive.rows[0]!, makeReviewedMintInput(positive.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, positive.asset.issuanceFacts)).toBe("unbounded-operationally-governed");
    graph.edges.push({ ...edge, id: "fixed-back-edge", from: cycle === "self-loop" ? "operational-program" : "fixed-leaf", to: "operational-program" });
    restamp(profile);
    expect(authority(profile, "interest")?.closed).toBe(false);
    const denied = compile(profile);
    expect(denied.process?.coverage).toBe("incomplete");
    expect(denied.process?.diagnostics).toContainEqual(expect.objectContaining({
      code: "graph-cycle-unclosed", controlRef: PROGRAM, pathId: "interest", field: "authorityGraph.nodes.operational-program",
    }));
    expect(deriveV9MintPosture(denied.rows[0]!, makeReviewedMintInput(denied.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, denied.asset.issuanceFacts)).toBe("unbounded-adverse");
  });

  it("requires a compact clone's observed hash to match its variant even when the original exemplar is unchanged", () => {
    const clone = "ethereum:0x4444444444444444444444444444444444444444";
    const profile = modeledClassProfile(), certificates = profile.executionCertificates!, klass = certificates.classes[0]!;
    profile.controls![1]!.executionScope = modeledProfile().controls![1]!.executionScope;
    delete profile.controls![1]!.executionClassRef; certificates.members = [];
    profile.controls![1]!.executionScope!.paths[0]!.affectedDeployments.push(clone);
    klass.memberRefs = [clone];
    klass.sourcePathRefs = [{ controlRef: PROGRAM, pathId: "interest" }];
    klass.requiredConditions = [{ id: "original", kind: "immutable", field: "immutables.original", description: "The clone binds the reviewed source exemplar.",
      test: { kind: "equal", value: PROGRAM }, proofRef: "closed" }];
    klass.compactMembers = [{ deployment: clone, codeHash: CODE_HASH, codeSize: 100,
      immutables: { original: PROGRAM }, state: {}, evidenceRefIds: ["clone-code"] }];
    const codeRead = { ...certificates.evidence.find((row) => row.id === "code-1")!, id: "clone-code", deployment: clone };
    certificates.evidence.push(codeRead);
    certificates.censuses[0]!.authoritativeMembers.push(clone);
    certificates.censuses[0]!.observations.push({ memberRef: clone, authorized: true, evidenceRefIds: ["clone-code"] });
    const positive = compile(profile);
    expect(positive.process?.diagnostics).toEqual([]);
    expect(deriveV9MintPosture(positive.rows[0]!, makeReviewedMintInput(positive.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, positive.asset.issuanceFacts)).toBe("unbounded-operationally-governed");
    klass.compactMembers[0]!.codeHash = HASH; codeRead.codeHash = HASH;
    expect(klass.compactMembers[0]!.immutables.original).toBe(klass.runtimeVariants[0]!.deployment);
    const denied = compile(profile);
    expect(denied.process?.coverage).toBe("incomplete");
    expect(denied.process?.diagnostics).toContainEqual(expect.objectContaining({
      code: "runtime-unmatched", field: "compactMembers.codeHash", controlRef: PROGRAM, pathId: "interest", memberRef: clone,
    }));
    expect(deriveV9MintPosture(denied.rows[0]!, makeReviewedMintInput(denied.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, denied.asset.issuanceFacts)).toBe("unbounded-adverse");
  });

  it.each(["wrong-clone-hash", "unreviewed-implementation", "wrong-implementation", "unproved-clone-template"] as const)("admits an exact reviewed EIP-1167 clone but denies the single %s gate", (failure) => {
    const clone = "ethereum:0x4444444444444444444444444444444444444444";
    const profile = modeledClassProfile(), certificates = profile.executionCertificates!, klass = certificates.classes[0]!;
    profile.controls![1]!.executionScope = modeledProfile().controls![1]!.executionScope;
    delete profile.controls![1]!.executionClassRef; certificates.members = [];
    profile.controls![1]!.executionScope!.paths[0]!.affectedDeployments.push(clone);
    klass.memberRefs = [clone];
    klass.sourcePathRefs = [{ controlRef: PROGRAM, pathId: "interest" }];
    klass.requiredConditions = [{ id: "original", kind: "immutable", field: "immutables.original", description: "The clone binds the reviewed source exemplar.",
      test: { kind: "one-of", values: [PROGRAM, HOLDER] }, proofRef: "closed" }];
    certificates.proofs.push({ id: "clone-template", conclusion: "closed",
      statement: "The exact observed clone runtime delegates only to the named reviewed original implementation.", evidenceRefIds: ["source"] },
    { id: "implementation-source", conclusion: "closed",
      statement: "The original implementation's exact observed executable bytes correspond to the reviewed class source.", evidenceRefIds: ["source"] });
    klass.runtimeVariants[0]!.matchProofRef = "implementation-source";
    klass.cloneRuntimeVariants = [{ runtimeHash: HASH, proxyKind: "eip1167", implementationIdentityRef: PROGRAM, matchProofRef: "clone-template" }];
    klass.compactMembers = [{ deployment: clone, codeHash: HASH, codeSize: 45,
      immutables: { original: PROGRAM }, state: {}, evidenceRefIds: ["clone-code"] }];
    const codeRead = { ...certificates.evidence.find((row) => row.id === "code-1")!, id: "clone-code", deployment: clone, codeHash: HASH, codeSize: 45 };
    certificates.evidence.push(codeRead);
    certificates.censuses[0]!.authoritativeMembers.push(clone);
    certificates.censuses[0]!.observations.push({ memberRef: clone, authorized: true, evidenceRefIds: ["clone-code"] });
    expect(MintAuthorityProfileSchema.safeParse(profile).success).toBe(true);
    const positive = compile(profile);
    expect(positive.process?.diagnostics).toEqual([]);
    expect(deriveV9MintPosture(positive.rows[0]!, makeReviewedMintInput(positive.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, positive.asset.issuanceFacts)).toBe("unbounded-operationally-governed");
    if (failure === "wrong-clone-hash") {
      const wrongHash: `0x${string}` = `0x${"ef".repeat(32)}`;
      klass.compactMembers[0]!.codeHash = wrongHash;
      codeRead.codeHash = wrongHash;
    } else if (failure === "unreviewed-implementation") failProof(profile, "implementation-source");
    else if (failure === "wrong-implementation") klass.compactMembers[0]!.immutables.original = HOLDER;
    else failProof(profile, "clone-template");
    const denied = compile(profile);
    expect(denied.process?.coverage).toBe("incomplete");
    expect(denied.process?.diagnostics).toContainEqual(expect.objectContaining({
      code: failure === "unreviewed-implementation" ? "implementation-unmatched" : "runtime-unmatched",
      field: failure === "unreviewed-implementation" ? "compactMembers.implementation" : "compactMembers.codeHash",
      controlRef: PROGRAM, pathId: "interest", memberRef: clone,
    }));
    expect(deriveV9MintPosture(denied.rows[0]!, makeReviewedMintInput(denied.rows[0]!.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, denied.asset.issuanceFacts)).toBe("unbounded-adverse");
  });
});

describe("D32 vote-caster and replacement authority traversal", () => {
  const controlKinds = ["owner", "ward", "role", "admin", "upgrade", "delegatecall", "execution-hop", "permission-change",
    "envelope-raise", "operator", "delegate", "vote-cast", "vote-replacement", "vote-origin", "reactivation"] as const;

  function votingProfile(family: "D29" | "D30" | "H"): MintAuthorityProfile {
    const profile = family === "D30" ? modeledVetoProfile() : modeledProfile();
    if (family === "D29") {
      delete profile.operationalIssuance; profile.authorityPosture = "unbounded-governed";
      profile.controls![1]!.executionScope!.paths.forEach((path) => { path.unavoidableDelaySec = 172800; });
      profile.authorityGraph!.pathBindings.forEach((binding) => { binding.authorityNodeIds = ["governor"]; });
    }
    const voting = profile.governedIssuance!.votingControl;
    profile.authorityGraph!.nodes.push({ ...profile.authorityGraph!.nodes[1]!, id: "vote-program" });
    voting.controllers[0]!.voteAuthorityNodeIds = ["vote-program"];
    voting.controllers[0]!.voteReplacementApproval = "onchain-token-holder-approval";
    voting.routes[0]!.controllerPowers = [{ controllerId: "dominant-own-holder", ownHolderRowIds: ["own-position"],
      otherHolderRowIds: ["small-position"], unknownProvenanceHolderRowIds: [],
      unilateralThresholdRaw: "50", thresholdComparator: "gt", thresholdProofRef: "closed" }];
    restamp(profile);
    return profile;
  }

  function posture(asset: V9AssetFactsV3) {
    const control = asset.controls.find((row) => row.capSemantics.kind === "unbounded" && row.capabilities.includes("mint"))!;
    return deriveV9MintPosture(control, makeReviewedMintInput(control.controlKey), false, V9_CANDIDATE_POLICY_V1.policy.semantic, asset.issuanceFacts);
  }

  describe.each(["D29", "D30", "H"] as const)("%s other-holder authority", (family) => {
    const qualifiedPosture = family === "D29" ? "unbounded-governed" : family === "D30" ? "unbounded-veto-guarded" : "unbounded-operationally-governed";

    it.each(controlKinds)("denies the single active %s control edge even when own stake alone passes", (kind) => {
      const profile = votingProfile(family), graph = profile.authorityGraph!, voting = profile.governedIssuance!.votingControl;
      const edge: V1005AuthorityGraph["edges"][number] = { id: "vote-program-key", from: "vote-program", to: "holder", kind,
        pathRefs: [voting.routes[0]!.path], selectors: [], role: "vote-program-admin", activation: "disabled-final",
        publicDelaySec: 0, calldataBound: true, proofRef: "closed" };
      graph.edges.push(edge); restamp(profile);
      const positive = compile(profile);
      expect(positive.governance.votingControl).toMatchObject({ qualified: true, largestSingleControllerShareBps: 10000,
        unknownAboveThresholdVoteOwnershipControllerIds: [], otherHolderVoteOperatorControllerIds: [], diagnostics: [],
        censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
      expect(posture(positive.asset)).toBe(qualifiedPosture);
      if (family === "H") expect(positive.process?.coverage).toBe("complete");

      edge.activation = "active"; restamp(profile);
      const denied = compile(profile);
      expect(denied.governance.votingControl).toMatchObject({ qualified: false, largestSingleControllerShareBps: 10000,
        unknownAboveThresholdVoteOwnershipControllerIds: [], otherHolderVoteOperatorControllerIds: ["dominant-own-holder"],
        censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
      expect(denied.governance.votingControl!.diagnostics).toEqual([expect.objectContaining({ code: "voting-other-holder-operator",
        gate: "D32", field: "controllers.dominant-own-holder.otherHoldersPowerRaw" })]);
      expect(posture(denied.asset)).toBe("unbounded-adverse");
      if (family === "H") expect(denied.process?.coverage).toBe("incomplete");
    });

    it.each(["unknown-terminal", "unknown-nonterminal", "unclosed-nonterminal"] as const)("denies the single %s vote-authority leaf gate", (failure) => {
      const profile = votingProfile(family), node = profile.authorityGraph!.nodes.find((row) => row.id === "vote-program")!;
      const positive = compile(profile);
      expect(positive.governance.votingControl).toMatchObject({ qualified: true, diagnostics: [] });
      expect(posture(positive.asset)).toBe(qualifiedPosture);

      if (failure !== "unclosed-nonterminal") node.kind = "unknown";
      if (failure !== "unknown-terminal") node.terminal = false;
      restamp(profile);
      const denied = compile(profile);
      expect(denied.governance.votingControl).toMatchObject({ qualified: false, largestSingleControllerShareBps: 10000,
        unknownAboveThresholdVoteOwnershipControllerIds: ["dominant-own-holder"], otherHolderVoteOperatorControllerIds: [],
        censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
      expect(denied.governance.votingControl!.diagnostics).toEqual([expect.objectContaining({ code: "voting-control-unproved",
        gate: "D32", field: "controllers.dominant-own-holder.voteAuthority" })]);
      expect(posture(denied.asset)).toBe("unbounded-adverse");
      if (family === "H") expect(denied.process?.coverage).toBe("incomplete");
    });

    it("follows replacement control through intermediate nonterminal contracts", () => {
      const profile = votingProfile(family), graph = profile.authorityGraph!, path = profile.governedIssuance!.votingControl.routes[0]!.path;
      graph.nodes.push({ ...graph.nodes[1]!, id: "vote-replacer", kind: "contract", terminal: false },
        { ...graph.nodes[1]!, id: "vote-admin", kind: "contract", terminal: false });
      graph.edges.push({ id: "caster-replacement", from: "vote-program", to: "vote-replacer", kind: "vote-replacement",
        pathRefs: [path], selectors: [], role: null, activation: "active", publicDelaySec: 0, calldataBound: true, proofRef: "closed" },
      { id: "replacement-hop", from: "vote-replacer", to: "vote-admin", kind: "execution-hop",
        pathRefs: [path], selectors: [], role: null, activation: "active", publicDelaySec: 0, calldataBound: true, proofRef: "closed" },
      { id: "replacement-role", from: "vote-admin", to: "holder", kind: "role",
        pathRefs: [path], selectors: [], role: "replacement-admin", activation: "active", publicDelaySec: 0, calldataBound: true, proofRef: "closed" });
      restamp(profile);
      const denied = compile(profile);
      expect(denied.governance.votingControl).toMatchObject({ qualified: false, unknownAboveThresholdVoteOwnershipControllerIds: [],
        otherHolderVoteOperatorControllerIds: ["dominant-own-holder"] });
      expect(denied.governance.votingControl!.diagnostics).toEqual([expect.objectContaining({ code: "voting-other-holder-operator", gate: "D32" })]);
      expect(posture(denied.asset)).toBe("unbounded-adverse");
    });

    it("retains a qualifying key-controlled controller voting only its own proved stake", () => {
      const profile = votingProfile(family), graph = profile.authorityGraph!, voting = profile.governedIssuance!.votingControl;
      voting.routes[0]!.controllerPowers = [];
      voting.controllers[0]!.voteReplacementApproval = "unknown";
      graph.edges.push({ id: "own-vote-role", from: "vote-program", to: "holder", kind: "role",
        pathRefs: [voting.routes[0]!.path], selectors: [], role: "own-vote-admin", activation: "active",
        publicDelaySec: 0, calldataBound: true, proofRef: "closed" });
      restamp(profile);
      const positive = compile(profile);
      expect(positive.governance.votingControl).toMatchObject({ qualified: true, largestSingleControllerShareBps: 6000,
        unknownAboveThresholdVoteOwnershipControllerIds: [], otherHolderVoteOperatorControllerIds: [], diagnostics: [],
        censusReconciliations: [{ state: "reconciled", accountedPowerRaw: "100" }] });
      expect(posture(positive.asset)).toBe(qualifiedPosture);
      if (family === "H") expect(positive.process?.coverage).toBe("complete");
    });
  });
});
