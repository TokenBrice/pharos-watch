import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileV9FactSetV2, compileV9FactSetV3 } from "../../shared/lib/safety-score-v9/compile.ts";
import { evaluateV9FactSet } from "../../shared/lib/safety-score-v9/evaluate-set.ts";
import { V9_CANDIDATE_POLICY_V1 } from "../../shared/lib/safety-score-v9/policy.ts";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../shared/data/safety-score-v9/evaluation-build-manifest-v1.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_CLI_PATH = fileURLToPath(import.meta.resolve("tsx/cli"));
const TRUSTED_REPLAY_CLI_PATH = resolve(REPO_ROOT, "worker/scripts/replay-safety-score-v9.ts");
const trustedReplayCache = new Map();

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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_UNEXPLAINED_CAPTURE_MOVEMENT = 3;

/**
 * Distribution-gate thresholds (owner ruling D-C), re-derived 2026-07-20 against
 * the corrected CHAIN_SUPPLY denominator.
 *
 * Source of truth for the metric definitions:
 * `agents/safety-score-v9/results/phase3-2026-07-20/distribution-gate-derivation.md` §4.
 * Re-derivation and measured values:
 * `agents/safety-score-v9/results/phase3-2026-07-20/gate-rederivation-post-chain-supply.md`.
 * This block is the single authoritative gate set — the plan record's legacy
 * numbers (F<=150 / C-<=45 / B-<=8 / tuple<=15%) and the legacy script gates
 * they diverged from are retired, not carried alongside.
 *
 * Measurement basis, re-measured 2026-07-20 after the curation sweep
 * (`3a969e4b0`), the mechanism/transfer reviews (`5c0c836cb`) and the
 * aggregate-circulating producer fix (`45bf41bd8`) landed: the 07-18 capture
 * replayed at clockSec 1784613600 against the committed tree, 335/335 rated
 * assets observed over $331.50B, USDT+USDC at 77.65% of observed supply. The
 * earlier re-derivation measured a reconstructed fact-set patch on a moving
 * tree; this basis measures shipped producer code on a settled one. Full
 * arithmetic:
 * `agents/safety-score-v9/results/phase3-2026-07-20/d1-bar-derivation-2026-07-20.md`.
 *
 * D2A and D1 have moved from the original re-derivation. Every other threshold
 * is carried forward unchanged: corrected denominators shifted the measured
 * values but not the bars they are judged against. Two gates fail on this
 * measurement and are recorded as activation targets rather than tuned to pass
 * — D1 (0.3350 vs >=0.40) and D5B (7 vs >=8).
 */
const DISTRIBUTION_GATE_THRESHOLDS = {
  // D1: RE-SET 2026-07-20 to the reachable range (owner ruling: "re-set to what
  // is reachable, keep 50% as the post-activation target"). Measured 0.3350
  // against a $74.081B ex-top-2 denominator, so the bar still FAILS by 6.50pp
  // and is an activation target, not a tuned pass.
  //
  // Derivation of the ceiling. Of the $49.265B floored ex-top-2 supply, only
  // $11.803B (48 assets) is a drainable evidence gap — every floored pillar sits
  // exactly AT its bounded-unknown floor with only `missing-data`-classified
  // reasons. The rest cannot be lifted by closing an evidence queue:
  //   $26.811B (127) `unsupported-design` — routes reviewed, none comparable;
  //   $6.595B  (102) strictly sub-floor    — a measured-weak fact, not a gap;
  //   $4.057B  (6)   at-floor, no reason   — a measured value that coincides
  //                                          with the floor (usde-ethena's
  //                                          `external-lock-mint` bridge posture
  //                                          scores exactly 45), i.e. fully
  //                                          evidenced and misread by the
  //                                          `score <= floor` test.
  // So the absolute ceiling with every evidence gap in the corpus closed is
  // ($24.816B + $11.803B) / $74.081B = 0.4943, and 0.50 is therefore NOT
  // reachable by curation at all — it exceeds the ceiling. $4.493B of that gap
  // further depends on the P1 per-chain RPC programme, leaving a curation-only
  // ceiling of ($24.816B + $7.309B) / $74.081B = 0.4337.
  //
  // 0.40 is set below the curation-only ceiling so activation is not hostage to
  // the P1 data programme: reaching it needs $4.816B of the $11.803B drainable
  // gap closed (40.8% of the queue), leaving 3.37pp of margin on the curation
  // path and 9.43pp once P1 lands. Drift caveat: the ex-top-2 denominator is
  // still concentrated (dai-makerdao 6.55%, susds-sky 6.42%), so a single large
  // asset staling out of the evidenced set exceeds the curation-path margin.
  // 0.50 stays the post-activation target and requires a methodology change —
  // the fund-type exit-cap counterfactual (ruling D-D) against the
  // `unsupported-design` cohort, or correcting the floor-coincidence artifact —
  // not more curation. 0.60 (derivation §4) remains the long-run target.
  materialEvidenceCoverageExTop2Min: 0.4,
  // D2A: raised 0.75 -> 0.95. The 0.75 bar was calibrated against the producer
  // defect itself (57.31% observed); with the fix at 99.10% it would tolerate a
  // 24pp collapse in supply observation without tripping, which makes the gate
  // vacuous. 0.95 leaves ~13 assets of headroom on a 335-asset corpus.
  supplyObservationCoverageMin: 0.95,
  maxNrSupplyUsd: 50_000_000,
  unattributedFCountMax: 25,
  // D3B: measured 0.000488, ~2x headroom. Note this metric only clears the bar
  // once the engine is re-evaluated on the restored supply; a supply-join that
  // does not re-score reads 0.001332 and fails.
  unattributedFSupplyShareMax: 0.001,
  freeFloatingLargestBucketShareMax: 0.12,
  freeFloatingLargestTupleShareMax: 0.12,
  // D5A: 0.60 is recorded as the post-activation tightening (derivation §4, D5)
  // and is not applied while D1 is still open.
  materialCohortCMinusOrBetterShareMin: 0.5,
  // D5B: the bar is unchanged at 8. The cohort it is measured over moved from a
  // fixed top-50 rank window to a supply window (see
  // MATERIAL_COHORT_MIN_SUPPLY_USD): the previous 7-vs-8 failure was a
  // re-sorting artifact, not a corpus-quality signal — `usat-tether` (B) held
  // its supply and its grade but was pushed from inside the window to rank 54
  // by other assets becoming visible around it.
  materialCohortBMinusOrBetterCountMin: 8,
  scoreIqrMin: 12,
};
/** D1 excludes the N largest assets by supply so the gate measures the corpus, not the duopoly. */
const MATERIAL_COHORT_EXCLUDED_TOP_RANKS = 2;
/**
 * D5 cohort floor — "where users actually look", expressed as a supply window
 * rather than a rank cutoff.
 *
 * A fixed top-N cohort re-sorts on ordinary drift, so membership churns even
 * when no asset's supply or grade moved: the count oscillated 7/8 purely
 * because other assets became visible around a stable member. A supply window
 * holds membership fixed unless an asset's own supply crosses the line, so the
 * gate measures corpus quality instead of re-sorting noise.
 *
 * Derived from the observed supply distribution rather than chosen for its
 * outcome. $100M is the only break wider than 1.15x anywhere in the rank 35-70
 * region ($99.8M -> $84.0M, 1.19x), it admits 99.2% of observed rated supply,
 * and it reproduces a cohort of comparable size to the retired top-50 (46
 * assets) so the unchanged bar is judged against the same product question.
 * Members sit well clear of the line — the marginal B-or-better member carries
 * ~85% headroom — where a top-50 member sat four ranks from falling out.
 */
