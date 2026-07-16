import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const GRADE_ORDER = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"];
const GRADE_BOUNDARIES = [40, 50, 55, 60, 65, 70, 75, 80, 83, 87, 100];
const ADVERSE_IDS = [
  "usdd-tron-dao-reserve",
  "u-united-stables",
  "usdai-usd-ai",
  "tusd-trueusd",
  "eurs-stasis",
  "mim-abracadabra",
];
const EXPECTED_BASELINE = {
  expectedCount: 344,
  ratedCount: 342,
  nrIds: ["brlm-mento", "zeusd-zoth"],
  histogram: {
    "A+": 0,
    A: 0,
    "A-": 0,
    "B+": 1,
    B: 1,
    "B-": 0,
    "C+": 2,
    C: 9,
    "C-": 12,
    D: 105,
    F: 212,
    NR: 2,
  },
  largestPillarTuple: { key: "35/35/45", count: 104 },
  largestScoreBucket: { key: "38", count: 81 },
  scoreIqr: 9,
};
const EXPECTED_ADVERSE_BASELINE = new Map([
  ["usdd-tron-dao-reserve", { score: 31, grade: "F" }],
  ["u-united-stables", { score: 31, grade: "F" }],
  ["usdai-usd-ai", { score: 39, grade: "F" }],
  ["tusd-trueusd", { score: 53, grade: "C-" }],
  ["eurs-stasis", { score: 20, grade: "F" }],
  ["mim-abracadabra", { score: 0, grade: "F" }],
]);
const EXPECTED_BASELINE_BINDINGS = {
  candidateIdentity: {
    schemaVersion: 1,
    policyId: "safety-score-v9-candidate-v2",
    policyDigest: "84c0e4180eea111591a5a48dc1d9149d4f950b912cb239913a2cc6fa932f607d",
    evaluationBuildDigest: "b2c0b298bea563d8b548c3f9d594e43cb46b762b62bfd7be3053a72430d320d1",
    compilerFactSchemaDigest: "9d7b637e0f808df4f19699f7ad10f09413fb46cc66ed0befb707db59a44ca511",
    producerCapabilityDigest: "19f1ab3ce18de294d33482cff07891f987a2715071cf48ba7cd75ff72562f198",
  },
  candidateId: "safety-score-v9-candidate:v1:f3c9335b1fa87559f79421e392d876f7518a46a6575aa23b8cce2c7fcb2e876c",
  baseInputGenerationId: "report-cards-input:v1:79bcc863f04ce1e55040589185f4a996cc8765e063d7a53e9fb89c0e8c2642a4",
  sourceGeneration: "report-cards:8.17:1784214085",
  registryFingerprint: "2a821e9b50c4a82177c1589e0375a1a673ecee7be1a642329163486af5a47a39",
  factSetDigest: "defb600329157e4b4413c4e1d6e5202ddc0b338d58034ebb4a786060e9309b11",
  resultDigest: "0f6623acdcfb427a5ab36a0be9fa88ec5b8e83e97dd0a5141d2567db251cb426",
};
const ASSET_WIDE_CONTROL_GAPS = new Set([
  "missing-bridge-routes",
  "missing-custody-review",
  "missing-mint-authority",
  "missing-oracle-review",
  "missing-upgradeability-review",
  "selected-bridge-route-unresolved",
  "unknown-control-cap-authority",
  "unknown-upgrade-authority",
  "unresolved-control-identity",
  "unresolved-mint-authority",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function stableStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value === undefined) return "";
  if (typeof value !== "object") throw new Error(`Unsupported replay identity value: ${typeof value}`);
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainDigest(domain, payload) {
  return sha256(stableStringify({ domain, payload }));
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`${label} does not match the closed production identity shape`);
  }
  return record;
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
  const historicalBaseline =
    identity.evaluationBuildDigest === EXPECTED_BASELINE_BINDINGS.candidateIdentity.evaluationBuildDigest;
  const expectedCapabilities = historicalBaseline
    ? ["canonical-chain-supply-distribution.v1"]
    : ["canonical-chain-supply-distribution.v1", "exit-route-modeled-confidence.v1"];
  if (
    identity.schemaVersion !== 1 ||
    identity.fixedInputSchemaVersion !== 3 ||
    identity.factExtensionSchemaVersion !== 2 ||
    identity.compiledFactSchemaVersion !== 2 ||
    stableStringify(identity.compiledFactSchemaCapabilities) !== stableStringify(expectedCapabilities) ||
    identity.compilerAdapter !== "exact-fixed-input-to-v9-facts.v1"
  ) {
    throw new Error(`${label} compiler identity does not match its closed production profile`);
  }
  requireDigest(identity.evaluationBuildDigest, `${label} compiler identity evaluationBuildDigest`);
  return { identity, historicalBaseline };
}

