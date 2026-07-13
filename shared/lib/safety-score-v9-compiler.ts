import { resolveMechanismArchetype } from "./classification/resolve-mechanism-archetype";
import {
  conservativeImplementationDate,
  resolveEffectiveImplementationLaunchDate,
} from "./classification/resolve-implementation-launch-date";
import {
  CompiledV9AssetInputSchema,
  type CompiledV9AssetInput,
  type V9EvidenceLevel,
  type V9EvidenceReference,
  type V9PillarEvidence,
  type V9StructuralSignal,
  type V9UnresolvedFact,
  type HistoricalV9Fixture,
} from "../types/safety-score-v9";
import type { ReportCard } from "../types/report-cards";
import type { StablecoinMeta } from "../types/core";

export interface CompileV9AssetOptions {
  asOf: string;
  compiledAt: string;
  methodologyVersion: string;
  metaById: ReadonlyMap<string, StablecoinMeta>;
}

function unresolved(code: string, reason: string, critical: boolean, path?: string): V9UnresolvedFact {
  return { code, reason, critical, ...(path ? { path } : {}) };
}

function artifactEvidence(options: CompileV9AssetOptions, note: string): V9EvidenceReference {
  return {
    sourceId: `pharos-report-card-v${options.methodologyVersion}`,
    observedAt: options.asOf,
    note,
  };
}