const MATERIAL_COHORT_MIN_SUPPLY_USD = 100_000_000;
/** Diagnostic-only alternative to ex-top-2 concentration handling (derivation §2.3). */
const WINSORIZED_WEIGHT_CAP = 0.05;

const PILLAR_KEYS = ["backing", "exit", "control"];
const PILLAR_BOUNDED_UNKNOWN_FLOORS = {
  backing: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.boundedUnknownQuality,
  exit: V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore,
  control: V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality,
};
const COMPROMISED_MINT_POSTURE_QUALITY =
  V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureQuality["unbounded-or-compromised"];
/**
 * Owner confirmation outstanding (derivation §5.4 open question 4): this value
 * separates `usda-alpha-partner` (0.910, unattributed) from 25 measured-adverse
 * assets. It is part of the D3 predicate, not a tunable calibration knob.
 */
const MEASURED_PEG_MULTIPLIER_FLOOR = 0.9;
const UNSUPPORTED_DESIGN_REASON_CODES = new Set(
  V9_CANDIDATE_POLICY_V1.policy.reasonRegistry
    .filter((entry) => entry.auditClassification === "unsupported-design")
    .map((entry) => entry.code),
);
const UNRESOLVED_METHODOLOGY_REASON_CODES = new Set(
  V9_CANDIDATE_POLICY_V1.policy.reasonRegistry
    .filter((entry) => entry.auditClassification === "unresolved-methodology")
    .map((entry) => entry.code),
);
const METHODOLOGY_BLOCKED_ARCHETYPES = new Set(["rwa-credit-fund", "synthetic-delta-neutral"]);
const METHODOLOGY_BLOCKED_RESIDUAL_REASON = "bounded-mechanism-review";
const GRADE_BANDS = { A: ["A+", "A", "A-"], B: ["B+", "B", "B-"], C: ["C+", "C", "C-"], D: ["D"], F: ["F"] };

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
  const phaseOneCapabilities = ["canonical-chain-supply-distribution.v1", "exit-route-modeled-confidence.v1"];
  const transferFactCapabilities = [...phaseOneCapabilities, "reviewed-transfer-deployments.v1"];
  const shockCoverageCapabilities = [
    ...phaseOneCapabilities,
    "journaled-cdp-shock-coverage.v1",
    "reviewed-transfer-deployments.v1",
  ];
  const currentCapabilities = [
    "canonical-chain-supply-distribution.v1",
    "canonical-lock-mint-supply-attribution.v1",
    "exit-route-modeled-confidence.v1",
    "fact-gap-responsibility.v1",
    "journaled-cdp-shock-coverage.v1",
    "reviewed-transfer-deployments.v1",
    "wrapper-local-facts.v1",
  ];
  const currentProduction =
    identity.evaluationBuildDigest === SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST &&
    stableStringify(identity.compiledFactSchemaCapabilities) === stableStringify(currentCapabilities);
  const productionProfile = historicalBaseline
    ? "historical"
    : currentProduction
      ? "current"
      : stableStringify(identity.compiledFactSchemaCapabilities) === stableStringify(shockCoverageCapabilities)
      ? "shock-coverage"
      : stableStringify(identity.compiledFactSchemaCapabilities) === stableStringify(transferFactCapabilities)
        ? "transfer-fact"
        : "phase-one";
  const expectedCapabilities =
    productionProfile === "historical"
      ? ["canonical-chain-supply-distribution.v1"]
      : productionProfile === "current"
        ? currentCapabilities
      : productionProfile === "shock-coverage"
        ? shockCoverageCapabilities
        : productionProfile === "transfer-fact"
          ? transferFactCapabilities
          : phaseOneCapabilities;
  if (
    identity.schemaVersion !== 1 ||
    identity.fixedInputSchemaVersion !== 3 ||
    identity.factExtensionSchemaVersion !== 2 ||
    identity.compiledFactSchemaVersion !== (productionProfile === "current" ? 3 : 2) ||
    stableStringify(identity.compiledFactSchemaCapabilities) !== stableStringify(expectedCapabilities) ||
    identity.compilerAdapter !==
      (productionProfile === "current" ? "exact-fixed-input-to-v9-facts.v2" : "exact-fixed-input-to-v9-facts.v1")
  ) {
    throw new Error(`${label} compiler identity does not match its closed production profile`);
  }
  requireDigest(identity.evaluationBuildDigest, `${label} compiler identity evaluationBuildDigest`);
  return { identity, productionProfile };
}