function assertProducerIdentity(value, label, historicalBaseline) {
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
    ["registry", "dexExitRoutes", "redemptionExitRoutes", "liveReserves", "chainSupply", "peg", "researchOverlays"],
    `${label} producer source adapters`,
  );
  const versions = requireExactKeys(
    identity.scoreBearingMethodologyVersions,
    ["dexExitRoutes", "redemptionExitRoutes", "peg"],
    `${label} producer methodology versions`,
  );
  const freshness = requireExactKeys(
    identity.freshnessPolicySec,
    [
      "dexExitRoutes",
      "redemptionExitRoutes",
      "documentedTermsExitRoutes",
      "liveReserves",
      "chainSupply",
      "peg",
      "researchOverlays",
    ],
    `${label} producer freshness policy`,
  );
  const routeAdapterVersion = historicalBaseline ? "v1" : "v2";
  const expectedAdapters = {
    registry: "fixed-input.registry.v1",
    dexExitRoutes: `fixed-input.dex-exit-observations.${routeAdapterVersion}`,
    redemptionExitRoutes: `fixed-input.redemption-exit-observations.${routeAdapterVersion}`,
    liveReserves: "fixed-input.live-reserves.v1",
    chainSupply: "fixed-input.usd-circulating-supply.v2",
    peg: "fixed-input.peg-summary.v1",
    researchOverlays: "v9-fact-extension.review-overlays.v2",
  };
  if (
    identity.schemaVersion !== 1 ||
    contracts.fixedInput !== 3 ||
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

  const scoreBearingFactsSha256 = domainDigest("report-cards.base-input.score-bearing-facts.v1", {
    pegDataById: fixedInput.pegDataById,
    activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
    dexLiqMap: fixedInput.dexLiqMap,
    redemptionBackstopMap: fixedInput.redemptionBackstopMap,
    bluechipMap: fixedInput.bluechipMap,
    resolvedBlacklistStatuses: fixedInput.resolvedBlacklistStatuses,
    liveReserveMap: fixedInput.liveReserveMap,
    chainCirculatingById: fixedInput.chainCirculatingById,
    dexDeploymentSupplyCoverageById: fixedInput.dexDeploymentSupplyCoverageById,
  });
  const scoreBearingFreshnessSha256 = domainDigest("report-cards.base-input.score-bearing-freshness.v1", {
    liquidityStale: fixedInput.liquidityStale,
    redemptionStale: fixedInput.redemptionStale,
    inputFreshness: fixedInput.inputFreshness,
    liveReserveProvenanceMap: fixedInput.liveReserveProvenanceMap,
  });
  const projection = {
    schemaVersion: 1,
    captureKind: fixedInput.captureKind,
    publicationClockSec: fixedInput.clockSec,
    sourceUpdatedAtSec: fixedInput.updatedAt,
    registry: {
      activeAssetIds: [...fixedInput.activeAssetIds],
      fingerprintSha256: fixedInput.registryFingerprint,
    },
    producers: {
      dex: { generationId: fixedInput.dexGenerationId, payloadSha256: fixedInput.dexPayloadFingerprint },
      redemption: {
        generationId: fixedInput.redemptionGenerationId,
        payloadSha256: fixedInput.redemptionPayloadFingerprint,
      },
    },
    producerMethodologyVersions: {
      dexLiquidity: producerVersionsOrUnavailable(methodology.dexLiquidity, "DEX methodology versions"),
      pegScore: producerVersionsOrUnavailable(methodology.pegScore, "peg methodology versions"),
      redemptionBackstop: producerVersionsOrUnavailable(
        methodology.redemptionBackstop,
        "redemption methodology versions",
      ),
    },
    normalizedSnapshotDigests: { scoreBearingFactsSha256, scoreBearingFreshnessSha256 },
  };
  return `report-cards-input:v1:${sha256(stableStringify(projection))}`;
}