function pillarEvidence(args: {
  score: number | null;
  evidenceLevel: V9EvidenceLevel;
  evidence: V9EvidenceReference;
  unresolved: V9UnresolvedFact[];
  signals?: string[];
}): V9PillarEvidence {
  return {
    score: args.score,
    evidenceLevel: args.score === null ? "insufficient" : args.evidenceLevel,
    evidence: args.score === null ? [] : [args.evidence],
    unresolved: args.unresolved,
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

function backingEvidenceLevel(meta: StablecoinMeta): V9EvidenceLevel {
  const report = meta.proofOfReserves?.latestReport;
  if (
    meta.reserveReview?.confidence === "verified" &&
    meta.custodyProfile?.confidence === "verified" &&
    report?.scope === "assets-and-liabilities" &&
    report.liabilityReconciliation === "full"
  ) {
    return "strong";
  }
  if (meta.reserveReview?.sources.length && (meta.custodyProfile || report)) return "adequate";
  return "limited";
}

function exitEvidenceLevel(card: ReportCard): V9EvidenceLevel {
  if (card.dimensions.liquidity.score === null) return "insufficient";
  if (card.rawInputs.liquidityHasMeasuredEvidence === true && card.rawInputs.redemptionImmediateCapacityUsd != null) {
    return "adequate";
  }
  return "limited";
}

function controlEvidenceLevel(meta: StablecoinMeta, card: ReportCard): V9EvidenceLevel {
  if (card.dimensions.decentralization.score === null) return "insufficient";
  if (meta.mintAuthority?.confidence === "verified" && meta.oracleRisk?.confidence === "verified") return "strong";
  if (meta.mintAuthority?.confidence === "verified" || meta.oracleRisk?.confidence === "verified") return "adequate";
  return "limited";
}

function backingScore(card: ReportCard): number | null {
  const resilience = card.dimensions.resilience.score;
  const dependency = card.dimensions.dependencyRisk.score;
  if (resilience === null || dependency === null) return null;
  return Math.round(resilience * 0.7 + dependency * 0.3);
}

function addBackingSignals(meta: StablecoinMeta, signals: V9StructuralSignal[]): void {
  const noEvidence: V9StructuralSignal["evidence"] = [];
  if (meta.flags.backing === "algorithmic") {
    signals.push({
      kind: "algorithmic-reflexivity",
      severity: "high",
      reason: "Backing depends on an algorithmic or reflexive stabilization mechanism.",
      failureDomainKeys: [`mechanism:${meta.id}`],
      evidence: noEvidence,
    });
  }
  if (meta.collateralQuality === "exotic") {
    signals.push({
      kind: "unsafe-backing",
      severity: "high",
      reason: "Current resilience classification identifies exotic collateral quality.",
      failureDomainKeys: [`backing:${meta.id}`],
      evidence: noEvidence,
    });
  }
  if (meta.custodyModel === "institutional-sanctioned" || meta.custodyModel === "cex") {
    signals.push({
      kind: "unsafe-backing",
      severity: "critical",
      reason: `Current custody classification is ${meta.custodyModel}.`,
      failureDomainKeys: [`custody:${meta.custodyModel}`],
      evidence: noEvidence,
    });
  } else if (meta.custodyModel === "institutional-unregulated") {
    signals.push({
      kind: "unsafe-backing",
      severity: "high",
      reason: "Backing relies on an unregulated institutional custody model.",
      failureDomainKeys: ["custody:institutional-unregulated"],
      evidence: noEvidence,
    });
  }
  if (meta.mechanismArchetype === "rwa-credit-fund") {
    signals.push({
      kind: "speculative-credit",
      severity: "moderate",
      reason: "The mechanism is exposed to private or speculative credit performance.",
      failureDomainKeys: [`credit:${meta.id}`],
      evidence: noEvidence,
    });
  }
}

function addControlSignals(meta: StablecoinMeta, signals: V9StructuralSignal[]): void {
  const noEvidence: V9StructuralSignal["evidence"] = [];
  const posture = meta.mintAuthority?.authorityPosture;
  if (posture === "unbounded-or-compromised" || posture === "unknown") {
    signals.push({
      kind: posture === "unbounded-or-compromised" ? "active-control-incident" : "centralized-mint",
      severity: "critical",
      reason: `Mint authority posture is ${posture}.`,
      failureDomainKeys: [`mint:${meta.id}`],
      evidence: noEvidence,
    });
  } else if (posture === "concentrated-admin") {
    signals.push({
      kind: "centralized-mint",
      severity: "moderate",
      reason: "Mint authority is concentrated in a privileged administrator.",
      failureDomainKeys: [`mint:${meta.id}`],
      evidence: noEvidence,
    });
  }
  if (meta.oracleRisk?.tier === "single-source-or-laggy" || meta.oracleRisk?.tier === "opaque-or-unknown") {
    signals.push({
      kind: "weak-oracle-branch",
      severity: meta.oracleRisk.tier === "opaque-or-unknown" ? "critical" : "high",
      reason: `Oracle review resolves to ${meta.oracleRisk.tier}.`,
      failureDomainKeys: [`oracle:${meta.id}`],
      evidence: noEvidence,
    });
  }
  const bridgeTier = meta.bridgeRouteRisk?.tier;
  if (bridgeTier === "external-lock-mint" || bridgeTier === "opaque-or-unknown") {
    signals.push({
      kind: "material-bridge",
      severity: bridgeTier === "opaque-or-unknown" ? "critical" : "high",
      reason: `Reviewed bridge route tier is ${bridgeTier}; runtime materiality remains unresolved.`,
      failureDomainKeys: [`bridge:${meta.id}`],
      evidence: noEvidence,
    });
  }
}

function addDependencySignals(card: ReportCard, signals: V9StructuralSignal[]): void {
  const unavailable = card.dimensions.dependencyRisk.dependencyDiagnostics?.unavailableIds ?? [];
  if (unavailable.length === 0) return;
  signals.push({
    kind: "critical-dependency",
    severity: "high",
    reason: `Required dependency ratings are unavailable: ${[...unavailable].sort().join(", ")}.`,
    failureDomainKeys: unavailable.map((id) => `dependency:${id}`),
    evidence: [],
  });
}

/** Compile production metadata and a fixed report card into an expectation-free v9 research input. */
export function compileReportCardToV9Input(
  meta: StablecoinMeta,
  card: ReportCard,
  options: CompileV9AssetOptions,
): CompiledV9AssetInput {
  if (meta.id !== card.id) throw new Error(`V9 compiler ID mismatch: ${meta.id} != ${card.id}`);
  const archetype = resolveMechanismArchetype(meta, options.metaById);
  const effectiveImplementation = resolveEffectiveImplementationLaunchDate(
    meta,
    options.metaById,
    options.asOf.slice(0, 10),
  );
  const implementationDate = effectiveImplementation.date;
  const structuralSignals: V9StructuralSignal[] = [];
  addBackingSignals(meta, structuralSignals);
  addControlSignals(meta, structuralSignals);
  addDependencySignals(card, structuralSignals);

  const globalUnresolved: V9UnresolvedFact[] = [];
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

  const backing = backingScore(card);
  const exit = card.dimensions.liquidity.score;
  const control = card.dimensions.decentralization.score;
  const pegApplicable = !meta.flags.navToken;
  const backingUnresolved =
    backing === null
      ? [unresolved("missing-backing-input", "Resilience or dependency score is unavailable.", true, "pillars.backing")]
      : meta.reserveReview
        ? []
        : [unresolved("unreviewed-reserve-envelope", "Reserve composition lacks a curated review envelope.", false)];
  const exitUnresolved =
    exit === null
      ? [unresolved("missing-exit-input", "No current exit-quality score is available.", true, "pillars.exit")]
      : [
          unresolved(
            "same-notional-route-coverage",
            "Not every exit path has a score-eligible same-notional observation.",
            false,
          ),
        ];
  const controlUnresolved =
    control === null
      ? [unresolved("missing-control-input", "No current control score is available.", true, "pillars.control")]
      : meta.mintAuthority
        ? []
        : [unresolved("unreviewed-mint-authority", "Mint authority has no reviewed production profile.", false)];

  return CompiledV9AssetInputSchema.parse({
    schemaVersion: 1,
    assetId: meta.id,
    asOf: options.asOf,
    compiledAt: options.compiledAt,
    archetype,
    pillars: {
      backing: pillarEvidence({
        score: backing,
        evidenceLevel: backingEvidenceLevel(meta),
        evidence: artifactEvidence(options, "Derived from v8 resilience and dependency dimensions."),
        unresolved: backingUnresolved,
        signals: ["v8-resilience-adapter", "v8-dependency-adapter"],
      }),
      exit: pillarEvidence({
        score: exit,
        evidenceLevel: exitEvidenceLevel(card),
        evidence: artifactEvidence(options, "Derived from the current effective exit dimension."),
        unresolved: exitUnresolved,
        signals: ["v8-liquidity-adapter"],
      }),
      control: pillarEvidence({
        score: control,
        evidenceLevel: controlEvidenceLevel(meta, card),
        evidence: artifactEvidence(options, "Derived from the current decentralization dimension."),
        unresolved: controlUnresolved,
        signals: ["v8-decentralization-adapter"],
      }),
    },
    peg: {
      applicable: pegApplicable,
      score: pegApplicable ? card.dimensions.pegStability.score : null,
      activeDepegBps: card.rawInputs.activeDepegBps ?? null,
      evidence:
        !pegApplicable || card.dimensions.pegStability.score === null
          ? []
          : [artifactEvidence(options, "Derived from the fixed v8 peg-stability dimension.")],
      unresolved:
        pegApplicable && card.dimensions.pegStability.score === null
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
    unresolved: globalUnresolved,
    sourceTimestamps: { reportCard: options.asOf },
  });
}

export function compileReportCardSetToV9Inputs(
  metadata: readonly StablecoinMeta[],
  cards: readonly ReportCard[],
  options: Omit<CompileV9AssetOptions, "metaById">,
): CompiledV9AssetInput[] {
  const metaById = new Map(metadata.map((meta) => [meta.id, meta]));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const missingCards = metadata.filter((meta) => !cardsById.has(meta.id)).map((meta) => meta.id);
  if (missingCards.length > 0) throw new Error(`V9 compiler missing report cards: ${missingCards.sort().join(", ")}`);
  return [...metadata]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((meta) => compileReportCardToV9Input(meta, cardsById.get(meta.id)!, { ...options, metaById }));
}

const HISTORICAL_RISK_SCORE = {
  low: 85,
  moderate: 70,
  high: 50,
  critical: 30,
} as const;

/** Compile point-in-time fact signals without reading the known outcome. */
export function compileHistoricalFixtureToV9Input(fixture: HistoricalV9Fixture): CompiledV9AssetInput {
  const evidence: V9EvidenceReference[] = fixture.sources.map((source, index) => ({
    sourceId: `historical:${fixture.id}:${index}`,
    observedAt: source.publishedAt,
    publishedAt: source.publishedAt,
    url: source.url,
    note: source.supports.join("; "),
  }));
  const pillarScore = (pillar: "backing" | "exit" | "control"): number => {
    const relevant = fixture.facts.riskSignals.filter((signal) => signal.pillar === pillar);
    return relevant.length === 0 ? 90 : Math.min(...relevant.map((signal) => HISTORICAL_RISK_SCORE[signal.severity]));
  };
  const structuralSignals: V9StructuralSignal[] = fixture.facts.riskSignals.map((signal) => ({
    kind: signal.kind,
    severity: signal.severity,
    reason: signal.reason,
    failureDomainKeys: [`historical:${fixture.assetId}:${signal.kind}`],
    evidence,
  }));
  const globalUnresolved = fixture.facts.unresolvedCriticalFacts.map((reason, index) =>
    unresolved(`historical-critical-${index + 1}`, reason, true, "historicalFacts"),
  );
  const makeHistoricalPillar = (pillar: "backing" | "exit" | "control"): V9PillarEvidence =>
    pillarEvidence({
      score: pillarScore(pillar),
      evidenceLevel: "adequate",
      evidence: evidence[0]!,
      unresolved: [],
      signals: fixture.facts.riskSignals
        .filter((signal) => signal.pillar === pillar)
        .map((signal) => `${signal.kind}:${signal.severity}`),
    });

  return CompiledV9AssetInputSchema.parse({
    schemaVersion: 1,
    assetId: fixture.assetId,
    asOf: fixture.asOf,
    compiledAt: fixture.provenance.reviewedAt,
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
    unresolved: globalUnresolved,
    sourceTimestamps: Object.fromEntries(evidence.map((source) => [source.sourceId, source.observedAt])),
  });
}
