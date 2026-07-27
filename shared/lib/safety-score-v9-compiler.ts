import { resolveMechanismArchetype } from "./classification/resolve-mechanism-archetype";
import {
  conservativeImplementationDate,
  resolveEffectiveImplementationLaunchDate,
} from "./classification/resolve-implementation-launch-date";
import {
  CompiledV9AssetInputSchema,
  HistoricalV9FactsInputSchema,
  type CompiledV9AssetInput,
  type HistoricalV9FactsInput,
  type V9EvidenceLevel,
  type V9EvidenceReference,
  type V9PillarEvidence,
  type V9ReasonCode,
  type V9StructuralSignal,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../types/safety-score-v9";
import type { DexLiquidityData } from "../types/market";
import type { ReportCard } from "../types/report-cards";
import type { StablecoinLink, StablecoinMeta } from "../types/core";
import type { ExitRouteObservation } from "../types/exit-route";
import { isDexExitRouteCoverageWithinRouteBudget } from "./p4-exit-route-capacity";
import { isExitRouteObservationScoreEligible } from "./redemption-backstop-scoring";
import { collectCriticalControlIdentities, type CriticalControlIdentityOccurrence } from "./control-identities";
import { mergeExitRouteObservations } from "./safety-score-v9/exit-observation-set";
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "./safety-score-v9/facts";
import { assertV9ValidatedPolicyEnvelope, normalizeV9UnresolvedFacts } from "./safety-score-v9/policy";
import { scoreV9ReserveExposureClassification } from "./safety-score-v9/backing";

export interface V9CommonControlDomain {
  assetIds: readonly string[];
  paths: readonly CriticalControlIdentityOccurrence["path"][];
}

type V9DexLiquidityEvidenceRow = Pick<
  DexLiquidityData,
  "updatedAt" | "exitRouteObservations" | "exitRouteObservationCoverage"
>;

export interface CompileV9AssetOptions {
  policy: V9ValidatedPolicyEnvelope;
  asOf: string;
  compiledAt: string;
  methodologyVersion: string;
  reportCardObservedAt?: string;
  metaById: ReadonlyMap<string, StablecoinMeta>;
  dexLiquidityById?: ReadonlyMap<string, V9DexLiquidityEvidenceRow>;
  exitRouteObservationsById?: ReadonlyMap<string, readonly ExitRouteObservation[]>;
  dexExitObservationMaxAgeSec?: number | null;
  liveRedemptionExitObservationMaxAgeSec?: number | null;
  commonControlDomains?: ReadonlyMap<string, V9CommonControlDomain>;
}

function unresolved(code: V9ReasonCode, reason: string, critical: boolean, path?: string): V9UnresolvedFact {
  return {
    code,
    reason,
    critical,
    ...(path ? { path } : {}),
    responsibility: V9_LEGACY_RESPONSIBILITY_BY_REASON[code],
  };
}

function parseTimestamp(value: string | number | undefined): Date | null {
  if (value == null) return null;
  const candidate =
    typeof value === "number"
      ? new Date(value * 1_000)
      : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(candidate.getTime()) ? candidate : null;
}

function toIsoTimestamp(value: string | number | undefined, asOf: string): string | null {
  const candidate = parseTimestamp(value);
  if (candidate === null || candidate.getTime() > Date.parse(asOf)) return null;
  return candidate.toISOString();
}

function addFutureDatedFact(
  gaps: V9UnresolvedFact[],
  value: string | number | undefined,
  asOf: string,
  path: string,
  label: string,
): void {
  const candidate = parseTimestamp(value);
  if (candidate === null || candidate.getTime() <= Date.parse(asOf)) return;
  gaps.push(
    unresolved(
      "future-dated-input-fact",
      `${label} is dated ${candidate.toISOString()}, after the compiler as-of ${asOf}.`,
      true,
      path,
    ),
  );
}

function artifactEvidence(options: CompileV9AssetOptions, note: string): V9EvidenceReference {
  return {
    sourceId: `pharos-runtime-v${options.methodologyVersion}`,
    observedAt: options.reportCardObservedAt ?? options.asOf,
    note,
  };
}

function reviewEvidence(args: {
  assetId: string;
  path: string;
  observedAt?: string;
  links?: readonly StablecoinLink[];
  note: string;
  options: CompileV9AssetOptions;
}): V9EvidenceReference[] {
  const observedAt = toIsoTimestamp(args.observedAt, args.options.asOf);
  if (observedAt === null) return [];
  const links = args.links?.length ? args.links : [undefined];
  return links.map((link, index) => ({
    sourceId: `metadata:${args.assetId}:${args.path}:${index + 1}`,
    observedAt,
    ...(link ? { url: link.url } : {}),
    note: link ? `${args.note} Source: ${link.label}.` : args.note,
  }));
}

function uniqueEvidence(references: readonly V9EvidenceReference[]): V9EvidenceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.sourceId}|${reference.url ?? ""}|${reference.observedAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pillarEvidence(args: {
  policy: V9ValidatedPolicyEnvelope;
  score: number | null;
  evidenceLevel: V9EvidenceLevel;
  evidence: readonly V9EvidenceReference[];
  unresolved: V9UnresolvedFact[];
  signals?: string[];
}): V9PillarEvidence {
  const evidence = uniqueEvidence(args.evidence);
  const normalizedUnresolved = normalizeV9UnresolvedFacts(args.policy, args.unresolved);
  const hasCriticalGap = normalizedUnresolved.some((fact) => fact.critical);
  const score = evidence.length === 0 || hasCriticalGap ? null : args.score;
  const scoreUnresolved =
    score === null && !hasCriticalGap
      ? normalizeV9UnresolvedFacts(args.policy, [
          ...normalizedUnresolved,
          unresolved("missing-pillar-evidence", "No dated source supports the derived pillar facts.", true),
        ])
      : normalizedUnresolved;
  return {
    score,
    evidenceLevel: score === null ? "insufficient" : args.evidenceLevel,
    evidence,
    unresolved: scoreUnresolved,
    signals: args.signals ?? [],
  };
}

/**
 * Convert fuzzy catalog dates to a conservative deterministic lower bound for
 * track record: year-only means year end and month-only means month end.
 */
export function resolveConservativeImplementationDate(value: string | undefined): string | null {
  return value ? conservativeImplementationDate(value, "9999-12-31") : null;
}

export function computeConservativeTrackRecordMonths(launchDate: string | null, asOf: string): number {
  if (launchDate === null) return 0;
  const start = new Date(`${launchDate}T00:00:00Z`);
  const end = new Date(asOf);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return 0;
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function compileBackingPillar(
  meta: StablecoinMeta,
  card: ReportCard,
  options: CompileV9AssetOptions,
  structuralSignals: V9StructuralSignal[],
): V9PillarEvidence {
  const policy = options.policy.policy.semantic.backing;
  const gaps: V9UnresolvedFact[] = [];
  const reserves = meta.reserves ?? [];
  const review = meta.reserveReview;
  addFutureDatedFact(gaps, review?.reviewedAt, options.asOf, "reserveReview.reviewedAt", "Reserve review");
  addFutureDatedFact(
    gaps,
    review?.compositionAsOf,
    options.asOf,
    "reserveReview.compositionAsOf",
    "Reserve composition",
  );
  addFutureDatedFact(
    gaps,
    meta.proofOfReserves?.latestReport?.publishedAt,
    options.asOf,
    "proofOfReserves.latestReport.publishedAt",
    "Assurance report publication",
  );
  addFutureDatedFact(
    gaps,
    meta.proofOfReserves?.latestReport?.periodEnd,
    options.asOf,
    "proofOfReserves.latestReport.periodEnd",
    "Assurance report period end",
  );
  addFutureDatedFact(
    gaps,
    meta.custodyProfile?.reviewedAt,
    options.asOf,
    "custodyProfile.reviewedAt",
    "Custody review",
  );
  addFutureDatedFact(
    gaps,
    meta.dependencyReview?.reviewedAt,
    options.asOf,
    "dependencyReview.reviewedAt",
    "Dependency review",
  );
  const reviewRefs = review
    ? reviewEvidence({
        assetId: meta.id,
        path: "reserveReview",
        observedAt: review.reviewedAt,
        links: review.sources,
        note: `Reviewed ${review.scope} reserve envelope (${review.confidence}).`,
        options,
      })
    : [];
  const proofRefs = meta.proofOfReserves?.latestReport
    ? reviewEvidence({
        assetId: meta.id,
        path: "proofOfReserves.latestReport",
        observedAt: meta.proofOfReserves.latestReport.publishedAt,
        links: meta.proofOfReserves.latestReport.sources,
        note: `Latest ${meta.proofOfReserves.latestReport.scope} assurance report.`,
        options,
      })
    : [];
  const custodyRefs = meta.custodyProfile
    ? reviewEvidence({
        assetId: meta.id,
        path: "custodyProfile",
        observedAt: meta.custodyProfile.reviewedAt,
        links: meta.custodyProfile.sources,
        note: `Reviewed custody profile (${meta.custodyProfile.confidence}).`,
        options,
      })
    : [];
  const dependencyRefs = meta.dependencyReview
    ? reviewEvidence({
        assetId: meta.id,
        path: "dependencyReview",
        observedAt: meta.dependencyReview.reviewedAt,
        links: meta.dependencyReview.sources,
        note: `Reviewed ${meta.dependencyReview.relationships.length} dependency relationships.`,
        options,
      })
    : [];

  if (reserves.length === 0) {
    gaps.push(
      unresolved("missing-reserve-composition", "No structured reserve composition is available.", true, "reserves"),
    );
  }
  if (!review) {
    gaps.push(
      unresolved(
        "unreviewed-reserve-envelope",
        "Reserve composition lacks a dated review envelope and known-unknown exposure.",
        true,
        "reserveReview",
      ),
    );
  } else {
    if (review.scope !== "full-composition") {
      gaps.push(
        unresolved(
          "partial-reserve-review",
          `Reserve review scope is ${review.scope}; the complete backing envelope is not established.`,
          true,
          "reserveReview.scope",
        ),
      );
    }
    if (review.knownUnknownExposurePct >= policy.structural.materialExposureShare * 100) {
      gaps.push(
        unresolved(
          "material-unknown-reserve-exposure",
          `${review.knownUnknownExposurePct}% of reserve exposure remains known-unknown.`,
          true,
          "reserveReview.knownUnknownExposurePct",
        ),
      );
    } else if (review.knownUnknownExposurePct > 0) {
      gaps.push(
        unresolved(
          "bounded-unknown-reserve-exposure",
          `${review.knownUnknownExposurePct}% of reserve exposure remains known-unknown.`,
          false,
          "reserveReview.knownUnknownExposurePct",
        ),
      );
    }
  }

  for (const [index, slice] of reserves.entries()) {
    if (slice.pct < policy.structural.materialExposureShare * 100) continue;
    const missing = [
      ...(slice.assetClass ? [] : ["assetClass"]),
      ...(slice.riskFactors?.length ? [] : ["riskFactors"]),
      ...(slice.liquidityHorizon ? [] : ["liquidityHorizon"]),
      ...(slice.issuerOrObligor ? [] : ["issuerOrObligor"]),
    ];
    if (missing.length === 0) continue;
    gaps.push(
      unresolved(
        "material-reserve-slice-unstructured",
        `${slice.name} (${slice.pct}%) lacks ${missing.join(", ")}.`,
        true,
        `reserves.${index}`,
      ),
    );
  }

  if (meta.flags.rwa && !meta.custodyProfile) {
    gaps.push(
      unresolved("missing-custody-profile", "RWA backing has no structured custody profile.", true, "custodyProfile"),
    );
  }
  if (meta.flags.rwa && !meta.proofOfReserves?.latestReport) {
    gaps.push(
      unresolved(
        "missing-latest-assurance-report",
        "RWA backing has no structured latest assurance-report record.",
        false,
        "proofOfReserves.latestReport",
      ),
    );
  }
  if ((meta.dependencies?.length ?? 0) > 0 && !meta.dependencyReview) {
    gaps.push(
      unresolved(
        "unreviewed-dependency-relationships",
        "Declared stablecoin dependencies lack a dated relationship/provenance review.",
        true,
        "dependencyReview",
      ),
    );
  }

  const diagnostics = card.dimensions.dependencyRisk.dependencyDiagnostics;
  const materialUnavailable =
    diagnostics?.contributions.filter(
      (entry) => !entry.available && entry.normalizedWeight >= policy.structural.materialExposureShare,
    ) ?? [];
  if (materialUnavailable.length > 0) {
    gaps.push(
      unresolved(
        "material-dependency-unavailable",
        `Material upstream ratings are unavailable: ${materialUnavailable
          .map((entry) => entry.id)
          .sort()
          .join(", ")}.`,
        true,
        "dependencies",
      ),
    );
    structuralSignals.push({
      kind: "critical-dependency",
      severity: "high",
      responsibility: "integration-missing",
      reason: `Material upstream ratings are unavailable: ${materialUnavailable
        .map((entry) => entry.id)
        .sort()
        .join(", ")}.`,
      materialSharePct: materialUnavailable.reduce((sum, entry) => sum + entry.normalizedWeight * 100, 0),
      failureDomainKeys: materialUnavailable.map((entry) => `dependency:${entry.id}`),
      evidence: dependencyRefs.length ? dependencyRefs : [artifactEvidence(options, "Runtime dependency diagnostics.")],
    });
  } else if ((diagnostics?.unavailableIds.length ?? 0) > 0) {
    gaps.push(
      unresolved(
        "nonmaterial-dependency-unavailable",
        `Non-material upstream ratings are unavailable: ${diagnostics!.unavailableIds.slice().sort().join(", ")}.`,
        false,
        "dependencies",
      ),
    );
  }

  const reserveScore =
    reserves.length === 0
      ? null
      : Math.round(
          reserves.reduce(
            (total, slice) =>
              total +
              slice.pct *
                scoreV9ReserveExposureClassification(
                  {
                    assetClass: slice.assetClass ?? null,
                    liquidityHorizon: slice.liquidityHorizon ?? null,
                    maturityDaysMax: slice.maturityDaysMax ?? null,
                  },
                  options.policy,
                ),
            0,
          ) / 100,
        );
  const score = reserveScore;

  if (meta.flags.backing === "algorithmic") {
    const signal = policy.structural.algorithmic.signal;
    structuralSignals.push({
      kind: signal.kind,
      severity: signal.severity,
      reason: "Backing depends on an algorithmic or reflexive stabilization mechanism.",
      failureDomainKeys: [`mechanism:${meta.id}`],
      evidence: reviewRefs,
    });
  }
  const unsafeReserves = reserves.filter(
    (slice) =>
      slice.pct >= policy.structural.materialExposureShare * 100 &&
      scoreV9ReserveExposureClassification(
        {
          assetClass: slice.assetClass ?? null,
          liquidityHorizon: slice.liquidityHorizon ?? null,
          maturityDaysMax: slice.maturityDaysMax ?? null,
        },
        options.policy,
      ) <= policy.structural.unsafeExposureQuality,
  );
  if (unsafeReserves.length > 0) {
    const signal = policy.structural.unsafeExposureSignal;
    structuralSignals.push({
      kind: signal.kind,
      severity: signal.severity,
      reason: "A material reviewed reserve exposure has weak classification-derived backing quality.",
      materialSharePct: unsafeReserves.reduce((sum, slice) => sum + slice.pct, 0),
      failureDomainKeys: unsafeReserves.map(
        (slice) => `reserve:${slice.coinId ?? slice.issuerOrObligor ?? slice.name}`,
      ),
      evidence: reviewRefs,
    });
  }
  const speculativeCreditReserves = reserves.filter(
    (slice) => slice.assetClass === "private-credit" && slice.pct >= policy.structural.materialExposureShare * 100,
  );
  if (speculativeCreditReserves.length > 0) {
    const signal = policy.structural.speculativeCreditSignal;
    structuralSignals.push({
      kind: signal.kind,
      severity: signal.severity,
      reason: "The reviewed reserve mechanism is exposed to private or speculative credit performance.",
      materialSharePct: speculativeCreditReserves.reduce((sum, slice) => sum + slice.pct, 0),
      failureDomainKeys: speculativeCreditReserves.map((slice) => `credit:${slice.issuerOrObligor ?? slice.name}`),
      evidence: reviewRefs,
    });
  }

  const evidence = [...reviewRefs, ...proofRefs, ...custodyRefs, ...dependencyRefs];
  const evidenceLevel: V9EvidenceLevel =
    review?.confidence === "verified" &&
    (!meta.flags.rwa || meta.custodyProfile?.confidence === "verified") &&
    (!meta.flags.rwa || meta.proofOfReserves?.latestReport?.liabilityReconciliation === "full")
      ? "strong"
      : reviewRefs.length > 0
        ? "adequate"
        : "insufficient";
  return pillarEvidence({
    policy: options.policy,
    score,
    evidenceLevel,
    evidence,
    unresolved: gaps,
    signals: reserves.map(
      (slice) =>
        `reserve:${slice.pct}:${slice.assetClass ?? "unknown"}:${slice.liquidityHorizon ?? "unknown"}:${slice.maturityDaysMax ?? "unknown"}`,
    ),
  });
}

function observationEvidence(
  meta: StablecoinMeta,
  observation: ExitRouteObservation,
  options: CompileV9AssetOptions,
): V9EvidenceReference | null {
  const observedAt = toIsoTimestamp(observation.observedAt, options.asOf);
  if (observedAt === null) return null;
  return {
    sourceId: `exit-route:${meta.id}:${observation.routeId}`,
    observedAt,
    note: `${observation.routeFamily}; ${observation.evidenceKind}; ${observation.requestedNotionalUsd} USD at ${observation.maxCostBps} bps/${observation.settlementHorizonSec}s.`,
  };
}

function isDexRouteObservation(observation: ExitRouteObservation): boolean {
  return observation.routeFamily === "dex-amm" || observation.routeFamily === "dex-orderbook";
}

function compileExitPillar(meta: StablecoinMeta, options: CompileV9AssetOptions): V9PillarEvidence {
  const row = options.dexLiquidityById?.get(meta.id);
  const suppliedObservations = options.exitRouteObservationsById?.get(meta.id);
  const gaps: V9UnresolvedFact[] = [];
  if (!row && !suppliedObservations) {
    gaps.push(
      unresolved(
        "missing-runtime-route-evidence",
        "No runtime route-observation row was supplied to the compiler.",
        true,
        "exitRouteObservations",
      ),
    );
    return pillarEvidence({
      policy: options.policy,
      score: null,
      evidenceLevel: "insufficient",
      evidence: [],
      unresolved: gaps,
    });
  }

  const suppliedDexObservations = suppliedObservations?.filter(isDexRouteObservation) ?? [];
  const suppliedRedemptionObservations =
    suppliedObservations?.filter((observation) => !isDexRouteObservation(observation)) ?? [];
  const observations = mergeExitRouteObservations(
    [...(row?.exitRouteObservations ?? []), ...suppliedDexObservations],
    suppliedRedemptionObservations,
    meta.id,
  );
  const exitObservationAsOfSec = Date.parse(options.asOf) / 1_000;
  const dexObservations = observations.filter(isDexRouteObservation);
  if (dexObservations.length > 0 && !isDexExitRouteCoverageWithinRouteBudget(row?.exitRouteObservationCoverage)) {
    gaps.push(
      unresolved(
        "incomplete-dex-route-coverage",
        "Retained DEX pools do not all have score-eligible exact route-capacity observations.",
        true,
        "exitRouteObservationCoverage",
      ),
    );
  }
  for (const [index, observation] of observations.entries()) {
    addFutureDatedFact(
      gaps,
      observation.observedAt,
      options.asOf,
      `exitRouteObservations.${index}.observedAt`,
      `Exit-route observation ${observation.routeId}`,
    );
  }
  const eligibleObservations = observations.filter((observation) => {
    const lane = isDexRouteObservation(observation) ? "dex" : "redemption";
    return (
      observation.executableUsd > 0 &&
      isExitRouteObservationScoreEligible(observation, lane, {
        exitObservationAsOfSec,
        dexExitObservationMaxAgeSec: options.dexExitObservationMaxAgeSec,
        liveRedemptionExitObservationMaxAgeSec: options.liveRedemptionExitObservationMaxAgeSec,
      })
    );
  });
  const supported: Array<{ observation: ExitRouteObservation; evidence: V9EvidenceReference }> = [];
  for (const observation of eligibleObservations) {
    const reference = observationEvidence(meta, observation, options);
    if (reference) supported.push({ observation, evidence: reference });
  }
  const unresolvedOutputRoutes = supported.filter(({ observation }) =>
    ["unresolved-asset", "unresolved-basket", "unknown"].includes(observation.output.kind),
  );
  if (unresolvedOutputRoutes.length > 0) {
    gaps.push(
      unresolved(
        "unresolved-exit-output",
        `${unresolvedOutputRoutes.length} otherwise eligible route(s) exit into an unresolved asset or basket and are excluded.`,
        false,
        "exitRouteObservations.output",
      ),
    );
  }
  const scoreableSupported = supported.filter(
    ({ observation }) => !["unresolved-asset", "unresolved-basket", "unknown"].includes(observation.output.kind),
  );
  if (scoreableSupported.length === 0) {
    const status = row?.exitRouteObservationCoverage?.status ?? "unknown";
    gaps.push(
      unresolved(
        status === "unsupported" ? "unsupported-same-notional-route" : "missing-same-notional-route",
        status === "unsupported"
          ? "Retained exit venues are outside the exact route-capacity capability matrix."
          : "No fresh score-eligible same-notional route observation is available.",
        true,
        "exitRouteObservations",
      ),
    );
    return pillarEvidence({
      policy: options.policy,
      score: null,
      evidenceLevel: "insufficient",
      evidence: [],
      unresolved: gaps,
    });
  }

  const requestKeys = new Set(
    scoreableSupported.map(
      ({ observation }) =>
        `${observation.requestedNotionalUsd}|${observation.maxCostBps}|${observation.settlementHorizonSec}`,
    ),
  );
  if (requestKeys.size > 1) {
    gaps.push(
      unresolved(
        "incomparable-route-requests",
        "Eligible observations do not share a common notional, cost bound, and settlement horizon.",
        true,
        "exitRouteObservations",
      ),
    );
  }
  const commonModes = scoreableSupported.map(({ observation }) => new Set(observation.commonModeKeys));
  const sharedCommonModes = [...(commonModes[0] ?? new Set<string>())].filter((key) =>
    commonModes.every((route) => route.has(key)),
  );
  if (scoreableSupported.length > 1 && sharedCommonModes.length > 0) {
    gaps.push(
      unresolved(
        "correlated-exit-routes",
        `Every eligible exit route shares: ${sharedCommonModes.sort().join(", ")}.`,
        false,
        "exitRouteObservations.commonModeKeys",
      ),
    );
  }
  const derivedScore = Math.round(
    Math.max(...scoreableSupported.map(({ observation }) => observation.completionRatio * 100)),
  );
  const score = derivedScore;
  const evidenceLevel: V9EvidenceLevel = scoreableSupported.some(
    ({ observation }) =>
      observation.confidence === "high" &&
      options.policy.policy.semantic.exit.strongEvidenceKinds.includes(observation.evidenceKind),
  )
    ? "strong"
    : scoreableSupported.some(
          ({ observation }) => observation.confidence === "high" || observation.confidence === "medium",
        )
      ? "adequate"
      : "limited";
  return pillarEvidence({
    policy: options.policy,
    score,
    evidenceLevel,
    evidence: scoreableSupported.map((entry) => entry.evidence),
    unresolved: gaps,
    signals: scoreableSupported.map(
      ({ observation }) =>
        `route:${observation.routeFamily}:${observation.output.kind}:${observation.commonModeKeys.slice().sort().join("+") || "independent"}`,
    ),
  });
}

function compileOracleControlPath(args: {
  meta: StablecoinMeta;
  archetype: string | null;
  options: CompileV9AssetOptions;
  gaps: V9UnresolvedFact[];
  pathScores: number[];
  evidence: V9EvidenceReference[];
  signals: string[];
  structuralSignals: V9StructuralSignal[];
}): void {
  const { meta, archetype, options, gaps, pathScores, evidence, signals, structuralSignals } = args;
  if (archetype !== "cdp") return;
  const oracleTierQuality = options.policy.policy.semantic.control.oracleTierQuality;

  const oracle = meta.oracleRisk;
  if (!oracle) {
    gaps.push(
      unresolved("missing-oracle-profile", "CDP has no reviewed oracle/liquidation profile.", true, "oracleRisk"),
    );
    return;
  }

  addFutureDatedFact(gaps, oracle.reviewedAt, options.asOf, "oracleRisk.reviewedAt", "Oracle review");
  const branchApplicability = oracle.branchApplicability;
  if (branchApplicability) {
    addFutureDatedFact(
      gaps,
      branchApplicability.reviewedAt,
      options.asOf,
      "oracleRisk.branchApplicability.reviewedAt",
      "Oracle branch-applicability review",
    );
  }
  if (!branchApplicability || branchApplicability.disposition === "unresolved") {
    gaps.push(
      unresolved(
        "unresolved-oracle-branch-applicability",
        "CDP oracle review does not establish whether market-specific oracle and liquidation branches are required.",
        true,
        "oracleRisk.branchApplicability",
      ),
    );
  } else if (
    branchApplicability.disposition === "branches-required" &&
    (oracle.branchModel !== "multi-branch" || !oracle.branches?.length)
  ) {
    gaps.push(
      unresolved(
        "missing-required-oracle-branches",
        "CDP oracle review requires market-specific branches but no complete branch inventory is available.",
        true,
        "oracleRisk.branches",
      ),
    );
  }
  const oracleEvidence = reviewEvidence({
    assetId: meta.id,
    path: "oracleRisk",
    observedAt: oracle.reviewedAt,
    links: oracle.sources,
    note: `Reviewed ${oracle.branchModel ?? "unspecified"} oracle profile (${oracle.confidence ?? "unknown"}).`,
    options,
  });
  evidence.push(...oracleEvidence);
  if (branchApplicability) {
    evidence.push(
      ...reviewEvidence({
        assetId: meta.id,
        path: "oracleRisk.branchApplicability",
        observedAt: branchApplicability.reviewedAt,
        links: branchApplicability.sources,
        note: `Reviewed oracle branch applicability (${branchApplicability.disposition}).`,
        options,
      }),
    );
  }
  const branchScores =
    branchApplicability?.disposition === "branches-required"
      ? (oracle.branches ?? []).map((branch) => oracleTierQuality[branch.tier])
      : [];
  pathScores.push(branchScores.length ? Math.min(...branchScores) : oracleTierQuality[oracle.tier]);
  signals.push(`oracle:${oracle.branchModel ?? "unspecified"}:${oracle.tier}`);
  if (!oracle.reviewedAt || !oracle.reviewer || !oracle.confidence || oracle.confidence === "unknown") {
    gaps.push(
      unresolved(
        "unreviewed-oracle-profile",
        "Oracle profile lacks complete review provenance or confidence.",
        true,
        "oracleRisk",
      ),
    );
  }
  if (oracle.branchModel === "multi-branch") {
    for (const [index, branch] of (oracle.branches ?? []).entries()) {
      const missing = [
        ...(branch.feeds?.length ? [] : ["feeds"]),
        ...(branch.collateralParameters?.length ? [] : ["collateralParameters"]),
        ...(branch.liquidationMechanism ? [] : ["liquidationMechanism"]),
        ...(branch.shutdownOrBadDebtBehavior ? [] : ["shutdownOrBadDebtBehavior"]),
      ];
      if (missing.length > 0) {
        gaps.push(
          unresolved(
            "incomplete-oracle-liquidation-branch",
            `${branch.label} lacks ${missing.join(", ")}.`,
            true,
            `oracleRisk.branches.${index}`,
          ),
        );
      }
      if (branch.tier === "single-source-or-laggy" || branch.tier === "opaque-or-unknown") {
        structuralSignals.push({
          kind: "weak-oracle-branch",
          severity: branch.tier === "opaque-or-unknown" ? "critical" : "high",
          responsibility: branch.tier === "opaque-or-unknown" ? "issuer-undisclosed" : "measured-adverse",
          reason: `${branch.label} resolves to ${branch.tier}.`,
          failureDomainKeys: branch.failureDomainKeys ?? [`oracle:${meta.id}:${branch.id}`],
          evidence: oracleEvidence,
        });
      }
    }
  } else if (oracle.tier === "single-source-or-laggy" || oracle.tier === "opaque-or-unknown") {
    structuralSignals.push({
      kind: "weak-oracle-branch",
      severity: oracle.tier === "opaque-or-unknown" ? "critical" : "high",
      responsibility: oracle.tier === "opaque-or-unknown" ? "issuer-undisclosed" : "measured-adverse",
      reason: `Reviewed oracle profile resolves to ${oracle.tier}.`,
      failureDomainKeys: [`oracle:${meta.id}`],
      evidence: oracleEvidence,
    });
  }
}

function compileControlPillar(
  meta: StablecoinMeta,
  card: ReportCard,
  archetype: string | null,
  options: CompileV9AssetOptions,
  structuralSignals: V9StructuralSignal[],
): V9PillarEvidence {
  const controlPolicy = options.policy.policy.semantic.control;
  const gaps: V9UnresolvedFact[] = [];
  const pathScores: number[] = [];
  const evidence: V9EvidenceReference[] = [];
  const signals: string[] = [];
  const mint = meta.mintAuthority;
  addFutureDatedFact(
    gaps,
    mint?.review.reviewedAt,
    options.asOf,
    "mintAuthority.review.reviewedAt",
    "Mint-authority review",
  );
  for (const [index, control] of (mint?.controls ?? []).entries()) {
    addFutureDatedFact(
      gaps,
      control.observedAt,
      options.asOf,
      `mintAuthority.controls.${index}.observedAt`,
      `Mint-authority control ${control.label}`,
    );
  }
  for (const [index, incident] of (mint?.mintIncidents ?? []).entries()) {
    if (incident.status !== "active") continue;
    addFutureDatedFact(
      gaps,
      incident.date,
      options.asOf,
      `mintAuthority.mintIncidents.${index}.date`,
      "Active mint-authority incident",
    );
  }

  if (!mint) {
    gaps.push(
      unresolved("missing-mint-authority", "No reviewed mint-authority path is available.", true, "mintAuthority"),
    );
  } else {
    const mintEvidence = reviewEvidence({
      assetId: meta.id,
      path: "mintAuthority.review",
      observedAt: mint.review.reviewedAt,
      links: mint.review.sources,
      note: `Reviewed ${mint.mintPath} mint path (${mint.confidence}).`,
      options,
    });
    evidence.push(...mintEvidence);
    signals.push(`mint:${mint.mintPath}:${mint.authorityPosture}`);
    if (mint.review.disposition === "unresolved" || mint.confidence === "unknown") {
      gaps.push(
        unresolved(
          "unresolved-mint-authority",
          mint.review.unresolvedQuestions?.join("; ") || "Mint authority review is unresolved.",
          true,
          "mintAuthority.review",
        ),
      );
    } else {
      pathScores.push(controlPolicy.mintPostureQuality[mint.authorityPosture]);
    }
    for (const [index, question] of (mint.review.unresolvedQuestions ?? []).entries()) {
      gaps.push(
        unresolved("mint-control-question", question, true, `mintAuthority.review.unresolvedQuestions.${index}`),
      );
    }
    for (const [index, control] of (mint.controls ?? []).entries()) {
      signals.push(
        `control:${control.role}:${control.authorityType}:${control.directMintAbility}:${
          (control.failureDomainKeys ?? []).slice().sort().join("+") || "domain-unresolved"
        }`,
      );
      if (control.directMintAbility === "unknown") {
        gaps.push(
          unresolved(
            "unknown-control-mint-ability",
            `${control.label} has unknown direct mint ability.`,
            true,
            `mintAuthority.controls.${index}.directMintAbility`,
          ),
        );
      }
      if (control.canRaiseCap === "unknown") {
        gaps.push(
          unresolved(
            "unknown-control-cap-authority",
            `${control.label} has unresolved authority to raise its mint cap.`,
            true,
            `mintAuthority.controls.${index}.canRaiseCap`,
          ),
        );
      }
      if (control.directMintAbility !== "none" && !(control.failureDomainKeys?.length || control.address)) {
        gaps.push(
          unresolved(
            "unresolved-control-identity",
            `${control.label} is mint-capable but has neither an address nor a reviewed failure-domain identity.`,
            true,
            `mintAuthority.controls.${index}`,
          ),
        );
      }
    }
    for (const incident of mint.mintIncidents ?? []) {
      if (incident.status !== "active") continue;
      const incidentEvidence = reviewEvidence({
        assetId: meta.id,
        path: `mintAuthority.mintIncidents.${incident.date}`,
        observedAt: incident.date,
        links: incident.sources,
        note: incident.summary,
        options,
      });
      structuralSignals.push({
        kind: "active-control-incident",
        severity: "critical",
        responsibility: "measured-adverse",
        reason: incident.summary,
        failureDomainKeys: [`mint:${meta.id}`],
        evidence: incidentEvidence,
      });
    }
    if (mint.authorityPosture === "unbounded-or-compromised") {
      structuralSignals.push({
        kind: "centralized-mint",
        severity: "critical",
        responsibility: "measured-adverse",
        reason: "Reviewed mint authority is unbounded or compromised.",
        failureDomainKeys: [`mint:${meta.id}`],
        evidence: mintEvidence,
      });
    } else if (mint.authorityPosture === "concentrated-admin") {
      structuralSignals.push({
        kind: "centralized-mint",
        severity: "moderate",
        responsibility: "measured-adverse",
        reason: "Reviewed mint authority is concentrated in one administrator path.",
        failureDomainKeys: [`mint:${meta.id}`],
        evidence: mintEvidence,
      });
    }

    const immutableMint =
      mint.mintPath === "immutable-user-collateralized" || mint.authorityPosture === "none-resolved";
    if (!mint.upgradeability && !immutableMint) {
      gaps.push(
        unresolved(
          "missing-upgradeability-review",
          "A privileged mint path has no structured upgradeability record.",
          true,
          "mintAuthority.upgradeability",
        ),
      );
      structuralSignals.push({
        kind: "unreviewed-upgrade",
        severity: "high",
        responsibility: "issuer-undisclosed",
        reason: "Mint-critical implementation upgradeability is not reviewed.",
        failureDomainKeys: [`upgrade:${meta.id}`],
        evidence: mintEvidence,
      });
    } else if (mint.upgradeability) {
      signals.push(`upgrade:${mint.upgradeability.model}:${mint.upgradeability.canChangeMintLogic}`);
      if (mint.upgradeability.canChangeMintLogic === "unknown") {
        gaps.push(
          unresolved(
            "unknown-upgrade-authority",
            "Whether the reviewed upgrade path can change mint logic is unknown.",
            true,
            "mintAuthority.upgradeability.canChangeMintLogic",
          ),
        );
      }
      if (mint.upgradeability.canChangeMintLogic === true && !mint.upgradeability.controlRef) {
        gaps.push(
          unresolved(
            "missing-upgrade-control",
            "Mint-critical upgradeability is not linked to a reviewed control.",
            true,
            "mintAuthority.upgradeability.controlRef",
          ),
        );
      }
    }
  }

  const oracleApplicable = archetype === "cdp";
  const oracle = meta.oracleRisk;
  compileOracleControlPath({
    meta,
    archetype,
    options,
    gaps,
    pathScores,
    evidence,
    signals,
    structuralSignals,
  });

  const bridge = meta.bridgeRouteRisk;
  const bridgeStatus = card.rawInputs.bridgeRouteMaterialityStatus;
  const selectedBridgeRouteId = card.rawInputs.bridgeRouteSelectedRouteId ?? null;
  const bridgeApplicable =
    selectedBridgeRouteId !== null ||
    (meta.contracts?.length ?? 0) > 1 ||
    (bridgeStatus != null && bridgeStatus !== "not-applicable");
  const selected = bridge?.routes?.find((route) => route.id === selectedBridgeRouteId);
  if (bridgeApplicable) {
    addFutureDatedFact(gaps, bridge?.reviewedAt, options.asOf, "bridgeRouteRisk.reviewedAt", "Bridge-route review");
    for (const [index, route] of (bridge?.routes ?? []).entries()) {
      addFutureDatedFact(
        gaps,
        route.observedAt,
        options.asOf,
        `bridgeRouteRisk.routes.${index}.observedAt`,
        `Bridge route ${route.id}`,
      );
    }
  }
  if (selectedBridgeRouteId !== null && !selected) {
    gaps.push(
      unresolved(
        "selected-bridge-route-missing",
        `Runtime-selected bridge route ${selectedBridgeRouteId} has no matching reviewed route.`,
        true,
        "rawInputs.bridgeRouteSelectedRouteId",
      ),
    );
  }
  if (bridgeApplicable && !bridge) {
    gaps.push(
      unresolved(
        "missing-bridge-routes",
        "Multi-deployment asset has no reviewed bridge routes.",
        true,
        "bridgeRouteRisk",
      ),
    );
  } else if (bridgeApplicable && bridge) {
    const bridgeEvidence = [
      ...reviewEvidence({
        assetId: meta.id,
        path: "bridgeRouteRisk",
        observedAt: bridge.reviewedAt,
        links: bridge.sources,
        note: `Reviewed bridge routes (${bridge.confidence}).`,
        options,
      }),
      ...(selected
        ? reviewEvidence({
            assetId: meta.id,
            path: `bridgeRouteRisk.routes.${selected.id}`,
            observedAt: selected.observedAt ?? bridge.reviewedAt,
            links: selected.sources,
            note: `Runtime-selected ${selected.scope} bridge route (${selected.reviewDisposition}).`,
            options,
          })
        : []),
    ];
    evidence.push(...bridgeEvidence);
    if (!bridge.routes?.length) {
      gaps.push(
        unresolved(
          "missing-bridge-route-rows",
          "Bridge profile has no exact deployment routes.",
          true,
          "bridgeRouteRisk.routes",
        ),
      );
    }
    if (bridgeStatus === "partial" || bridgeStatus === "unavailable" || bridgeStatus == null) {
      gaps.push(
        unresolved(
          "runtime-bridge-materiality-unavailable",
          `Runtime bridge materiality is ${bridgeStatus ?? "missing"}.`,
          true,
          "rawInputs.bridgeRouteMaterialityStatus",
        ),
      );
    }
    if (selected?.reviewDisposition === "unresolved") {
      gaps.push(
        unresolved(
          "selected-bridge-route-unresolved",
          selected.reviewNote ?? `Runtime-selected route ${selected.id} remains unresolved.`,
          true,
          "bridgeRouteRisk.routes",
        ),
      );
    }
    if (
      (card.rawInputs.bridgeRouteUnknownSupplyRatio ?? 0) >=
      options.policy.policy.semantic.materiality.deploymentMaterialSharePct / 100
    ) {
      gaps.push(
        unresolved(
          "material-bridge-supply-unmatched",
          `${Math.round((card.rawInputs.bridgeRouteUnknownSupplyRatio ?? 0) * 100)}% of deployment supply is not matched to a reviewed route.`,
          true,
          "rawInputs.bridgeRouteUnknownSupplyRatio",
        ),
      );
    }
    const tier = card.rawInputs.bridgeRouteEffectiveTier ?? bridge.tier;
    pathScores.push(controlPolicy.bridgeTierQuality[tier]);
    signals.push(`bridge:${tier}:${bridgeStatus ?? "missing"}`);
    const materialSharePct = (card.rawInputs.bridgeRouteMatchedSupplyRatio ?? 0) * 100;
    if (tier === "external-lock-mint" || tier === "opaque-or-unknown") {
      structuralSignals.push({
        kind: selected?.scope === "peripheral" ? "peripheral-bridge" : "material-bridge",
        severity: tier === "opaque-or-unknown" ? "critical" : "high",
        reason: `Runtime material bridge route resolves to ${tier}.`,
        materialSharePct,
        failureDomainKeys: selected?.failureDomainKeys ?? [`bridge:${meta.id}:${selected?.id ?? "unresolved"}`],
        evidence: bridgeEvidence,
      });
    }
  }

  appendCommonControlSignals({ meta, options, evidence, signals, structuralSignals });

  return pillarEvidence({
    policy: options.policy,
    score: pathScores.length === 0 ? null : Math.min(...pathScores),
    evidenceLevel:
      mint?.confidence === "verified" && (!oracleApplicable || oracle?.confidence === "verified")
        ? "strong"
        : evidence.length > 0
          ? "adequate"
          : "insufficient",
    evidence,
    unresolved: gaps,
    signals,
  });
}

function isReviewedByAsOf(value: string | undefined, asOf: string): boolean {
  const reviewedAt = parseTimestamp(value);
  return reviewedAt !== null && reviewedAt.getTime() <= Date.parse(asOf);
}

function isObservedByAsOf(value: string | undefined, asOf: string): boolean {
  const observedAt = parseTimestamp(value);
  return observedAt === null || observedAt.getTime() <= Date.parse(asOf);
}

function collectCriticalControlIdentitiesAsOf(meta: StablecoinMeta, asOf: string): CriticalControlIdentityOccurrence[] {
  const mint = meta.mintAuthority;
  const mintAuthority =
    mint && isReviewedByAsOf(mint.review.reviewedAt, asOf)
      ? {
          ...mint,
          controls: mint.controls?.filter((control) => isObservedByAsOf(control.observedAt, asOf)),
          upgradeability:
            mint.upgradeability && isObservedByAsOf(mint.upgradeability.observedAt, asOf)
              ? mint.upgradeability
              : undefined,
        }
      : undefined;
  const bridge = meta.bridgeRouteRisk;
  const bridgeRouteRisk =
    bridge && isReviewedByAsOf(bridge.reviewedAt, asOf)
      ? {
          ...bridge,
          routes: bridge.routes?.filter((route) => isObservedByAsOf(route.observedAt, asOf)),
        }
      : undefined;
  const oracle = meta.oracleRisk;
  const oracleRisk =
    oracle &&
    isReviewedByAsOf(oracle.reviewedAt, asOf) &&
    (!oracle.branchApplicability || isReviewedByAsOf(oracle.branchApplicability.reviewedAt, asOf))
      ? {
          ...oracle,
          branches: oracle.branches
            ?.filter((branch) => isObservedByAsOf(branch.observedAt, asOf))
            .map((branch) => ({
              ...branch,
              feeds: branch.feeds?.filter((feed) => isObservedByAsOf(feed.observedAt, asOf)),
            })),
        }
      : undefined;

  return collectCriticalControlIdentities({
    ...meta,
    mintAuthority,
    bridgeRouteRisk,
    oracleRisk,
  });
}

function collectCommonControlDomains(
  metadata: readonly StablecoinMeta[],
  asOf: string,
): ReadonlyMap<string, V9CommonControlDomain> {
  const domains = new Map<
    string,
    {
      assetIds: Set<string>;
      paths: Set<CriticalControlIdentityOccurrence["path"]>;
    }
  >();
  for (const meta of metadata) {
    for (const occurrence of collectCriticalControlIdentitiesAsOf(meta, asOf)) {
      const domain = domains.get(occurrence.key) ?? {
        assetIds: new Set<string>(),
        paths: new Set<CriticalControlIdentityOccurrence["path"]>(),
      };
      domain.assetIds.add(meta.id);
      domain.paths.add(occurrence.path);
      domains.set(occurrence.key, domain);
    }
  }
  return new Map(
    [...domains.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, domain]) => [
        key,
        {
          assetIds: [...domain.assetIds].sort(),
          paths: [...domain.paths].sort(),
        },
      ]),
  );
}

