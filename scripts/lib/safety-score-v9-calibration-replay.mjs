import { readFileSync } from "node:fs";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";
import { deriveReportCardsBaseInputGenerationId } from "../../shared/lib/report-cards-base-input-identity.ts";
import { computeV9FactSetDigest } from "../../shared/lib/safety-score-v9/facts.ts";
import { domainDigest } from "../../shared/lib/safety-score-v9/primitives.ts";
import { computeV9ResultDigest, projectCompactV9ScoreTrace } from "../../shared/lib/safety-score-v9/trace.ts";
import { sha256Hex as sha256 } from "../../shared/lib/sha256.ts";
import { buildSafetyScoreV9ReplayArtifact } from "../../worker/scripts/replay-safety-score-v9.ts";
import {
  compareText,
  requireExactKeys,
  requireRecord,
  stableStringify,
  uniqueAssetIds,
} from "./safety-score-v9-calibration-core.mjs";
const trustedReplayCache = new Map();
export const CALIBRATION_BASELINE = JSON.parse(
  readFileSync(new URL("../__tests__/fixtures/safety-score-v9-calibration-baseline.json", import.meta.url), "utf8"),
);
const EXPECTED_BASELINE_BINDINGS = CALIBRATION_BASELINE.bindings;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}
function requireCanonicalStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a string array`);
  }
  const canonical = [...new Set(value)].sort(compareText);
  if (stableStringify(value) !== stableStringify(canonical)) {
    throw new Error(`${label} must be unique and sorted`);
  }
  return value;
}
function requireNonnegativeInteger(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}
function assertCandidateIdentity(value, label) {
  const identity = requireExactKeys(
    value,
    [
      "schemaVersion",
      "policyId",
      "policyDigest",
      "evaluationBuildDigest",
      "compilerFactSchemaDigest",
      "producerCapabilityDigest",
    ],
    `${label} candidate identity`,
  );
  if (identity.schemaVersion !== 1 || typeof identity.policyId !== "string" || identity.policyId.length === 0) {
    throw new Error(`${label} candidate identity has invalid schema or policy ID`);
  }
  for (const key of ["policyDigest", "evaluationBuildDigest", "compilerFactSchemaDigest", "producerCapabilityDigest"]) {
    requireDigest(identity[key], `${label} candidate identity ${key}`);
  }
  return identity;
}
const COMPILER_PROFILES = [
  {
    name: "historical",
    matches: (identity) =>
      identity.evaluationBuildDigest === EXPECTED_BASELINE_BINDINGS.candidateIdentity.evaluationBuildDigest,
    capabilities: ["canonical-chain-supply-distribution.v1"],
    fixedInputSchemaVersion: 3,
    compiledFactSchemaVersion: 2,
    compilerAdapter: "exact-fixed-input-to-v9-facts.v1",
    routeAdapterVersion: "v1",
    chainSupplyAdapter: "fixed-input.usd-circulating-supply.v2",
    researchOverlaysAdapter: "v9-fact-extension.review-overlays.v2",
    includesReviewedTransfers: false,
    includesShockCoverage: false,
  },
  {
    name: "current",
    matches: (identity, capabilities) =>
      identity.evaluationBuildDigest === SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST &&
      stableStringify(identity.compiledFactSchemaCapabilities) === stableStringify(capabilities),
    capabilities: [
      "canonical-chain-supply-distribution.v1",
      "canonical-lock-mint-supply-attribution.v1",
      "exit-route-modeled-confidence.v1",
      "fact-gap-responsibility.v1",
      "journaled-cdp-shock-coverage.v1",
      "reviewed-deployment-unit-supply-attribution.v1",
      "reviewed-transfer-deployments.v1",
      "wrapper-local-facts.v1",
    ],
    fixedInputSchemaVersion: [3, 4],
    compiledFactSchemaVersion: 3,
    compilerAdapter: "exact-fixed-input-to-v9-facts.v2",
    routeAdapterVersion: "v2",
    chainSupplyAdapter: "fixed-input.usd-circulating-supply.v4",
    researchOverlaysAdapter: "v9-fact-extension.review-overlays.v3",
    includesReviewedTransfers: true,
    includesShockCoverage: true,
  },
  {
    name: "shock-coverage",
    matches: (identity, capabilities) =>
      stableStringify(identity.compiledFactSchemaCapabilities) === stableStringify(capabilities),
    capabilities: [
      "canonical-chain-supply-distribution.v1",
      "exit-route-modeled-confidence.v1",
      "journaled-cdp-shock-coverage.v1",
      "reviewed-transfer-deployments.v1",
    ],
    fixedInputSchemaVersion: 3,
    compiledFactSchemaVersion: 2,
    compilerAdapter: "exact-fixed-input-to-v9-facts.v1",
    routeAdapterVersion: "v2",
    chainSupplyAdapter: "fixed-input.usd-circulating-supply.v2",
    researchOverlaysAdapter: "v9-fact-extension.review-overlays.v3",
    includesReviewedTransfers: true,
    includesShockCoverage: true,
  },
  {
    name: "transfer-fact",
    matches: (identity, capabilities) =>
      stableStringify(identity.compiledFactSchemaCapabilities) === stableStringify(capabilities),
    capabilities: [
      "canonical-chain-supply-distribution.v1",
      "exit-route-modeled-confidence.v1",
      "reviewed-transfer-deployments.v1",
    ],
    fixedInputSchemaVersion: 3,
    compiledFactSchemaVersion: 2,
    compilerAdapter: "exact-fixed-input-to-v9-facts.v1",
    routeAdapterVersion: "v2",
    chainSupplyAdapter: "fixed-input.usd-circulating-supply.v2",
    researchOverlaysAdapter: "v9-fact-extension.review-overlays.v3",
    includesReviewedTransfers: true,
    includesShockCoverage: false,
  },
  {
    name: "phase-one",
    matches: () => true,
    capabilities: ["canonical-chain-supply-distribution.v1", "exit-route-modeled-confidence.v1"],
    fixedInputSchemaVersion: 3,
    compiledFactSchemaVersion: 2,
    compilerAdapter: "exact-fixed-input-to-v9-facts.v1",
    routeAdapterVersion: "v2",
    chainSupplyAdapter: "fixed-input.usd-circulating-supply.v2",
    researchOverlaysAdapter: "v9-fact-extension.review-overlays.v2",
    includesReviewedTransfers: false,
    includesShockCoverage: false,
  },
];
function assertCompilerIdentity(value, label) {
  const identity = requireExactKeys(
    value,
    [
      "schemaVersion",
      "fixedInputSchemaVersion",
      "factExtensionSchemaVersion",
      "compiledFactSchemaVersion",
      "compiledFactSchemaCapabilities",
      "compilerAdapter",
      "evaluationBuildDigest",
    ],
    `${label} compiler identity`,
  );
  const compilerProfile = COMPILER_PROFILES.find((profile) =>
    profile.matches(identity, profile.capabilities),
  );
  const fixedInputSchemaVersions = Array.isArray(compilerProfile.fixedInputSchemaVersion)
    ? compilerProfile.fixedInputSchemaVersion
    : [compilerProfile.fixedInputSchemaVersion];
  if (
    identity.schemaVersion !== 1 ||
    !fixedInputSchemaVersions.includes(identity.fixedInputSchemaVersion) ||
    identity.factExtensionSchemaVersion !== 2 ||
    identity.compiledFactSchemaVersion !== compilerProfile.compiledFactSchemaVersion ||
    stableStringify(identity.compiledFactSchemaCapabilities) !== stableStringify(compilerProfile.capabilities) ||
    identity.compilerAdapter !== compilerProfile.compilerAdapter
  ) {
    throw new Error(`${label} compiler identity does not match its closed production profile`);
  }
  requireDigest(identity.evaluationBuildDigest, `${label} compiler identity evaluationBuildDigest`);
  return {
    identity,
    compilerProfile: { ...compilerProfile, fixedInputSchemaVersion: identity.fixedInputSchemaVersion },
  };
}
function assertProducerIdentity(value, label, compilerProfile) {
  const { includesReviewedTransfers, includesShockCoverage } = compilerProfile;
  const identity = requireExactKeys(
    value,
    [
      "schemaVersion",
      "inputContractVersions",
      "sourceAdapters",
      "scoreBearingMethodologyVersions",
      "dexRouteCapabilityMatrixVersions",
      "freshnessPolicySec",
    ],
    `${label} producer identity`,
  );
  const contracts = requireExactKeys(
    identity.inputContractVersions,
    ["fixedInput", "factExtension"],
    `${label} producer input contracts`,
  );
  const adapters = requireExactKeys(
    identity.sourceAdapters,
    [
      "registry",
      "dexExitRoutes",
      "redemptionExitRoutes",
      "liveReserves",
      "chainSupply",
      "peg",
      "researchOverlays",
      ...(includesShockCoverage ? ["shockCoverage"] : []),
    ],
    `${label} producer source adapters`,
  );
  const versions = requireExactKeys(
    identity.scoreBearingMethodologyVersions,
    ["dexExitRoutes", "redemptionExitRoutes", "peg"],
    `${label} producer methodology versions`,
  );
  const freshnessKeys = [
    "dexExitRoutes",
    "redemptionExitRoutes",
    "documentedTermsExitRoutes",
    ...(includesReviewedTransfers ? ["accessReviews"] : []),
    "liveReserves",
    "chainSupply",
    "peg",
    "researchOverlays",
  ];
  const freshness = requireExactKeys(identity.freshnessPolicySec, freshnessKeys, `${label} producer freshness policy`);
  const expectedAdapters = {
    registry: "fixed-input.registry.v1",
    dexExitRoutes: `fixed-input.dex-exit-observations.${compilerProfile.routeAdapterVersion}`,
    redemptionExitRoutes: `fixed-input.redemption-exit-observations.${compilerProfile.routeAdapterVersion}`,
    liveReserves: "fixed-input.live-reserves.v1",
    chainSupply: compilerProfile.chainSupplyAdapter,
    peg: "fixed-input.peg-summary.v1",
    researchOverlays: compilerProfile.researchOverlaysAdapter,
    ...(includesShockCoverage ? { shockCoverage: "journal-registry.cdp-shock-coverage.v1" } : {}),
  };
  if (
    identity.schemaVersion !== 1 ||
    contracts.fixedInput !== compilerProfile.fixedInputSchemaVersion ||
    contracts.factExtension !== 2 ||
    stableStringify(adapters) !== stableStringify(expectedAdapters)
  ) {
    throw new Error(`${label} producer identity does not match its closed production profile`);
  }
  for (const key of ["dexExitRoutes", "redemptionExitRoutes", "peg"]) {
    requireCanonicalStrings(versions[key], `${label} producer methodology versions ${key}`);
  }
  requireCanonicalStrings(
    identity.dexRouteCapabilityMatrixVersions,
    `${label} producer DEX capability matrix versions`,
  );
  for (const key of ["dexExitRoutes", "redemptionExitRoutes", "documentedTermsExitRoutes"]) {
    requireNonnegativeInteger(freshness[key], `${label} producer freshness ${key}`);
  }
  if (includesReviewedTransfers) {
    if (freshness.accessReviews !== 31_536_000) {
      throw new Error(`${label} producer access freshness must be 31536000 seconds`);
    }
  }
  for (const key of ["liveReserves", "chainSupply", "peg", "researchOverlays"]) {
    requireNonnegativeInteger(freshness[key], `${label} producer freshness ${key}`, true);
  }
  return { identity, contracts, versions, freshness };
}
function producerVersionsOrUnavailable(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return values.length > 0 ? [...values] : ["unavailable"];
}
export function computeCalibrationBaseInputGenerationId(input) {
  const fixedInput = requireRecord(input, "fixed input");
  if (fixedInput.schemaVersion === 4) {
    if (
      typeof fixedInput.baseInputGenerationId !== "string" ||
      !/^report-cards-input:v1:[a-f0-9]{64}$/.test(fixedInput.baseInputGenerationId)
    ) {
      throw new Error("fixed input base generation must be a report-cards-input:v1 digest");
    }
    return fixedInput.baseInputGenerationId;
  }
  const methodology = requireRecord(fixedInput.inputMethodologyVersions, "fixed input methodology versions");
  const requiredMaps = [
    "pegDataById",
    "activeDepegPeakBpsById",
    "dexLiqMap",
    "redemptionBackstopMap",
    "bluechipMap",
    "resolvedBlacklistStatuses",
    "liveReserveMap",
    "liveReserveProvenanceMap",
    "chainCirculatingById",
    "dexDeploymentSupplyCoverageById",
    "inputFreshness",
  ];
  for (const field of requiredMaps) requireRecord(fixedInput[field], `fixed input ${field}`);
  if (!Array.isArray(fixedInput.activeAssetIds)) throw new Error("fixed input activeAssetIds must be an array");
  if (!Number.isInteger(fixedInput.clockSec) || !Number.isInteger(fixedInput.updatedAt)) {
    throw new Error("fixed input clocks must be integers");
  }
  requireDigest(fixedInput.registryFingerprint, "fixed input registry fingerprint");
  requireDigest(fixedInput.dexPayloadFingerprint, "fixed input DEX payload fingerprint");
  requireDigest(fixedInput.redemptionPayloadFingerprint, "fixed input redemption payload fingerprint");
  producerVersionsOrUnavailable(methodology.dexLiquidity, "DEX methodology versions");
  producerVersionsOrUnavailable(methodology.pegScore, "peg methodology versions");
  producerVersionsOrUnavailable(methodology.redemptionBackstop, "redemption methodology versions");
  return deriveReportCardsBaseInputGenerationId(fixedInput);
}
export function computeCalibrationFactSetDigest(compiledFacts) {
  return computeV9FactSetDigest(requireRecord(compiledFacts, "compiled facts"));
}
function traceResultDigestVersion(trace) {
  const hasInheritableScore = Object.prototype.hasOwnProperty.call(
    trace,
    "inheritableScore",
  );
  const hasScoreAdjustments = Object.prototype.hasOwnProperty.call(
    trace,
    "scoreAdjustments",
  );
  if (hasInheritableScore !== hasScoreAdjustments) {
    throw new Error(
      "evaluated trace must carry both inheritableScore and scoreAdjustments or neither",
    );
  }
  return hasInheritableScore ? 2 : 1;
}
function compactTrace(trace, resultDigestVersion = traceResultDigestVersion(trace)) {
  if (resultDigestVersion === 2) return projectCompactV9ScoreTrace(trace);
  const contributions = new Map(trace.pillarContributions.map((entry) => [entry.pillar, entry.score]));
  return {
    assetId: trace.assetId,
    score: trace.finalScore,
    grade: trace.finalGrade,
    pillars: {
      backing: contributions.get("backing") ?? null,
      exit: contributions.get("exit") ?? null,
      control: contributions.get("control") ?? null,
    },
    weakestPillar: trace.weakestPillar,
    bindingCap: trace.bindingCap
      ? { kind: trace.bindingCap.kind, limit: trace.bindingCap.limit, source: trace.bindingCap.source }
      : null,
    reasonCodes: [...new Set(trace.nrReasons.map((reason) => reason.code))].sort(compareText),
    factSetDigest: trace.factSetDigest,
    policyId: trace.policyId,
    policyDigest: trace.policyDigest,
    evaluationBuildDigest: trace.evaluationBuildDigest,
    asOfSec: trace.asOfSec,
  };
}
export function computeCalibrationResultDigest(evaluatedSet) {
  const evaluated = requireRecord(evaluatedSet, "evaluated set");
  if (!Array.isArray(evaluated.assets)) throw new Error("evaluated set assets must be an array");
  const versions = new Set(
    evaluated.assets.map((asset) => traceResultDigestVersion(asset.trace)),
  );
  if (versions.size === 0) {
    throw new Error("evaluated set must contain at least one score trace");
  }
  if (versions.size !== 1) {
    throw new Error(
      "evaluated set must contain one homogeneous result-digest trace version",
    );
  }
  const resultDigestVersion = versions.values().next().value;
  if (resultDigestVersion === 2) {
    return computeV9ResultDigest(evaluated.assets.map((asset) => asset.trace));
  }
  const results = evaluated.assets
    .map((asset) => compactTrace(asset.trace, resultDigestVersion))
    .sort((left, right) => compareText(left.assetId, right.assetId));
  return sha256(
    stableStringify({
      domain: `safety-score-v9.result.v${resultDigestVersion}`,
      results,
    }),
  );
}
export function computeCalibrationIdentityDigest(domain, identity) {
  return domainDigest(domain, requireRecord(identity, "identity"));
}
export function computeCalibrationCandidateId(identity) {
  return `safety-score-v9:v1:${computeCalibrationIdentityDigest(
    "safety-score-v9.publication-id.v1",
    identity,
  )}`;
}
function rowAssetIds(rows, key, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} must be an array`);
  return uniqueAssetIds(
    rows.map((row) => row?.[key]),
    label,
  );
}