function assertProducerIdentity(value, label, productionProfile) {
  const includesReviewedTransfers =
    productionProfile === "current" ||
    productionProfile === "transfer-fact" ||
    productionProfile === "shock-coverage";
  const includesShockCoverage = productionProfile === "current" || productionProfile === "shock-coverage";
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
  const routeAdapterVersion = productionProfile === "historical" ? "v1" : "v2";
  const expectedAdapters = {
    registry: "fixed-input.registry.v1",
    dexExitRoutes: `fixed-input.dex-exit-observations.${routeAdapterVersion}`,
    redemptionExitRoutes: `fixed-input.redemption-exit-observations.${routeAdapterVersion}`,
    liveReserves: "fixed-input.live-reserves.v1",
    chainSupply:
      productionProfile === "current"
        ? "fixed-input.usd-circulating-supply.v3"
        : "fixed-input.usd-circulating-supply.v2",
    peg: "fixed-input.peg-summary.v1",
    researchOverlays: includesReviewedTransfers
      ? "v9-fact-extension.review-overlays.v3"
      : "v9-fact-extension.review-overlays.v2",
    ...(includesShockCoverage ? { shockCoverage: "journal-registry.cdp-shock-coverage.v1" } : {}),
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
    navPriceById: fixedInput.navPriceById ?? {},
    activeDepegPeakBpsById: fixedInput.activeDepegPeakBpsById,
    dexLiqMap: fixedInput.dexLiqMap,
    redemptionBackstopMap: fixedInput.redemptionBackstopMap,
    bluechipMap: fixedInput.bluechipMap,
    resolvedBlacklistStatuses: fixedInput.resolvedBlacklistStatuses,
    liveReserveMap: fixedInput.liveReserveMap,
    chainCirculatingById: fixedInput.chainCirculatingById,
    // Absent must project as an empty map, not as an absent key: the fixed-input
    // schema parses this through Zod `.default({})`, so a capture predating the
    // aggregate-supply fallback reaches the real path as `{}`. Omitting the key
    // here instead would diverge from the TS projection unconditionally.
    aggregateCirculatingById: fixedInput.aggregateCirculatingById ?? {},
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
  const domain =
    facts.schemaVersion === 2
      ? "safety-score-v9.normalized-facts.v2"
      : facts.schemaVersion === 3
        ? "safety-score-v9.normalized-facts.v3"
        : null;
  if (domain === null) throw new Error("compiled facts has an unsupported schema version");
  return sha256(
    stableStringify({
      domain,
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

function uniqueAssetIds(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must contain nonempty asset IDs`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} must contain unique asset IDs`);
  return [...values].sort(compareText);
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
  assertExactReplayAssetSets(replay.pipeline, label);
  const fixedBaseId = replay?.pipeline?.fixedInput?.baseInputGenerationId;
  const candidateBaseId = replay?.pipeline?.candidate?.baseInputGenerationId;
  if (typeof fixedBaseId !== "string" || fixedBaseId !== candidateBaseId) {
    throw new Error(`${label} does not bind candidate and fixed-input generations`);
  }
  const pipeline = replay.pipeline;
  const candidateIdentity = assertCandidateIdentity(pipeline.candidateIdentity, label);
  const { identity: compilerIdentity, productionProfile } = assertCompilerIdentity(
    pipeline.compilerFactSchemaIdentity,
    label,
  );
  const producer = assertProducerIdentity(pipeline.producerCapabilityIdentity, label, productionProfile);
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
    ...(productionProfile === "current" ||
      productionProfile === "transfer-fact" ||
      productionProfile === "shock-coverage"
      ? { accessReviews: 31_536_000 }
      : {}),
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

function reproduceCandidateReplay(replay, label) {
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
    const tempDir = mkdtempSync(resolve(tmpdir(), "pharos-v9-calibration-replay-"));
    const fixedInputPath = resolve(tempDir, "fixed-input.json");
    const extensionPath = resolve(tempDir, "extension.json");
    const outputPath = resolve(tempDir, "replay.json");
    try {
      writeFileSync(fixedInputPath, `${JSON.stringify(replayInput.fixedInput)}\n`, "utf8");
      if (replayInput.extension !== undefined) {
        writeFileSync(extensionPath, `${JSON.stringify(replayInput.extension)}\n`, "utf8");
      }
      const args = [
        TSX_CLI_PATH,
        TRUSTED_REPLAY_CLI_PATH,
        "--input",
        fixedInputPath,
        ...(replayInput.extension === undefined ? [] : ["--extension", extensionPath]),
        "--output",
        outputPath,
        "--published-at",
        String(publishedAtSec),
        ...(replayInput.releaseCandidateId ? ["--release-candidate-id", replayInput.releaseCandidateId] : []),
      ];
      execFileSync(process.execPath, args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      });
      rebuilt = JSON.parse(readFileSync(outputPath, "utf8")).pipeline;
      trustedReplayCache.set(cacheKey, rebuilt);
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
      throw new Error(
        `${label} could not run the trusted production compiler and evaluator${stderr ? `: ${stderr}` : ""}`,
        { cause: error },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  if (stableStringify(rebuilt) !== stableStringify(replay.pipeline)) {
    throw new Error(`${label} does not reproduce through the trusted production compiler and evaluator`);
  }
  return rebuilt;
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

function addEvidenceRefs(value, refs) {
  if (Array.isArray(value)) {
    for (const entry of value) addEvidenceRefs(entry, refs);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value.evidenceRefIds)) {
    for (const evidenceId of value.evidenceRefIds) refs.add(evidenceId);
  }
  for (const child of Object.values(value)) addEvidenceRefs(child, refs);
}

function scoreBearingEvidenceFreshness(evaluated, facts) {
  const refs = new Set(evaluated?.backing?.evidenceRefIds ?? []);
  for (const value of [facts?.implementation, facts?.dependencies, facts?.supply, facts?.peg]) {
    addEvidenceRefs(value, refs);
  }
  const routesByKey = new Map((facts?.exitRoutes ?? []).map((route) => [route.routeKey, route]));
  for (const route of evaluated?.exit?.routes ?? []) {
    if (route.included) addEvidenceRefs(routesByKey.get(route.routeKey), refs);
  }
  addEvidenceRefs(facts?.controlStatus, refs);
  addEvidenceRefs(facts?.economicControlReview, refs);
  const controlsByKey = new Map((facts?.controls ?? []).map((control) => [control.controlKey, control]));
  for (const component of evaluated?.control?.components ?? []) {
    for (const controlKey of component.controlKeys ?? []) addEvidenceRefs(controlsByKey.get(controlKey), refs);
  }
  const scoreReasonCodes = new Set([
    ...Object.values(evaluated?.scoreInput?.pillars ?? {}).flatMap((pillar) =>
      (pillar?.reasons ?? []).map((reason) => reason.code),
    ),
    ...(evaluated?.scoreInput?.peg?.reasons ?? []).map((reason) => reason.code),
    ...(evaluated?.scoreInput?.dependencyReasons ?? []).map((reason) => reason.code),
    ...(evaluated?.scoreInput?.methodologyReasons ?? []).map((reason) => reason.code),
  ]);
  for (const gap of facts?.gaps ?? []) {
    if (scoreReasonCodes.has(gap.reasonCode)) addEvidenceRefs(gap, refs);
  }

  const evidenceById = new Map((facts?.evidence ?? []).map((reference) => [reference.evidenceId, reference]));
  const missingIds = [...refs].filter((evidenceId) => !evidenceById.has(evidenceId)).sort(compareText);
  const noncurrentIds = [...refs]
    .filter((evidenceId) => {
      const reference = evidenceById.get(evidenceId);
      return reference && (reference.disposition === "rejected" || reference.freshness?.state !== "current");
    })
    .sort(compareText);
  return {
    referencedCount: refs.size,
    missingIds,
    noncurrentIds,
    passed: refs.size > 0 && missingIds.length === 0 && noncurrentIds.length === 0,
  };
}

function resolvedStatus(status) {
  return (
    status !== null &&
    typeof status === "object" &&
    status.observationState === "known" &&
    status.applicability?.state !== "unresolved"
  );
}

function custodyStatuses(review) {
  if (review === null || typeof review !== "object") return [];
  return Object.entries(review).flatMap(([key, value]) =>
    /custod/i.test(key) && value !== null && typeof value === "object" && "status" in value ? [value.status] : [],
  );
}

function isAssetWideControlReason(reason, facts) {
  if (reason?.pathKind === "local-component" || reason?.controlKey == null) return true;
  const control = (facts?.controls ?? []).find((entry) => entry.controlKey === reason.controlKey);
  return control === undefined || control.scope === "global";
}

function assetWideControlsResolved(evaluated, facts) {
  const economic = facts?.economicControlReview;
  const typedStatuses = [
    facts?.controlStatus,
    economic?.mint?.status,
    economic?.oracle?.status,
    ...(economic?.oracle?.branches ?? []).map((branch) => branch.status),
    economic?.bridge?.status,
    ...custodyStatuses(facts?.mechanismRiskReview?.review),
  ].filter((status) => status !== undefined);
  const typedStatusesResolved = typedStatuses.length > 0 && typedStatuses.every(resolvedStatus);
  const upgradeResolved = economic?.mint?.upgrade?.state !== "unknown";
  const unresolvedReasons = (evaluated?.control?.reasons ?? []).filter((reason) =>
    isAssetWideControlReason(reason, facts),
  );
  const profileGaps = (facts?.gaps ?? []).filter(
    (gap) => gap.reasonCode === "missing-custody-profile" || gap.reasonCode === "missing-oracle-profile",
  );
  return {
    unresolvedReasonCodes: [...new Set(unresolvedReasons.map((reason) => reason.code))].sort(compareText),
    unresolvedProfileGapCodes: [...new Set(profileGaps.map((gap) => gap.reasonCode))].sort(compareText),
    passed: typedStatusesResolved && upgradeResolved && unresolvedReasons.length === 0 && profileGaps.length === 0,
  };
}

export function evaluateRealACandidateChecks(card, evaluated, facts) {
  const supply = evaluated?.stressState?.exitPortfolio?.circulatingUsd ?? 0;
  const hasExecutableDexRoute =
    evaluated?.exit?.routes?.some(
      (route) => route.included && route.routeKey.startsWith("dex:") && (route.capacityPoint?.executableUsd ?? 0) > 0,
    ) ?? false;
  const evidenceFreshness = scoreBearingEvidenceFreshness(evaluated, facts);
  const controls = assetWideControlsResolved(evaluated, facts);
  const checks = {
    gradeAndRange: card.grade === "A" && card.score >= 83 && card.score <= 86,
    positiveSupply: supply > 0,
    executableDexRoute: hasExecutableDexRoute,
    strongEvidence:
      evaluated?.scoreInput?.pillars !== undefined &&
      Object.values(evaluated.scoreInput.pillars).every((pillar) => pillar.evidenceLevel === "strong"),
    currentEvidence: evidenceFreshness.passed,
    assetWideControlsResolved: controls.passed,
  };
  return { checks, evidenceFreshness, controls, passed: Object.values(checks).every(Boolean) };
}

function pillarsAtOrBelowFloor(card) {
  return PILLAR_KEYS.filter((pillar) => card.pillars[pillar].score <= PILLAR_BOUNDED_UNKNOWN_FLOORS[pillar]).length;
}

function knownSupplyUsd(facts) {
  const supply = facts?.supply;
  return supply?.status?.observationState === "known" && typeof supply.circulatingUsd === "number"
    ? supply.circulatingUsd
    : null;
}

function isAdverseStructuralCapKind(kind) {
  return (
    kind === "parent" || kind.startsWith("active-depeg:") || (kind.startsWith("signal:") && kind.endsWith(":critical"))
  );
}

/**
 * D3 attribution predicate — derivation §3.1 class (a).
 *
 * An F grade is *attributed* when at least one driver below fires, i.e. the F is
 * held by a measured adverse fact rather than by an evidence gap. D3 gates the
 * complement (unattributed F), so softening measurement cannot satisfy it:
 * blunting a driver moves an asset from attributed to unattributed and makes the
 * gate worse.
 *
 * OWNER RULING 2026-07-20 — the STATED definition is authoritative. D3's
 * unattributed count is every F not held by a measured adverse fact, i.e.
 * derivation §3.1 class (b) PLUS class (c). The §3.2 headline table's "14" is
 * the class-(b) row alone and is NOT the gate metric; do not narrow this
 * predicate to match it. The four class-(c) methodology-blocked assets
 * (`iauon-ondo`, `srusd-reservoir`, `wsrusd-reservoir`, `susd1plus-lorenzo`) are
 * correctly counted, because a methodology capability gap leaves an F just as
 * un-held by a measured fact as a curation gap does. On the basis the ruling was
 * issued against that made the count 18 with a margin of 7 against `<= 25`, not
 * 14 with a margin of 11. `distributionDiagnostics.fCohortClassCounts` publishes
 * the b/c split so the narrower reading stays visible without becoming the gate.
 *
 * POLICY-FREEZE OUTSTANDING. The derivation is emphatic that this predicate must
 * be frozen in policy alongside the gate, because an unfrozen predicate is a
 * tunable knob on a release gate. It is deliberately written as one named, pure
 * function of a card plus module-level policy-derived constants, so freezing is
 * mechanical: lift the driver list into
 * `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` and read it
 * here instead. Until that lands, treat any edit to this function as a
 * methodology change, not a script tweak.
 */
export function measuredAdverseFDrivers(card) {
  return {
    // Measured mint posture `unbounded-or-compromised`, not an unknown posture.
    compromisedMintPosture: card.pillars.control.score <= COMPROMISED_MINT_POSTURE_QUALITY,
    // Measured-weak beats unknown: strictly below the bounded-unknown floor.
    subFloorPillar: PILLAR_KEYS.some((pillar) => card.pillars[pillar].score < PILLAR_BOUNDED_UNKNOWN_FLOORS[pillar]),
    measuredPegHistory: typeof card.pegMultiplier === "number" && card.pegMultiplier < MEASURED_PEG_MULTIPLIER_FLOOR,
    bindingAdverseCap: card.caps.some((cap) => cap.binding && isAdverseStructuralCapKind(cap.kind)),
    // Routes were reviewed and none is comparable — a finding, not a gap.
    unsupportedExitDesign: (card.reasonCodes ?? []).some((code) => UNSUPPORTED_DESIGN_REASON_CODES.has(code)),
  };
}

function isMeasuredAdverseF(card) {
  return Object.values(measuredAdverseFDrivers(card)).some(Boolean);
}

/**
 * Derivation §3.1 class (c): not measured-adverse, and blocked by a methodology
 * capability gap rather than by curable curation. Diagnostic only — class (c)
 * still counts as unattributed for D3, because it is not held by a measured fact.
 */
function isMethodologyBlockedF(card, facts) {
  const reasonCodes = card.reasonCodes ?? [];
  return (
    reasonCodes.some((code) => UNRESOLVED_METHODOLOGY_REASON_CODES.has(code)) ||
    (METHODOLOGY_BLOCKED_ARCHETYPES.has(facts?.archetype) && reasonCodes.includes(METHODOLOGY_BLOCKED_RESIDUAL_REASON))
  );
}

function supplyBuckets(entries, keyOf, totalSupply) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = buckets.get(key) ?? { count: 0, supplyUsd: 0 };
    bucket.count += 1;
    bucket.supplyUsd += entry.supplyUsd ?? 0;
    buckets.set(key, bucket);
  }
  return Object.fromEntries(
    [...buckets.entries()]
      .sort((left, right) => compareText(left[0], right[0]))
      .map(([key, bucket]) => [
        key,
        {
          count: bucket.count,
          supplyUsd: round(bucket.supplyUsd, 2),
          supplyShare: totalSupply > 0 ? round(bucket.supplyUsd / totalSupply) : null,
        },
      ]),
  );
}

/**
 * Distribution gates D1-D6 (derivation §4) plus their report-only companions
 * (§4.2). Pure function of one replay plus the candidate policy file: no
 * network, no external data, reproducible from a pinned input.
 */
function distributionGateMetrics(replay, rated, scoreQuartiles) {
  const cards = replay.pipeline.candidate.cards;
  const factsById = new Map(replay.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const ratedRows = rated.map((card) => ({
    card,
    supplyUsd: knownSupplyUsd(factsById.get(card.id)),
    floorCount: pillarsAtOrBelowFloor(card),
  }));
  const observed = ratedRows.filter((row) => row.supplyUsd !== null);
  const observedSupply = observed.reduce((sum, row) => sum + row.supplyUsd, 0);
  const bySupply = [...observed].sort(
    (left, right) => right.supplyUsd - left.supplyUsd || compareText(left.card.id, right.card.id),
  );

  // D1 — material-cohort evidence coverage, supply-weighted, ex-top-2.
  const exTopRanks = bySupply.slice(MATERIAL_COHORT_EXCLUDED_TOP_RANKS);
  const exTopSupply = exTopRanks.reduce((sum, row) => sum + row.supplyUsd, 0);
  const exTopEvidenced = exTopRanks.filter((row) => row.floorCount === 0).reduce((sum, row) => sum + row.supplyUsd, 0);

  // D2 — supply-observation coverage and NR materiality.
  const nrSupplies = cards
    .filter((card) => card.grade === "NR")
    .map((card) => knownSupplyUsd(factsById.get(card.id)) ?? 0);

  // D3 — under-evidenced F.
  const fCards = rated.filter((card) => card.grade === "F");
  const unattributedF = fCards.filter((card) => !isMeasuredAdverseF(card));
  const unattributedFSupply = unattributedF.reduce(
    (sum, card) => sum + (knownSupplyUsd(factsById.get(card.id)) ?? 0),
    0,
  );

  // D4 — discrimination among assets policy leaves free to float.
  const freeFloating = rated.filter((card) => !card.caps.some((cap) => cap.binding));
  const freeFloatingBuckets = countsBy(freeFloating, (card) => String(card.score));
  const freeFloatingTuples = countsBy(
    freeFloating,
    (card) => `${card.pillars.backing.score}/${card.pillars.exit.score}/${card.pillars.control.score}`,
  );
  const freeFloatingShare = (entries) =>
    freeFloating.length > 0 && entries.length > 0 ? round(entries[0].count / freeFloating.length) : null;

  // D5 — material-cohort sanity over every rated asset inside the supply window.
  const materialCohort = bySupply
    .filter((row) => row.supplyUsd >= MATERIAL_COHORT_MIN_SUPPLY_USD)
    .map((row) => row.card);
  const atOrAbove = (grade) =>
    materialCohort.filter((card) => GRADE_ORDER.indexOf(card.grade) <= GRADE_ORDER.indexOf(grade)).length;

  // Diagnostic — 5% winsorized weights, the alternative concentration handling.
  const winsorizedWeights = observed.map((row) => ({
    row,
    weight: observedSupply > 0 ? Math.min(row.supplyUsd / observedSupply, WINSORIZED_WEIGHT_CAP) : 0,
  }));
  const winsorizedTotal = winsorizedWeights.reduce((sum, entry) => sum + entry.weight, 0);
  const winsorizedEvidenced = winsorizedWeights
    .filter((entry) => entry.row.floorCount === 0)
    .reduce((sum, entry) => sum + entry.weight, 0);

  return {
    gated: {
      materialEvidenceCoverageExTop2: exTopSupply > 0 ? round(exTopEvidenced / exTopSupply) : null,
      supplyObservationCoverage: rated.length > 0 ? round(observed.length / rated.length) : null,
      maxNrSupplyUsd: nrSupplies.length > 0 ? round(Math.max(...nrSupplies), 2) : 0,
      unattributedFCount: unattributedF.length,
      unattributedFSupplyShare: observedSupply > 0 ? round(unattributedFSupply / observedSupply) : null,
      freeFloatingLargestBucketShare: freeFloatingShare(freeFloatingBuckets),
      freeFloatingLargestTupleShare: freeFloatingShare(freeFloatingTuples),
      materialCohortCMinusOrBetterShare: materialCohort.length > 0 ? round(atOrAbove("C-") / materialCohort.length) : null,
      materialCohortBMinusOrBetterCount: atOrAbove("B-"),
      scoreIqr: scoreQuartiles.iqr,
    },
    diagnostics: {
      observedSupplyUsd: round(observedSupply, 2),
      observedSupplyAssetCount: observed.length,
      freeFloatingCount: freeFloating.length,
      freeFloatingLargestBucket: freeFloatingBuckets[0] ?? null,
      freeFloatingLargestTuple: freeFloatingTuples[0] ?? null,
      materialCohortSize: materialCohort.length,
      unattributedFAssetIds: unattributedF.map((card) => card.id).sort(compareText),
      capLimitPinCounts: countsBy(
        rated.filter((card) => card.bindingCap !== null),
        (card) => String(card.bindingCap.limit),
      ),
      supplyShareByGradeBand: supplyBuckets(
        ratedRows,
        (row) => Object.keys(GRADE_BANDS).find((band) => GRADE_BANDS[band].includes(row.card.grade)) ?? "other",
        observedSupply,
      ),
      supplyShareByFloorState: supplyBuckets(ratedRows, (row) => String(row.floorCount), observedSupply),
      fCohortClassCounts: {
        a: fCards.filter((card) => isMeasuredAdverseF(card)).length,
        b: unattributedF.filter((card) => !isMethodologyBlockedF(card, factsById.get(card.id))).length,
        c: unattributedF.filter((card) => isMethodologyBlockedF(card, factsById.get(card.id))).length,
      },
      winsorizedEvidenceCoverage: winsorizedTotal > 0 ? round(winsorizedEvidenced / winsorizedTotal) : null,
    },
  };
}

/**
 * Gate booleans D1-D6 over the metrics above. A null metric fails closed.
 *
 * NOTE: D2 is derived as the replacement for the `ratedSupplyShare >= 0.9999`
 * clause inside the preserved `coverage` gate (derivation §4, D2). That clause
 * is deliberately left in place here — retiring it is outside this lane's scope
 * and needs the owner ruling that reconciles `coverage` as a whole.
 */
function distributionGates(metrics) {
  const atLeast = (value, minimum) => value !== null && value >= minimum;
  const atMost = (value, maximum) => value !== null && value <= maximum;
  return {
    d1MaterialEvidenceCoverageExTop2: atLeast(
      metrics.materialEvidenceCoverageExTop2,
      DISTRIBUTION_GATE_THRESHOLDS.materialEvidenceCoverageExTop2Min,
    ),
    d2aSupplyObservationCoverage: atLeast(
      metrics.supplyObservationCoverage,
      DISTRIBUTION_GATE_THRESHOLDS.supplyObservationCoverageMin,
    ),
    d2bMaxNrSupplyUsd: atMost(metrics.maxNrSupplyUsd, DISTRIBUTION_GATE_THRESHOLDS.maxNrSupplyUsd),
    d3aUnattributedFCount: atMost(metrics.unattributedFCount, DISTRIBUTION_GATE_THRESHOLDS.unattributedFCountMax),
    d3bUnattributedFSupplyShare: atMost(
      metrics.unattributedFSupplyShare,
      DISTRIBUTION_GATE_THRESHOLDS.unattributedFSupplyShareMax,
    ),
    d4aFreeFloatingLargestBucketShare: atMost(
      metrics.freeFloatingLargestBucketShare,
      DISTRIBUTION_GATE_THRESHOLDS.freeFloatingLargestBucketShareMax,
    ),
    d4bFreeFloatingLargestTupleShare: atMost(
      metrics.freeFloatingLargestTupleShare,
      DISTRIBUTION_GATE_THRESHOLDS.freeFloatingLargestTupleShareMax,
    ),
    d5aMaterialCohortCMinusOrBetterShare: atLeast(
      metrics.materialCohortCMinusOrBetterShare,
      DISTRIBUTION_GATE_THRESHOLDS.materialCohortCMinusOrBetterShareMin,
    ),
    d5bMaterialCohortBMinusOrBetterCount: atLeast(
      metrics.materialCohortBMinusOrBetterCount,
      DISTRIBUTION_GATE_THRESHOLDS.materialCohortBMinusOrBetterCountMin,
    ),
    d6ScoreIqr: atLeast(metrics.scoreIqr, DISTRIBUTION_GATE_THRESHOLDS.scoreIqrMin),
  };
}

export function summarizeDistribution(replay) {
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
  const scoreQuartiles = {
    p25: quantile(scores, 0.25),
    p75: quantile(scores, 0.75),
    iqr: scores.length > 0 ? round(quantile(scores, 0.75) - quantile(scores, 0.25)) : null,
  };
  const rawLargestTupleShare = pillarTuples.length > 0 ? pillarTuples[0].count / rated.length : null;
  const rawLargestBucketShare = scoreBuckets.length > 0 ? scoreBuckets[0].count / rated.length : null;
  const gateMetrics = distributionGateMetrics(replay, rated, scoreQuartiles);
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
    largestPillarTupleShare: rawLargestTupleShare,
    largestScoreBucket: scoreBuckets[0] ?? null,
    largestScoreBucketShare: rawLargestBucketShare,
    scoreQuartiles,
    distributionMetrics: gateMetrics.gated,
    distributionDiagnostics: {
      ...gateMetrics.diagnostics,
      rawLargestBucketShare: rawLargestBucketShare === null ? null : round(rawLargestBucketShare),
      rawLargestTupleShare: rawLargestTupleShare === null ? null : round(rawLargestTupleShare),
      gradeHistogram: histogram,
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

function realACandidatesForReplay(replay) {
  const evaluatedById = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const factsById = new Map(replay.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  return replay.pipeline.candidate.cards
    .filter((card) => card.grade === "A" || (card.score >= 83 && card.score <= 86))
    .map((card) => ({
      assetId: card.id,
      score: card.score,
      grade: card.grade,
      ...evaluateRealACandidateChecks(card, evaluatedById.get(card.id), factsById.get(card.id)),
    }));
}

function captureInputIsFresh(replay) {
  const input = replay.pipeline.fixedInput;
  return (
    input.captureKind === "exact-publication-inputs" &&
    input.liquidityStale === false &&
    input.redemptionStale === false &&
    Object.values(input.inputFreshness ?? {}).every((freshness) => freshness?.stale !== true)
  );
}

export function captureMovements(captures) {
  const movements = [];
  for (let index = 1; index < captures.length; index += 1) {
    const before = captures[index - 1];
    const after = captures[index];
    const beforeById = new Map(before.pipeline.candidate.cards.map((card) => [card.id, card]));
    const beforeEvaluated = new Map(before.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
    const afterEvaluated = new Map(after.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
    for (const card of after.pipeline.candidate.cards) {
      const previous = beforeById.get(card.id);
      if (!previous) continue;
      const delta = card.score - previous.score;
      if (Math.abs(delta) <= MAX_UNEXPLAINED_CAPTURE_MOVEMENT) continue;
      movements.push({
        assetId: card.id,
        fromResultDigest: before.pipeline.candidate.resultDigest,
        toResultDigest: after.pipeline.candidate.resultDigest,
        fromScore: previous.score,
        toScore: card.score,
        delta,
        scoreBearingInputChanged: compareScoreBearingInputs(beforeEvaluated.get(card.id), afterEvaluated.get(card.id))
          .changed,
      });
    }
  }
  return movements.sort(
    (left, right) =>
      compareText(left.fromResultDigest, right.fromResultDigest) || compareText(left.assetId, right.assetId),
  );
}

export function repeatedRealAAssetIds(candidateRealAIds, qualifyingByCapture) {
  if (qualifyingByCapture.length !== 3) return [];
  return [...candidateRealAIds]
    .filter((assetId) => qualifyingByCapture.every((assetIds) => assetIds.includes(assetId)))
    .sort(compareText);
}

function validateFreshCaptureSeries(values, candidateAssetIds, candidateRealAIds) {
  const captures = Array.isArray(values) ? values : [];
  for (const [index, capture] of captures.entries()) {
    assertReplay(capture, `fresh capture ${index + 1}`);
    reproduceCandidateReplay(capture, `fresh capture ${index + 1}`);
  }
  const ordered = [...captures].sort(
    (left, right) => left.pipeline.fixedInput.clockSec - right.pipeline.fixedInput.clockSec,
  );
  const baseIds = ordered.map((capture) => capture.pipeline.fixedInput.baseInputGenerationId);
  const sourceGenerations = ordered.map((capture) => capture.pipeline.fixedInput.sourceGeneration);
  const clocks = ordered.map((capture) => capture.pipeline.fixedInput.clockSec);
  const identitiesMatch =
    ordered.length > 0 &&
    ordered.every(
      (capture) =>
        stableStringify(capture.pipeline.candidateIdentity) === stableStringify(ordered[0].pipeline.candidateIdentity),
    );
  const expectedAssetSet = stableStringify([...candidateAssetIds].sort(compareText));
  const assetSetsMatch =
    ordered.length > 0 &&
    ordered.every(
      (capture) =>
        stableStringify([...capture.pipeline.fixedInput.activeAssetIds].sort(compareText)) === expectedAssetSet,
    );
  const distinctAndOrdered =
    new Set(baseIds).size === 3 &&
    new Set(sourceGenerations).size === 3 &&
    new Set(clocks).size === 3 &&
    clocks.every((clock, index) => index === 0 || clocks[index - 1] < clock);
  const qualifyingByCapture = ordered.map((capture) =>
    realACandidatesForReplay(capture)
      .filter((entry) => entry.passed)
      .map((entry) => entry.assetId),
  );
  const repeatedRealAIds = repeatedRealAAssetIds(candidateRealAIds, qualifyingByCapture);
  return {
    providedCount: captures.length,
    ordered,
    baseInputGenerationIds: baseIds,
    resultDigests: ordered.map((capture) => capture.pipeline.candidate.resultDigest),
    distinctAndOrdered,
    identitiesMatch,
    assetSetsMatch,
    allInputsFresh: ordered.length === 3 && ordered.every(captureInputIsFresh),
    repeatedRealAIds,
    movementsOverThree: captureMovements(ordered),
  };
}

export function qualifyingCompositeCards(cards) {
  if (!Array.isArray(cards)) throw new Error("composite cards must be an array");
  return cards
    .filter((card) => card.grade === "A+" && card.score >= 87)
    .map((card) => ({ assetId: card.id, score: card.score, grade: card.grade }));
}

function evaluateCompositeReplay(replay) {
  if (replay === undefined) return { provided: false, qualifyingCards: [], passed: false };
  assertReplay(replay, "composite");
  reproduceCandidateReplay(replay, "composite");
  const qualifyingCards = qualifyingCompositeCards(replay.pipeline.candidate.cards);
  return { provided: true, qualifyingCards, passed: qualifyingCards.length > 0 };
}

function currentSemanticsCounterfactual(baseline) {
  const { v9FactSetDigest: _historicalDigest, ...core } = baseline.pipeline.compiledFacts;
  const compiled =
    core.schemaVersion === 3
      ? compileV9FactSetV3(core)
      : core.schemaVersion === 2
        ? compileV9FactSetV2(core)
        : (() => {
            throw new Error("baseline compiled facts has an unsupported schema version");
          })();
  return evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
}

function projectedStructuralSignal(signal) {
  return {
    kind: signal.kind,
    severity: signal.severity,
    materialSharePct: signal.materialSharePct ?? null,
    failureDomainKeys: [...new Set(signal.failureDomainKeys ?? [])].sort(compareText),
  };
}

/**
 * Project the exact semantic input consumed by the score formula. Global trace
 * identity and explanatory prose are deliberately excluded: either can change
 * when an unrelated asset changes without changing this asset's score.
 */
export function projectScoreBearingCalibrationInput(evaluatedAsset) {
  const scoreInput = requireRecord(evaluatedAsset?.scoreInput, "evaluated asset score input");
  const pillars = requireRecord(scoreInput.pillars, "evaluated asset pillars");
  const peg = requireRecord(scoreInput.peg, "evaluated asset peg input");
  const parent = requireRecord(scoreInput.parent, "evaluated asset parent input");
  const evidenceRank = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.rank;
  const evidenceLevel = ["backing", "exit", "control"]
    .map((pillar) => requireRecord(pillars[pillar], `${pillar} pillar`).evidenceLevel)
    .sort((left, right) => evidenceRank[right] - evidenceRank[left])[0];
  const reasonCodes = [
    ...["backing", "exit", "control"].flatMap(
      (pillar) => requireRecord(pillars[pillar], `${pillar} pillar`).reasons ?? [],
    ),
    ...(peg.reasons ?? []),
    ...(scoreInput.dependencyReasons ?? []),
    ...(scoreInput.methodologyReasons ?? []),
  ].map((reason) => reason.code);
  const structuralSignals = [
    ...["backing", "exit", "control"].flatMap(
      (pillar) => requireRecord(pillars[pillar], `${pillar} pillar`).structuralSignals ?? [],
    ),
    ...(scoreInput.dependencyStructuralSignals ?? []),
  ]
    .map(projectedStructuralSignal)
    .sort((left, right) => compareText(stableStringify(left), stableStringify(right)));
  return {
    pillars: Object.fromEntries(
      ["backing", "exit", "control"].map((pillar) => [
        pillar,
        requireRecord(pillars[pillar], `${pillar} pillar`).score,
      ]),
    ),
    pegApplicable: peg.applicable,
    pegScore: peg.score,
    activeDepegBps: peg.activeDepegBps,
    evidenceLevel,
    trackRecordMonths: scoreInput.trackRecordMonths,
    parentRequired: parent.required,
    parentScore: parent.score,
    structuralSignals,
    unresolvedReasonCodes: [...new Set(reasonCodes)].sort(compareText),
  };
}

function compareScoreBearingInputs(before, after) {
  const baseline = projectScoreBearingCalibrationInput(before);
  const candidate = projectScoreBearingCalibrationInput(after);
  const changedFields = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])]
    .filter((field) => stableStringify(baseline[field]) !== stableStringify(candidate[field]))
    .sort(compareText);
  return {
    changed: changedFields.length > 0,
    changedFields,
    baselineDigest: domainDigest("safety-score-v9.calibration-score-input.v1", baseline),
    candidateDigest: domainDigest("safety-score-v9.calibration-score-input.v1", candidate),
  };
}

function causalDecomposition(baseline, candidate, changes) {
  try {
    const counterfactual = currentSemanticsCounterfactual(baseline);
    const counterfactualById = new Map(counterfactual.assets.map((asset) => [asset.assetId, asset]));
    const candidateById = new Map(candidate.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
    const semanticIdentityChanged =
      baseline.pipeline.candidateIdentity.policyDigest !== candidate.pipeline.candidateIdentity.policyDigest ||
      baseline.pipeline.candidateIdentity.evaluationBuildDigest !==
        candidate.pipeline.candidateIdentity.evaluationBuildDigest;
    const globalFactSetChanged =
      baseline.pipeline.compiledFacts.v9FactSetDigest !== candidate.pipeline.compiledFacts.v9FactSetDigest;
    const improvements = changes
      .filter((change) => change.score.delta > 0)
      .map((change) => {
        const counterfactualAsset = counterfactualById.get(change.assetId);
        const candidateAsset = candidateById.get(change.assetId);
        const counterfactualScore = counterfactualAsset?.trace.finalScore;
        const semanticDelta = counterfactualScore === undefined ? null : counterfactualScore - change.score.from;
        const factDelta = counterfactualScore === undefined ? null : change.score.to - counterfactualScore;
        const scoreBearingInput =
          counterfactualAsset && candidateAsset
            ? compareScoreBearingInputs(counterfactualAsset, candidateAsset)
            : {
                changed: false,
                changedFields: [],
                baselineDigest: null,
                candidateDigest: null,
              };
        const causes = [
          ...(semanticDelta !== null && semanticDelta > 0 && semanticIdentityChanged
            ? ["cohort-wide-semantic-correction"]
            : []),
          ...(factDelta !== null && factDelta > 0 && scoreBearingInput.changed ? ["new-score-bearing-fact"] : []),
        ];
        return {
          assetId: change.assetId,
          baselineScore: change.score.from,
          currentSemanticsOnBaselineFacts: counterfactualScore ?? null,
          candidateScore: change.score.to,
          semanticDelta,
          factDelta,
          scoreBearingInput,
          causes,
          valid:
            counterfactualScore !== undefined && semanticDelta + factDelta === change.score.delta && causes.length > 0,
        };
      });
    return {
      available: true,
      semanticIdentityChanged,
      globalFactSetChanged,
      improvements,
      passed: improvements.length > 0 && improvements.every((entry) => entry.valid),
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      semanticIdentityChanged: false,
      globalFactSetChanged: false,
      improvements: [],
      passed: false,
    };
  }
}

function requireEvidenceRefs(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} evidenceRefs must be nonempty`);
  return uniqueAssetIds(value, `${label} evidenceRefs`);
}

function validateCausalAttribution(input, baseline, candidate, decomposition, movements) {
  if (input === undefined) return { provided: false, explainedMovementKeys: new Set(), passed: false };
  const value = requireExactKeys(
    input,
    ["schemaVersion", "kind", "baselineResultDigest", "candidateResultDigest", "improvements", "captureMovements"],
    "causal attribution",
  );
  if (value.schemaVersion !== 1 || value.kind !== "safety-score-v9-friday-causal-attribution") {
    throw new Error("causal attribution has an unsupported schema or kind");
  }
  if (
    value.baselineResultDigest !== baseline.pipeline.candidate.resultDigest ||
    value.candidateResultDigest !== candidate.pipeline.candidate.resultDigest
  ) {
    throw new Error("causal attribution does not bind the analyzed baseline and candidate results");
  }
  if (!Array.isArray(value.improvements) || !Array.isArray(value.captureMovements)) {
    throw new Error("causal attribution rows must be arrays");
  }
  const expectedById = new Map(decomposition.improvements.map((entry) => [entry.assetId, entry]));
  const seenImprovementIds = new Set();
  let improvementsValid = value.improvements.length === expectedById.size;
  for (const raw of value.improvements) {
    const row = requireExactKeys(raw, ["assetId", "cause", "summary", "evidenceRefs"], "improvement attribution");
    if (typeof row.assetId !== "string" || seenImprovementIds.has(row.assetId)) {
      throw new Error("improvement attribution asset IDs must be unique strings");
    }
    seenImprovementIds.add(row.assetId);
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) {
      throw new Error(`improvement attribution ${row.assetId} requires a summary`);
    }
    requireEvidenceRefs(row.evidenceRefs, `improvement attribution ${row.assetId}`);
    const expected = expectedById.get(row.assetId);
    const expectedCause = expected?.causes.length === 2 ? "both" : expected?.causes[0];
    if (!expected?.valid || row.cause !== expectedCause) improvementsValid = false;
  }
  if ([...expectedById.keys()].some((assetId) => !seenImprovementIds.has(assetId))) improvementsValid = false;

  const movementKey = (row) => `${row.fromResultDigest}\u0000${row.toResultDigest}\u0000${row.assetId}`;
  const expectedMovements = new Map(movements.map((entry) => [movementKey(entry), entry]));
  const explainedMovementKeys = new Set();
  let movementsValid = value.captureMovements.length === expectedMovements.size;
  for (const raw of value.captureMovements) {
    const row = requireExactKeys(
      raw,
      ["assetId", "fromResultDigest", "toResultDigest", "summary", "evidenceRefs"],
      "capture movement attribution",
    );
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) {
      throw new Error(`capture movement attribution ${row.assetId} requires a summary`);
    }
    requireEvidenceRefs(row.evidenceRefs, `capture movement attribution ${row.assetId}`);
    const key = movementKey(row);
    if (explainedMovementKeys.has(key)) throw new Error("capture movement attributions must be unique");
    explainedMovementKeys.add(key);
    if (!expectedMovements.get(key)?.scoreBearingInputChanged) movementsValid = false;
  }
  if ([...expectedMovements.keys()].some((key) => !explainedMovementKeys.has(key))) movementsValid = false;
  return {
    provided: true,
    improvementRows: value.improvements.length,
    captureMovementRows: value.captureMovements.length,
    explainedMovementKeys,
    passed: decomposition.passed && improvementsValid && movementsValid,
  };
}

export function analyzeV9Calibration(baseline, candidate, fridayEvidence = {}) {
  assertReplay(baseline, "baseline");
  assertReplay(candidate, "candidate");
  reproduceCandidateReplay(candidate, "candidate");
  const baselineDistribution = summarizeDistribution(baseline);
  const distribution = summarizeDistribution(candidate);
  const candidateById = new Map(candidate.pipeline.candidate.cards.map((card) => [card.id, card]));
  const baselineById = new Map(baseline.pipeline.candidate.cards.map((card) => [card.id, card]));
  const realACandidates = realACandidatesForReplay(candidate);
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
  const changes = changesFromBaseline(baseline, candidate);
  const captureSeries = validateFreshCaptureSeries(
    fridayEvidence.freshCaptures,
    candidate.pipeline.fixedInput.activeAssetIds,
    realA.map((entry) => entry.assetId),
  );
  const composite = evaluateCompositeReplay(fridayEvidence.composite);
  const decomposition = causalDecomposition(baseline, candidate, changes);
  const attribution = validateCausalAttribution(
    fridayEvidence.causalAttribution,
    baseline,
    candidate,
    decomposition,
    captureSeries.movementsOverThree,
  );
  const movementKey = (row) => `${row.fromResultDigest}\u0000${row.toResultDigest}\u0000${row.assetId}`;
  const unexplainedMovements = captureSeries.movementsOverThree.filter(
    (movement) => !attribution.explainedMovementKeys.has(movementKey(movement)),
  );
  const threeFreshCaptures =
    captureSeries.providedCount === 3 &&
    captureSeries.distinctAndOrdered &&
    captureSeries.identitiesMatch &&
    captureSeries.assetSetsMatch &&
    captureSeries.allInputsFresh;
  const gates = {
    candidateReproduced: true,
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
    // D1-D6 (derivation §4) replace the retired legacy distribution gates
    // `fAtMost180`, `cMinusOrBetterAtLeast35`, `bMinusOrBetterAtLeast5`,
    // `largestPillarTupleAtMost20Pct`, `largestScoreBucketAtMost15Pct` and
    // `scoreIqrAtLeast12`. Thresholds are provisional — see
    // DISTRIBUTION_GATE_THRESHOLDS.
    ...distributionGates(distribution.distributionMetrics),
    adverseControlsUnchanged: adverseControls.every((control) => !control.lifted),
    compositeAPlus: composite.passed,
    threeFreshCaptures,
    repeatedRealA: threeFreshCaptures && captureSeries.repeatedRealAIds.length > 0,
    captureStability: threeFreshCaptures && unexplainedMovements.length === 0,
    causalAttribution: attribution.passed,
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
    changes,
    fridayEvidence: {
      composite,
      freshCaptures: {
        providedCount: captureSeries.providedCount,
        baseInputGenerationIds: captureSeries.baseInputGenerationIds,
        resultDigests: captureSeries.resultDigests,
        distinctAndOrdered: captureSeries.distinctAndOrdered,
        identitiesMatch: captureSeries.identitiesMatch,
        assetSetsMatch: captureSeries.assetSetsMatch,
        allInputsFresh: captureSeries.allInputsFresh,
        repeatedRealAIds: captureSeries.repeatedRealAIds,
        movementsOverThree: captureSeries.movementsOverThree,
        unexplainedMovements,
      },
      causalAttribution: {
        provided: attribution.provided,
        improvementRows: attribution.improvementRows ?? 0,
        captureMovementRows: attribution.captureMovementRows ?? 0,
        passed: attribution.passed,
        decomposition,
      },
    },
    uncertaintyLedger: uncertaintyLedger(candidate),
  };
}

function parseArgs(argv) {
  const usage =
    "Usage: npm run safety-score-v9:calibration-analysis -- --baseline <replay> --candidate <replay> " +
    "[--composite <replay>] [--fresh-capture <replay> ... exactly 3] [--attribution <json>] [--output <json>]";
  if (argv.includes("--help")) {
    process.stdout.write(`${usage}\n`);
    return null;
  }
  const parsed = {
    baseline: null,
    candidate: null,
    composite: null,
    attribution: null,
    output: null,
    freshCaptures: [],
  };
  const keys = new Map([
    ["--baseline", "baseline"],
    ["--candidate", "candidate"],
    ["--composite", "composite"],
    ["--attribution", "attribution"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = argv[index + 1];
    if (option === "--fresh-capture") {
      if (!next || next.startsWith("--")) throw new Error(`${option} requires a path\n${usage}`);
      parsed.freshCaptures.push(next);
      index += 1;
      continue;
    }
    const key = keys.get(option);
    if (!key) throw new Error(`Unknown option ${option}\n${usage}`);
    if (!next || next.startsWith("--")) throw new Error(`${option} requires a path\n${usage}`);
    if (parsed[key] !== null) throw new Error(`${option} may be supplied only once\n${usage}`);
    parsed[key] = next;
    index += 1;
  }
  if (!parsed.baseline || !parsed.candidate) throw new Error(usage);
  return parsed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  if (args) {
    const report = analyzeV9Calibration(
      JSON.parse(readFileSync(args.baseline, "utf8")),
      JSON.parse(readFileSync(args.candidate, "utf8")),
      {
        ...(args.composite ? { composite: JSON.parse(readFileSync(args.composite, "utf8")) } : {}),
        ...(args.freshCaptures.length > 0
          ? { freshCaptures: args.freshCaptures.map((path) => JSON.parse(readFileSync(path, "utf8"))) }
          : {}),
        ...(args.attribution ? { causalAttribution: JSON.parse(readFileSync(args.attribution, "utf8")) } : {}),
      },
    );
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) writeFileSync(args.output, serialized, "utf8");
    else process.stdout.write(serialized);
  }
}