export function computeCalibrationFactSetDigest(compiledFacts) {
  const facts = requireRecord(compiledFacts, "compiled facts");
  return sha256(
    stableStringify({
      domain: "safety-score-v9.normalized-facts.v2",
      factSet: {
        schemaVersion: facts.schemaVersion,
        baseInputGenerationId: facts.baseInputGenerationId,
        asOfSec: facts.asOfSec,
        sourceFingerprints: facts.sourceFingerprints,
        activeAssetIds: facts.activeAssetIds,
        assets: facts.assets,
      },
    }),
  );
}

function compactTrace(trace) {
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
  const results = evaluated.assets
    .map((asset) => compactTrace(asset.trace))
    .sort((left, right) => compareText(left.assetId, right.assetId));
  return sha256(stableStringify({ domain: "safety-score-v9.result.v1", results }));
}

export function computeCalibrationIdentityDigest(domain, identity) {
  return domainDigest(domain, requireRecord(identity, "identity"));
}

export function computeCalibrationCandidateId(identity) {
  return `safety-score-v9-candidate:v1:${computeCalibrationIdentityDigest(
    "safety-score-v9.candidate-id.v1",
    identity,
  )}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function countsBy(values, keyOf) {
  const counts = new Map();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || compareText(left.key, right.key));
}

function nextBoundary(score) {
  return GRADE_BOUNDARIES.find((boundary) => boundary > score) ?? 100;
}

function assertReplay(replay, label) {
  if (!Array.isArray(replay?.pipeline?.candidate?.cards)) {
    throw new Error(`${label} does not contain pipeline.candidate.cards`);
  }
  if (!Array.isArray(replay?.pipeline?.evaluatedSet?.assets)) {
    throw new Error(`${label} does not contain pipeline.evaluatedSet.assets`);
  }
  if (!Array.isArray(replay?.pipeline?.compiledFacts?.assets)) {
    throw new Error(`${label} does not contain pipeline.compiledFacts.assets`);
  }
  const fixedBaseId = replay?.pipeline?.fixedInput?.baseInputGenerationId;
  const candidateBaseId = replay?.pipeline?.candidate?.baseInputGenerationId;
  if (typeof fixedBaseId !== "string" || fixedBaseId !== candidateBaseId) {
    throw new Error(`${label} does not bind candidate and fixed-input generations`);
  }
  const pipeline = replay.pipeline;
  const candidateIdentity = assertCandidateIdentity(pipeline.candidateIdentity, label);
  const { identity: compilerIdentity, historicalBaseline } = assertCompilerIdentity(
    pipeline.compilerFactSchemaIdentity,
    label,
  );
  const producer = assertProducerIdentity(pipeline.producerCapabilityIdentity, label, historicalBaseline);
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
  const factIds = pipeline.compiledFacts.assets.map((asset) => asset.assetId).sort(compareText);
  const evaluatedIds = [...evaluatedById.keys()].sort(compareText);
  const cardIds = pipeline.candidate.cards.map((card) => card.id).sort(compareText);
  if (
    stableStringify(factIds) !== stableStringify(evaluatedIds) ||
    stableStringify(cardIds) !== stableStringify(evaluatedIds)
  ) {
    throw new Error(`${label} compiled, evaluated, and candidate asset sets do not match`);
  }
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

function baselineMatchesContract(distribution, cards, replay) {
  const bold = cards.find((card) => card.id === "bold-liquity");
  return (
    distribution.expectedCount === EXPECTED_BASELINE.expectedCount &&
    distribution.ratedCount === EXPECTED_BASELINE.ratedCount &&
    JSON.stringify(distribution.nrIds) === JSON.stringify(EXPECTED_BASELINE.nrIds) &&
    JSON.stringify(distribution.histogram) === JSON.stringify(EXPECTED_BASELINE.histogram) &&
    JSON.stringify(distribution.largestPillarTuple) === JSON.stringify(EXPECTED_BASELINE.largestPillarTuple) &&
    JSON.stringify(distribution.largestScoreBucket) === JSON.stringify(EXPECTED_BASELINE.largestScoreBucket) &&
    distribution.scoreQuartiles.iqr === EXPECTED_BASELINE.scoreIqr &&
    bold?.score === 79 &&
    bold.grade === "B+" &&
    stableStringify(replay.pipeline.candidateIdentity) ===
      stableStringify(EXPECTED_BASELINE_BINDINGS.candidateIdentity) &&
    replay.pipeline.candidate.candidateId === EXPECTED_BASELINE_BINDINGS.candidateId &&
    replay.pipeline.fixedInput.baseInputGenerationId === EXPECTED_BASELINE_BINDINGS.baseInputGenerationId &&
    replay.pipeline.fixedInput.sourceGeneration === EXPECTED_BASELINE_BINDINGS.sourceGeneration &&
    replay.pipeline.fixedInput.registryFingerprint === EXPECTED_BASELINE_BINDINGS.registryFingerprint &&
    replay.pipeline.candidate.factSetDigest === EXPECTED_BASELINE_BINDINGS.factSetDigest &&
    replay.pipeline.candidate.resultDigest === EXPECTED_BASELINE_BINDINGS.resultDigest
  );
}

function realACandidateChecks(card, evaluated, facts) {
  const supply = evaluated?.stressState?.exitPortfolio?.circulatingUsd ?? 0;
  const hasExecutableDexRoute =
    evaluated?.exit?.routes?.some(
      (route) => route.included && route.routeKey.startsWith("dex:") && (route.capacityPoint?.executableUsd ?? 0) > 0,
    ) ?? false;
  const hasStaleEvidence = facts?.gaps?.some((gap) => gap.observationState === "stale") ?? true;
  const unresolvedAssetWideControl =
    facts?.gaps?.some(
      (gap) =>
        gap.ownerDomain === "control" &&
        ASSET_WIDE_CONTROL_GAPS.has(gap.reasonCode) &&
        gap.path?.kind !== "deployment-control",
    ) ?? true;
  const checks = {
    gradeAndRange: card.grade === "A" && card.score >= 83 && card.score <= 86,
    positiveSupply: supply > 0,
    executableDexRoute: hasExecutableDexRoute,
    strongEvidence:
      evaluated?.scoreInput?.pillars !== undefined &&
      Object.values(evaluated.scoreInput.pillars).every((pillar) => pillar.evidenceLevel === "strong"),
    currentEvidence: !hasStaleEvidence,
    assetWideControlsResolved: !unresolvedAssetWideControl,
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function summarizeDistribution(replay) {
  const cards = replay.pipeline.candidate.cards;
  const evaluatedById = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const rated = cards.filter((card) => card.grade !== "NR");
  const scores = rated.map((card) => card.score).sort((left, right) => left - right);
  const histogram = Object.fromEntries(
    GRADE_ORDER.map((grade) => [grade, cards.filter((card) => card.grade === grade).length]),
  );
  const pillarTuples = countsBy(
    rated,
    (card) => `${card.pillars.backing.score}/${card.pillars.exit.score}/${card.pillars.control.score}`,
  );
  const scoreBuckets = countsBy(rated, (card) => String(card.score));
  const totalSupply = cards.reduce(
    (sum, card) => sum + (evaluatedById.get(card.id)?.stressState?.exitPortfolio?.circulatingUsd ?? 0),
    0,
  );
  const ratedSupply = rated.reduce(
    (sum, card) => sum + (evaluatedById.get(card.id)?.stressState?.exitPortfolio?.circulatingUsd ?? 0),
    0,
  );
  return {
    expectedCount: cards.length,
    ratedCount: rated.length,
    nrIds: cards
      .filter((card) => card.grade === "NR")
      .map((card) => card.id)
      .sort(compareText),
    ratedSupplyShare: totalSupply > 0 ? ratedSupply / totalSupply : null,
    histogram,
    cMinusOrBetter: rated.filter((card) => GRADE_ORDER.indexOf(card.grade) <= GRADE_ORDER.indexOf("C-")).length,
    bMinusOrBetter: rated.filter((card) => GRADE_ORDER.indexOf(card.grade) <= GRADE_ORDER.indexOf("B-")).length,
    largestPillarTuple: pillarTuples[0] ?? null,
    largestPillarTupleShare: pillarTuples.length > 0 ? pillarTuples[0].count / rated.length : null,
    largestScoreBucket: scoreBuckets[0] ?? null,
    largestScoreBucketShare: scoreBuckets.length > 0 ? scoreBuckets[0].count / rated.length : null,
    scoreQuartiles: {
      p25: quantile(scores, 0.25),
      p75: quantile(scores, 0.75),
      iqr: scores.length > 0 ? round(quantile(scores, 0.75) - quantile(scores, 0.25)) : null,
    },
  };
}

function uncertaintyLedger(replay) {
  const cards = replay.pipeline.candidate.cards;
  const evaluatedById = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const factsById = new Map(replay.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const rows = cards.map((card) => {
    const evaluated = evaluatedById.get(card.id);
    const facts = factsById.get(card.id);
    if (!evaluated || !facts) throw new Error(`Missing evaluated or compiled asset ${card.id}`);
    return {
      assetId: card.id,
      supplyUsd: evaluated.stressState?.exitPortfolio?.circulatingUsd ?? null,
      score: card.score,
      grade: card.grade,
      nextBoundary: card.grade === "NR" ? null : nextBoundary(card.score),
      distanceToNextBoundary: card.grade === "NR" ? null : nextBoundary(card.score) - card.score,
      evidenceLevel: card.evidence.level,
      pillars: Object.fromEntries(
        Object.entries(card.pillars).map(([pillar, value]) => [
          pillar,
          { score: value.score, evidence: value.evidenceLevel },
        ]),
      ),
      uncertainBackingComponents: evaluated.backing.contributions
        .filter((component) => component.observationState !== "known")
        .map((component) => ({
          componentKey: component.componentKey,
          source: component.source,
          score: component.score,
          scopeWeight: component.normalizedWeight,
          observationState: component.observationState,
        })),
      excludedOrUnscoredExitRoutes: evaluated.exit.routes
        .filter((route) => !route.included || route.score === null)
        .map((route) => ({ routeKey: route.routeKey, exclusionReason: route.exclusionReason })),
      conservativeControlComponents: evaluated.control.components
        .filter((component) => component.score <= 45 || component.posture.includes("unknown"))
        .map((component) => ({
          componentKey: component.componentKey,
          score: component.score,
          posture: component.posture,
        })),
      gaps: facts.gaps.map((gap) => ({
        gapId: gap.gapId,
        ownerDomain: gap.ownerDomain,
        reasonCode: gap.reasonCode,
        observationState: gap.observationState,
      })),
      caps: card.caps.map((cap) => ({ source: cap.source, kind: cap.kind, limit: cap.limit })),
    };
  });
  const bySupply = [...rows]
    .sort((left, right) => (right.supplyUsd ?? -1) - (left.supplyUsd ?? -1) || compareText(left.assetId, right.assetId))
    .slice(0, 80);
  const byFrontier = rows
    .filter((row) => row.distanceToNextBoundary !== null)
    .sort(
      (left, right) =>
        left.distanceToNextBoundary - right.distanceToNextBoundary ||
        (right.supplyUsd ?? -1) - (left.supplyUsd ?? -1) ||
        compareText(left.assetId, right.assetId),
    )
    .slice(0, 80);
  return { top80BySupply: bySupply, top80ByFrontier: byFrontier };
}

function changesFromBaseline(baseline, candidate) {
  const beforeById = new Map(baseline.pipeline.candidate.cards.map((card) => [card.id, card]));
  return candidate.pipeline.candidate.cards
    .flatMap((card) => {
      const before = beforeById.get(card.id);
      if (!before || (before.score === card.score && before.grade === card.grade)) return [];
      return [
        {
          assetId: card.id,
          score: { from: before?.score ?? null, to: card.score, delta: before ? card.score - before.score : null },
          grade: { from: before?.grade ?? null, to: card.grade },
          pillars: Object.fromEntries(
            Object.keys(card.pillars).map((pillar) => [
              pillar,
              {
                from: before?.pillars[pillar]?.score ?? null,
                to: card.pillars[pillar].score,
                delta: before ? card.pillars[pillar].score - before.pillars[pillar].score : null,
              },
            ]),
          ),
          bindingCap: { from: before?.bindingCap ?? null, to: card.bindingCap },
        },
      ];
    })
    .sort((left, right) => compareText(left.assetId, right.assetId));
}

export function analyzeV9Calibration(baseline, candidate) {
  assertReplay(baseline, "baseline");
  assertReplay(candidate, "candidate");
  const baselineDistribution = summarizeDistribution(baseline);
  const distribution = summarizeDistribution(candidate);
  const candidateById = new Map(candidate.pipeline.candidate.cards.map((card) => [card.id, card]));
  const baselineById = new Map(baseline.pipeline.candidate.cards.map((card) => [card.id, card]));
  const evaluatedById = new Map(candidate.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const factsById = new Map(candidate.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const realACandidates = candidate.pipeline.candidate.cards
    .filter((card) => card.grade === "A" || (card.score >= 83 && card.score <= 86))
    .map((card) => ({
      assetId: card.id,
      score: card.score,
      grade: card.grade,
      ...realACandidateChecks(card, evaluatedById.get(card.id), factsById.get(card.id)),
    }));
  const realA = realACandidates.filter((candidate) => candidate.passed);
  const adverseControls = ADVERSE_IDS.map((assetId) => {
    const before = baselineById.get(assetId);
    const after = candidateById.get(assetId);
    const expected = EXPECTED_ADVERSE_BASELINE.get(assetId);
    return {
      assetId,
      baseline: before ? { score: before.score, grade: before.grade } : null,
      candidate: after ? { score: after.score, grade: after.grade } : null,
      baselineLocked: before?.score === expected?.score && before?.grade === expected?.grade,
      lifted:
        before && after
          ? after.score > before.score ||
            (after.score === before.score && GRADE_ORDER.indexOf(after.grade) < GRADE_ORDER.indexOf(before.grade))
          : true,
    };
  });
  const sameInput =
    baseline.pipeline.fixedInput.baseInputGenerationId === candidate.pipeline.fixedInput.baseInputGenerationId &&
    baseline.pipeline.fixedInput.sourceGeneration === candidate.pipeline.fixedInput.sourceGeneration &&
    baseline.pipeline.fixedInput.registryFingerprint === candidate.pipeline.fixedInput.registryFingerprint;
  const gates = {
    baselineLocked:
      baselineMatchesContract(baselineDistribution, baseline.pipeline.candidate.cards, baseline) &&
      adverseControls.every((control) => control.baselineLocked),
    sameInput,
    coverage:
      distribution.ratedCount === 342 &&
      distribution.expectedCount === 344 &&
      JSON.stringify(distribution.nrIds) === JSON.stringify(baselineDistribution.nrIds) &&
      distribution.ratedSupplyShare !== null &&
      distribution.ratedSupplyShare >= 0.9999,
    realA: realA.length > 0,
    fAtMost180: distribution.histogram.F <= 180,
    cMinusOrBetterAtLeast35: distribution.cMinusOrBetter >= 35,
    bMinusOrBetterAtLeast5: distribution.bMinusOrBetter >= 5,
    largestPillarTupleAtMost20Pct:
      distribution.largestPillarTupleShare !== null && distribution.largestPillarTupleShare <= 0.2,
    largestScoreBucketAtMost15Pct:
      distribution.largestScoreBucketShare !== null && distribution.largestScoreBucketShare <= 0.15,
    scoreIqrAtLeast12: distribution.scoreQuartiles.iqr !== null && distribution.scoreQuartiles.iqr >= 12,
    adverseControlsUnchanged: adverseControls.every((control) => !control.lifted),
  };
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-real-a-calibration-analysis",
    identities: {
      baseline: baseline.pipeline.candidateIdentity,
      candidate: candidate.pipeline.candidateIdentity,
    },
    baseline: baselineDistribution,
    candidate: distribution,
    gates: { ...gates, allPassed: Object.values(gates).every(Boolean) },
    realA: realA.map(({ assetId, score, grade }) => ({ assetId, score, grade })),
    realACandidates,
    adverseControls,
    changes: changesFromBaseline(baseline, candidate),
    uncertaintyLedger: uncertaintyLedger(candidate),
  };
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index < 0 ? null : argv[index + 1];
  };
  const baseline = value("--baseline");
  const candidate = value("--candidate");
  const output = value("--output");
  if (!baseline || !candidate || argv.includes("--help")) {
    const usage =
      "Usage: node scripts/maintenance/analyze-safety-score-v9-calibration.mjs --baseline <replay> --candidate <replay> [--output <json>]";
    if (argv.includes("--help")) {
      process.stdout.write(`${usage}\n`);
      return null;
    }
    throw new Error(usage);
  }
  return { baseline, candidate, output };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  if (args) {
    const report = analyzeV9Calibration(
      JSON.parse(readFileSync(args.baseline, "utf8")),
      JSON.parse(readFileSync(args.candidate, "utf8")),
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) writeFileSync(args.output, serialized, "utf8");
    else process.stdout.write(serialized);
  }
}