function assertExactReplayAssetSets(pipeline, label) {
  const sets = [
    ["fixedInput.activeAssetIds", uniqueAssetIds(pipeline.fixedInput?.activeAssetIds, `${label} fixed-input assets`)],
    [
      "compiledFacts.activeAssetIds",
      uniqueAssetIds(pipeline.compiledFacts?.activeAssetIds, `${label} compiled active assets`),
    ],
    ["compiledFacts.assets", rowAssetIds(pipeline.compiledFacts?.assets, "assetId", `${label} compiled rows`)],
    ["evaluatedSet.assets", rowAssetIds(pipeline.evaluatedSet?.assets, "assetId", `${label} evaluated rows`)],
    ["candidate.cards", rowAssetIds(pipeline.candidate?.cards, "id", `${label} candidate cards`)],
  ];
  const expected = sets[0][1];
  for (const [source, ids] of sets.slice(1)) {
    if (stableStringify(ids) !== stableStringify(expected)) {
      throw new Error(`${label} asset set mismatch between fixedInput.activeAssetIds and ${source}`);
    }
  }
  return expected;
}

export function assertReplay(replay, label) {
  if (!Array.isArray(replay?.pipeline?.candidate?.cards)) {
    throw new Error(`${label} does not contain pipeline.candidate.cards`);
  }
  if (!Array.isArray(replay?.pipeline?.evaluatedSet?.assets)) {
    throw new Error(`${label} does not contain pipeline.evaluatedSet.assets`);
  }
  if (!Array.isArray(replay?.pipeline?.compiledFacts?.assets)) {
    throw new Error(`${label} does not contain pipeline.compiledFacts.assets`);
  }
  assertExactReplayAssetSets(replay.pipeline, label);
  const fixedBaseId = replay?.pipeline?.fixedInput?.baseInputGenerationId;
  const candidateBaseId = replay?.pipeline?.candidate?.baseInputGenerationId;
  if (typeof fixedBaseId !== "string" || fixedBaseId !== candidateBaseId) {
    throw new Error(`${label} does not bind candidate and fixed-input generations`);
  }
  const pipeline = replay.pipeline;
  const candidateIdentity = assertCandidateIdentity(pipeline.candidateIdentity, label);
  const { identity: compilerIdentity, compilerProfile } = assertCompilerIdentity(
    pipeline.compilerFactSchemaIdentity,
    label,
  );
  const producer = assertProducerIdentity(pipeline.producerCapabilityIdentity, label, compilerProfile);
  const computedBaseId = computeCalibrationBaseInputGenerationId(pipeline.fixedInput);
  if (fixedBaseId !== computedBaseId || pipeline.compiledFacts.baseInputGenerationId !== computedBaseId) {
    throw new Error(`${label} fixed-input generation does not match its score-bearing payload`);
  }

  const computedFactSetDigest = computeCalibrationFactSetDigest(pipeline.compiledFacts);
  if (
    pipeline.compiledFacts.v9FactSetDigest !== computedFactSetDigest ||
    pipeline.evaluatedSet.factSetDigest !== computedFactSetDigest ||
    pipeline.candidate.factSetDigest !== computedFactSetDigest
  ) {
    throw new Error(`${label} fact-set digest does not match its compiled facts`);
  }

  const computedResultDigest = computeCalibrationResultDigest(pipeline.evaluatedSet);
  if (
    pipeline.evaluatedSet.scoreResultDigest !== computedResultDigest ||
    pipeline.candidate.resultDigest !== computedResultDigest
  ) {
    throw new Error(`${label} result digest does not match its evaluated traces`);
  }

  const compilerDigest = computeCalibrationIdentityDigest("safety-score-v9.compiler-fact-schema.v1", compilerIdentity);
  const producerDigest = computeCalibrationIdentityDigest(
    "safety-score-v9.producer-capability-build.v1",
    producer.identity,
  );
  if (
    pipeline.compilerFactSchemaDigest !== compilerDigest ||
    pipeline.candidateIdentity.compilerFactSchemaDigest !== compilerDigest
  ) {
    throw new Error(`${label} compiler identity digest does not match its identity payload`);
  }
  if (
    compilerIdentity.evaluationBuildDigest !== candidateIdentity.evaluationBuildDigest ||
    compilerIdentity.fixedInputSchemaVersion !== pipeline.fixedInput.schemaVersion ||
    compilerIdentity.factExtensionSchemaVersion !== pipeline.extension?.schemaVersion ||
    compilerIdentity.compiledFactSchemaVersion !== pipeline.compiledFacts.schemaVersion
  ) {
    throw new Error(`${label} compiler schema/build identity does not match its score-bearing pipeline`);
  }
  const expectedMethodologyVersions = {
    dexExitRoutes: [...new Set(pipeline.fixedInput.inputMethodologyVersions?.dexLiquidity ?? [])].sort(compareText),
    redemptionExitRoutes: [...new Set(pipeline.fixedInput.inputMethodologyVersions?.redemptionBackstop ?? [])].sort(
      compareText,
    ),
    peg: [...new Set(pipeline.fixedInput.inputMethodologyVersions?.pegScore ?? [])].sort(compareText),
  };
  const expectedFreshness = {
    dexExitRoutes: pipeline.extension?.routeFreshness?.dexMaxAgeSec,
    redemptionExitRoutes: pipeline.extension?.routeFreshness?.redemptionMaxAgeSec,
    documentedTermsExitRoutes: pipeline.extension?.routeFreshness?.documentedTermsMaxAgeSec,
    ...(compilerProfile.includesReviewedTransfers ? { accessReviews: 31_536_000 } : {}),
    liveReserves: pipeline.extension?.sources?.liveReserves?.maxAgeSec,
    chainSupply: pipeline.extension?.sources?.chainSupply?.maxAgeSec,
    peg: pipeline.extension?.sources?.peg?.maxAgeSec,
    researchOverlays: pipeline.extension?.sources?.researchOverlays?.maxAgeSec,
  };
  if (
    producer.contracts.fixedInput !== pipeline.fixedInput.schemaVersion ||
    producer.contracts.factExtension !== pipeline.extension?.schemaVersion ||
    stableStringify(producer.versions) !== stableStringify(expectedMethodologyVersions) ||
    stableStringify(producer.freshness) !== stableStringify(expectedFreshness)
  ) {
    throw new Error(`${label} producer identity does not match its score-bearing pipeline`);
  }
  if (
    pipeline.producerCapabilityDigest !== producerDigest ||
    pipeline.candidateIdentity.producerCapabilityDigest !== producerDigest
  ) {
    throw new Error(`${label} producer identity digest does not match its identity payload`);
  }
  if (
    candidateIdentity.evaluationBuildDigest !== pipeline.evaluatedSet.evaluationBuildDigest ||
    candidateIdentity.policyId !== pipeline.evaluatedSet.policyId ||
    candidateIdentity.policyDigest !== pipeline.evaluatedSet.policyDigest
  ) {
    throw new Error(`${label} candidate identity does not match its evaluated policy/build`);
  }
  if (pipeline.candidate.candidateId !== computeCalibrationCandidateId(candidateIdentity)) {
    throw new Error(`${label} candidate ID does not match its candidate identity`);
  }

  const evaluatedById = new Map(pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  for (const card of pipeline.candidate.cards) {
    const asset = evaluatedById.get(card.id);
    if (!asset) throw new Error(`${label} candidate card ${card.id} has no evaluated asset`);
    const compact = compactTrace(asset.trace);
    if (
      card.score !== compact.score ||
      card.grade !== compact.grade ||
      card.pillars.backing.score !== compact.pillars.backing ||
      card.pillars.exit.score !== compact.pillars.exit ||
      card.pillars.control.score !== compact.pillars.control
    ) {
      throw new Error(`${label} candidate card ${card.id} does not match its evaluated trace`);
    }
    if (
      asset.trace.baseInputGenerationId !== computedBaseId ||
      asset.trace.factSetDigest !== computedFactSetDigest ||
      asset.trace.policyId !== pipeline.candidateIdentity.policyId ||
      asset.trace.policyDigest !== pipeline.candidateIdentity.policyDigest ||
      asset.trace.evaluationBuildDigest !== pipeline.candidateIdentity.evaluationBuildDigest
    ) {
      throw new Error(`${label} evaluated trace ${card.id} does not match the replay bindings`);
    }
  }
}

export function reproduceCandidateReplay(replay, label) {
  const publishedAtSec = replay?.pipeline?.candidate?.publishedAtSec;
  if (!Number.isInteger(publishedAtSec) || publishedAtSec < 0) {
    throw new Error(`${label} candidate must bind a nonnegative integer publishedAtSec`);
  }
  const candidateId = replay.pipeline.candidate.candidateId;
  const replayInput = {
    fixedInput: replay.pipeline.fixedInput,
    extension: replay.pipeline.extension,
    publishedAtSec,
    ...(typeof candidateId === "string" && /^v9-rc-[1-9][0-9]*$/.test(candidateId)
      ? { releaseCandidateId: candidateId }
      : {}),
  };
  const cacheKey = stableStringify(replayInput);
  let rebuilt = trustedReplayCache.get(cacheKey);
  if (rebuilt === undefined) {
    try {
      rebuilt = buildSafetyScoreV9ReplayArtifact({
        fixedInput: replayInput.fixedInput,
        ...(replayInput.extension === undefined ? {} : { extension: replayInput.extension }),
        publishedAtSec,
        ...(replayInput.releaseCandidateId ? { releaseCandidateId: replayInput.releaseCandidateId } : {}),
      }).pipeline;
      trustedReplayCache.set(cacheKey, rebuilt);
    } catch (error) {
      throw new Error(
        `${label} could not run the trusted production compiler and evaluator`,
        { cause: error },
      );
    }
  }
  if (stableStringify(rebuilt) !== stableStringify(replay.pipeline)) {
    throw new Error(`${label} does not reproduce through the trusted production compiler and evaluator`);
  }
  return rebuilt;
}