function appendCommonControlSignals(args: {
  meta: StablecoinMeta;
  options: CompileV9AssetOptions;
  evidence: readonly V9EvidenceReference[];
  signals: string[];
  structuralSignals: V9StructuralSignal[];
}): void {
  const { meta, options, evidence, signals, structuralSignals } = args;
  const materiality = options.policy.policy.semantic.materiality;
  const localByKey = new Map<string, Set<CriticalControlIdentityOccurrence["path"]>>();
  for (const occurrence of collectCriticalControlIdentitiesAsOf(meta, options.asOf)) {
    const paths = localByKey.get(occurrence.key) ?? new Set<CriticalControlIdentityOccurrence["path"]>();
    paths.add(occurrence.path);
    localByKey.set(occurrence.key, paths);
  }

  for (const [key, localPathSet] of [...localByKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const localPaths = [...localPathSet].sort();
    const domain = options.commonControlDomains?.get(key) ?? { assetIds: [meta.id], paths: localPaths };
    if (
      domain.assetIds.length < materiality.commonControlMinAssets &&
      domain.paths.length < materiality.commonControlMinPaths
    ) {
      continue;
    }

    const paths = [...domain.paths].sort();
    signals.push(`common-control:${key}:assets=${domain.assetIds.length}:paths=${paths.join("+")}`);
    structuralSignals.push({
      kind: "critical-dependency",
      severity: "moderate",
      responsibility: "measured-adverse",
      reason: `Critical control identity ${key} is reused across ${domain.assetIds.length} active asset${
        domain.assetIds.length === 1 ? "" : "s"
      } and ${paths.join(", ")} paths.`,
      failureDomainKeys: [key],
      evidence: uniqueEvidence(evidence),
    });

    if (localPathSet.has("mint") && domain.assetIds.length >= materiality.commonControlMinAssets) {
      structuralSignals.push({
        kind: "centralized-mint",
        severity: "moderate",
        responsibility: "measured-adverse",
        reason: `Mint-critical control identity ${key} is shared by ${domain.assetIds.length} active assets.`,
        failureDomainKeys: [key],
        evidence: uniqueEvidence(evidence),
      });
    }
  }
}

/** Compile production metadata and runtime observations into an expectation-free v9 research input. */
export function compileReportCardToV9Input(
  meta: StablecoinMeta,
  card: ReportCard,
  options: CompileV9AssetOptions,
): CompiledV9AssetInput {
  assertV9ValidatedPolicyEnvelope(options.policy);
  if (meta.id !== card.id) throw new Error(`V9 compiler ID mismatch: ${meta.id} != ${card.id}`);
  const archetype = resolveMechanismArchetype(meta, options.metaById);
  const effectiveImplementation = resolveEffectiveImplementationLaunchDate(
    meta,
    options.metaById,
    options.asOf.slice(0, 10),
  );
  const implementationDate = effectiveImplementation.date;
  const structuralSignals: V9StructuralSignal[] = [];
  const globalUnresolved: V9UnresolvedFact[] = [];
  const archetypeSource =
    meta.archetypeOverride === true || !meta.variantOf ? meta : (options.metaById.get(meta.variantOf) ?? meta);
  addFutureDatedFact(
    globalUnresolved,
    archetypeSource.mechanismArchetypeReview?.reviewedAt,
    options.asOf,
    "mechanismArchetypeReview.reviewedAt",
    `Mechanism-archetype review for ${archetypeSource.id}`,
  );
  addFutureDatedFact(
    globalUnresolved,
    options.reportCardObservedAt,
    options.asOf,
    "sourceTimestamps.reportCard",
    "Report-card observation",
  );
  if (archetype === null) {
    globalUnresolved.push(
      unresolved("missing-archetype", "No direct or inherited mechanism archetype is reviewed.", true, "archetype"),
    );
  }
  if (implementationDate === null) {
    globalUnresolved.push(
      unresolved(
        "missing-implementation-date",
        "Implementation launch date is unavailable or not deterministically parseable.",
        true,
        "implementationLaunchDate",
      ),
    );
  }
  if (effectiveImplementation.cycleDetected) {
    globalUnresolved.push(
      unresolved(
        "implementation-parent-cycle",
        "Implementation launch-date traversal found a variant cycle.",
        true,
        "implementationLaunchDate",
      ),
    );
  }

  const backing = compileBackingPillar(meta, card, options, structuralSignals);
  const exit = compileExitPillar(meta, options);
  const control = compileControlPillar(meta, card, archetype, options, structuralSignals);
  const pegApplicable = !meta.flags.navToken;
  const pegScore = pegApplicable ? card.dimensions.pegStability.score : null;
  const sourceTimestamps: Record<string, string> = {
    reportCard: options.reportCardObservedAt ?? options.asOf,
  };
  const dexUpdatedAt = options.dexLiquidityById?.get(meta.id)?.updatedAt;
  const dexTimestamp = toIsoTimestamp(dexUpdatedAt, options.asOf);
  if (dexTimestamp) sourceTimestamps.dexLiquidity = dexTimestamp;
  const suppliedRouteTimestamp = Math.max(
    -1,
    ...(options.exitRouteObservationsById?.get(meta.id)?.map((observation) => observation.observedAt) ?? []),
  );
  const routeTimestamp = toIsoTimestamp(suppliedRouteTimestamp >= 0 ? suppliedRouteTimestamp : undefined, options.asOf);
  if (routeTimestamp) sourceTimestamps.exitRouteObservations = routeTimestamp;
  const reserveTimestamp = toIsoTimestamp(meta.reserveReview?.reviewedAt, options.asOf);
  if (reserveTimestamp) sourceTimestamps.reserveReview = reserveTimestamp;
  const mintTimestamp = toIsoTimestamp(meta.mintAuthority?.review.reviewedAt, options.asOf);
  if (mintTimestamp) sourceTimestamps.mintAuthority = mintTimestamp;

  return CompiledV9AssetInputSchema.parse({
    schemaVersion: 1,
    compilerPolicy: {
      policyId: options.policy.policy.policyId,
      semanticDigest: options.policy.semanticDigest,
    },
    assetId: meta.id,
    asOf: options.asOf,
    compiledAt: options.compiledAt,
    archetype,
    pillars: { backing, exit, control },
    peg: {
      applicable: pegApplicable,
      score: pegScore,
      activeDepegBps: card.rawInputs.activeDepegBps ?? null,
      evidence:
        !pegApplicable || pegScore === null ? [] : [artifactEvidence(options, "Runtime peg-stability evidence.")],
      unresolved:
        pegApplicable && pegScore === null
          ? [unresolved("missing-peg-input", "Applicable peg evidence is unavailable.", true, "peg.score")]
          : [],
    },
    implementationLaunchDate: implementationDate,
    trackRecordMonths: computeConservativeTrackRecordMonths(implementationDate, options.asOf),
    parent: meta.variantOf
      ? {
          assetId: meta.variantOf,
          required: true,
          relationship: meta.variantKind ? "variant" : "wrapper",
        }
      : null,
    structuralSignals,
    unresolved: normalizeV9UnresolvedFacts(options.policy, globalUnresolved),
    sourceTimestamps,
  });
}

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

export function assertExactReportCardIds(
  expectedIds: readonly string[],
  cards: readonly Pick<ReportCard, "id">[],
): void {
  const cardIds = cards.map((card) => card.id);
  const expectedIdSet = new Set(expectedIds);
  const cardIdSet = new Set(cardIds);
  const describeIds = (label: string, ids: readonly string[]) => (ids.length ? [`${label}: ${ids.join(", ")}`] : []);
  const problems = [
    ...describeIds("duplicate metadata IDs", duplicateIds(expectedIds)),
    ...describeIds("duplicate report card IDs", duplicateIds(cardIds)),
    ...describeIds("missing report cards", [...expectedIdSet].filter((id) => !cardIdSet.has(id)).sort()),
    ...describeIds("unexpected report cards", [...cardIdSet].filter((id) => !expectedIdSet.has(id)).sort()),
  ];
  if (problems.length > 0) {
    throw new Error(`V9 compiler report-card ID bijection failed: ${problems.join("; ")}`);
  }
}

export function compileReportCardSetToV9Inputs(
  metadata: readonly StablecoinMeta[],
  cards: readonly ReportCard[],
  options: Omit<CompileV9AssetOptions, "metaById" | "commonControlDomains">,
): CompiledV9AssetInput[] {
  assertV9ValidatedPolicyEnvelope(options.policy);
  assertExactReportCardIds(
    metadata.map((meta) => meta.id),
    cards,
  );
  const metaById = new Map(metadata.map((meta) => [meta.id, meta]));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const commonControlDomains = collectCommonControlDomains(metadata, options.asOf);
  return [...metadata]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((meta) =>
      compileReportCardToV9Input(meta, cardsById.get(meta.id)!, {
        ...options,
        metaById,
        commonControlDomains,
      }),
    );
}

/** Compile point-in-time fact signals without reading the known outcome. */
export function compileHistoricalFixtureToV9Input(
  input: HistoricalV9FactsInput,
  policy: V9ValidatedPolicyEnvelope,
): CompiledV9AssetInput {
  assertV9ValidatedPolicyEnvelope(policy);
  const fixture = HistoricalV9FactsInputSchema.parse(input);
  const historicalPolicy = policy.policy.semantic.historicalValidation;
  const evidence: V9EvidenceReference[] = fixture.sources.map((source, index) => ({
    sourceId: `historical:${fixture.id}:${index}`,
    observedAt: source.publishedAt,
    publishedAt: source.publishedAt,
    url: source.url,
    note: source.supports.join("; "),
  }));
  const pillarScore = (pillar: "backing" | "exit" | "control"): number => {
    const relevant = fixture.facts.riskSignals.filter((signal) => signal.pillar === pillar);
    return relevant.length === 0
      ? historicalPolicy.noRiskSignalScore
      : Math.min(...relevant.map((signal) => historicalPolicy.severityQuality[signal.severity]));
  };
  const structuralSignals: V9StructuralSignal[] = fixture.facts.riskSignals.map((signal) => ({
    kind: signal.kind,
    severity: signal.severity,
    responsibility: "measured-adverse",
    reason: signal.reason,
    failureDomainKeys: [`historical:${fixture.assetId}:${signal.kind}`],
    evidence,
  }));
  const globalUnresolved = fixture.facts.unresolvedCriticalFacts.map((reason, index) =>
    unresolved("historical-critical-input", reason, true, `historicalFacts.${index}`),
  );
  const makeHistoricalPillar = (pillar: "backing" | "exit" | "control"): V9PillarEvidence =>
    pillarEvidence({
      policy,
      score: pillarScore(pillar),
      evidenceLevel: "adequate",
      evidence,
      unresolved: [],
      signals: fixture.facts.riskSignals
        .filter((signal) => signal.pillar === pillar)
        .map((signal) => `${signal.kind}:${signal.severity}`),
    });

  return CompiledV9AssetInputSchema.parse({
    schemaVersion: 1,
    compilerPolicy: {
      policyId: policy.policy.policyId,
      semanticDigest: policy.semanticDigest,
    },
    assetId: fixture.assetId,
    asOf: fixture.asOf,
    compiledAt: fixture.factFreeze.frozenAt,
    archetype: fixture.facts.archetype,
    pillars: {
      backing: makeHistoricalPillar("backing"),
      exit: makeHistoricalPillar("exit"),
      control: makeHistoricalPillar("control"),
    },
    peg: { applicable: true, score: 100, activeDepegBps: null, evidence, unresolved: [] },
    implementationLaunchDate: null,
    trackRecordMonths: fixture.facts.implementationAgeMonths,
    parent: null,
    structuralSignals,
    unresolved: normalizeV9UnresolvedFacts(policy, globalUnresolved),
    sourceTimestamps: Object.fromEntries(evidence.map((source) => [source.sourceId, source.observedAt])),
  });
}
