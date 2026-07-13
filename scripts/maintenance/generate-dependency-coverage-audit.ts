#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildDependencyGraphEdges,
  diagnoseDependencyGraph,
  filterDependencyGraphEdgesToLive,
  type DependencyGraphDiagnostics,
  type DependencyGraphEdge,
} from "../../shared/lib/dependency-graph";
import {
  deriveEffectiveDependencySet,
  type DependencyDerivationBaseSource,
  type DependencyDerivationSource,
  type DependencyFallbackReason,
} from "../../shared/lib/dependency-derivation";
import { getL2BeatInfrastructureContext } from "../../shared/lib/chains/l2beat-audit";
import { buildReserveSymbolMatcher } from "../../shared/lib/reserve-symbol-matchers";
import { ACTIVE_STABLECOINS, TRACKED_STABLECOINS } from "../../shared/lib/stablecoins/registry";
import type {
  DependencyType,
  DependencyWeight,
  ReserveNonLinkDisposition,
  ReserveNonLinkReview,
  ReserveSlice,
  StablecoinMeta,
} from "../../shared/types";
import {
  buildMarketCapMapFromStablecoins,
  formatUsd,
  isRecord,
  loadCoverageAuditSiteDataInputs,
  markdownValue,
  numberValue,
  readJsonFile,
  readRequiredJsonFile,
  resolveGeneratedAt,
  runAsMain,
  sortByMarketCapOrRank,
  stringValue,
  writeOutputFile,
} from "../lib/coverage-audit-cli";
import {
  DEPENDENCY_ADAPTER_MAPPING_REVIEWS,
  DEPENDENCY_TARGET_DISPOSITIONS,
  type DependencyAdapterMappingReview,
  type DependencyTargetDisposition,
  type DependencyTargetLifecycle,
} from "../lib/dependency-target-dispositions";

const DEFAULT_BASELINE_PATH = "scripts/lib/dependency-coverage-baseline.json";
const MISSING_CANDIDATE_LIMIT = 50;
const RESERVE_SLICE_LIMIT = 50;
const MANUAL_DEPENDENCY_LIMIT = 50;
const L2BEAT_CONTEXT_LIMIT = 75;
const FINDING_LIMIT = 75;
const MATERIAL_RESERVE_PCT = 1;
const WEIGHT_EPSILON = 1e-9;
const GENERIC_STABLECOIN_SYMBOLS = new Set(["CASH", "MONEY", "CDP"]);
const UNRESOLVED_NON_LINK_DISPOSITIONS = new Set<ReserveNonLinkDisposition>([
  "basket-needs-split",
  "insufficient-evidence",
]);

export interface DependencyGraphCoverageSummary {
  edgeCount: number;
  activeEdgeCount: number;
  participantCount: number;
  dependentCount: number;
  upstreamOnlyCount: number;
  participantIds: string[];
  dependentIds: string[];
  upstreamOnlyIds: string[];
}

export interface ManualOnlyDependencyRow {
  coinId: string;
  symbol: string;
  dependencyId: string;
  dependencyType: DependencyType;
  weight: number;
  reviewStatus: "reviewed" | "missing-review" | "missing-relationship" | "missing-explicit-type";
}

export interface ReserveSliceCoverageRow {
  coinId: string;
  symbol: string;
  reserveIndex: number;
  reserveName: string;
  pct: number;
  risk: string;
  depType: DependencyType | null;
  marketCapUsd: number | null;
  rank: number;
}

export interface MaterialUnlinkedReserveRow extends ReserveSliceCoverageRow {
  matchedSymbols: string[];
  candidateCoinIds: string[];
  reviewStatus: "reviewed" | "unresolved" | "unreviewed";
  disposition: ReserveNonLinkDisposition | null;
  dispositionRationale: string | null;
}

export interface ReserveDispositionRow {
  coinId: string;
  symbol: string;
  reserveIndex: number;
  reserveName: string;
  currentReserveName: string | null;
  disposition: ReserveNonLinkDisposition;
  reviewStatus: "reviewed" | "unresolved" | "stale";
  rationale: string;
  candidateCoinIds: string[];
  reviewedAt: string;
  reviewer: string;
}

export interface ManualDependencyReviewGapRow {
  coinId: string;
  symbol: string;
  dependencyId: string;
  dependencyType: DependencyType;
  reason: "missing-review" | "missing-relationship" | "missing-explicit-type" | "stale-relationship";
}

export interface RawAuthoredDuplicateRow {
  coinId: string;
  symbol: string;
  dependencyId: string;
  dependencyType: DependencyType;
  source: "dependencies" | "reserves";
  indices: number[];
  totalWeight: number;
}

export interface OverweightDependencySetRow {
  coinId: string;
  symbol: string;
  source: "static" | "report-card";
  totalWeight: number;
  dependencies: DependencyWeight[];
}

export type TargetScoreability =
  | "scoreable"
  | "active-nr"
  | "pre-launch"
  | "frozen"
  | "unknown-target"
  | "not-evaluated";

export interface DependencyEdgeCoverageRow extends DependencyGraphEdge {
  graphSource: "static" | "report-card";
  upstreamSymbol: string | null;
  dependentSymbol: string | null;
  targetLifecycle: DependencyTargetLifecycle | "unknown";
  targetScoreability: TargetScoreability;
  targetDisposition: DependencyTargetDisposition | null;
}

export interface DependencySetProvenanceRow {
  coinId: string;
  symbol: string;
  source: DependencyDerivationSource | null;
  baseSource: DependencyDerivationBaseSource | null;
  fallbackReason: DependencyFallbackReason | null;
  dependencyFromLive: boolean | null;
  availableWeight: number | null;
  unavailableWeight: number | null;
  mappedLiveReserveShare: number | null;
  unmappedLiveReserveShare: number | null;
}

export interface TargetDispositionValidationIssue {
  targetId: string;
  reason:
    | "duplicate-disposition"
    | "unknown-target"
    | "lifecycle-mismatch"
    | "invalid-provenance"
    | "no-current-edge"
    | "target-now-scoreable";
  detail: string;
}

export interface AdapterMappingReviewGapRow {
  coinId: string | null;
  adapter: string;
  reason: "missing-review" | "duplicate-review" | "stale-review" | "invalid-provenance";
  detail: string;
}

export interface MissingDependencyCandidateRow {
  coinId: string;
  symbol: string;
  name: string;
  marketCapUsd: number | null;
  rank: number;
}

export interface L2BeatDeploymentContextRow {
  coinId: string;
  symbol: string;
  chainId: string;
  routeKind: "canonical-contract" | "traded-contract";
  projectId: string;
  l2beatName: string;
  layer: "layer2" | "layer3";
  category: string;
  hostChain: string;
  hostChainId: string | null;
  stage: string;
  isUnderReview: boolean;
  chainEnvironmentScore: number;
  chainTier: string | null;
  deploymentModel: string | null;
}

export interface DependencyCoverageBaseline {
  reserveSlicesMissingCoinId: number;
  unresolvedMaterialReserveSlices: number;
  manualDependencyReviewGaps: number;
  staleReserveDispositions: number;
  unavailableTargetDispositionGaps: number;
  targetDispositionValidationIssues: number;
  adapterMappingReviewGaps: number;
}

export interface DependencyCoverageAudit {
  generatedAt: string;
  mode: "static" | "input" | "api" | "prod";
  summary: {
    activeCount: number;
    staticEdgeCount: number;
    staticActiveEdgeCount: number;
    staticParticipantCount: number;
    staticDependentCount: number;
    staticUpstreamOnlyCount: number;
    reportCardEdgeCount: number | null;
    reportCardActiveEdgeCount: number | null;
    reportCardParticipantCount: number | null;
    reportCardDependentCount: number | null;
    reportCardUpstreamOnlyCount: number | null;
    manualOnlyDependencyCount: number;
    reserveSlicesMissingCoinId: number;
    depTypeWithoutCoinIdWarnings: number;
    staticSelfEdgeCount: number;
    staticDuplicateEdgeCount: number;
    staticStronglyConnectedComponentCount: number;
    reportCardSelfEdgeCount: number | null;
    reportCardDuplicateEdgeCount: number | null;
    reportCardStronglyConnectedComponentCount: number | null;
    rawAuthoredDuplicateCount: number;
    overweightEffectiveSetCount: number;
    unknownTargetEdgeCount: number;
    unavailableTargetEdgeCount: number;
    unavailableTargetDispositionGapCount: number;
    targetDispositionValidationIssueCount: number;
    adapterMappingReviewGapCount: number;
    dependencyProvenanceCount: number;
    dependencyAvailableWeight: number | null;
    dependencyUnavailableWeight: number | null;
    liveMappedReserveShare: number | null;
    liveUnmappedReserveShare: number | null;
    materialUnlinkedReserveSliceCount: number;
    reviewedReserveDispositionCount: number;
    unresolvedReserveDispositionCount: number;
    unresolvedMaterialReserveSliceCount: number;
    staleReserveDispositionCount: number;
    manualDependencyReviewGapCount: number;
    missingCandidateCount: number;
    l2beatDeploymentContextCount: number;
    l2beatLayer3DeploymentContextCount: number;
    l2beatUnderReviewDeploymentContextCount: number;
    missingCandidateRankSource: "stablecoin-api-market-cap" | "local-canonical-order";
    missingCandidateGraphSource: "static" | "report-card";
  };
  staticGraph: DependencyGraphCoverageSummary;
  staticGraphDiagnostics: DependencyGraphDiagnostics;
  reportCardGraph: DependencyGraphCoverageSummary | null;
  reportCardGraphDiagnostics: DependencyGraphDiagnostics | null;
  dependencyEdges: DependencyEdgeCoverageRow[];
  dependencyProvenance: DependencySetProvenanceRow[];
  rawAuthoredDuplicates: RawAuthoredDuplicateRow[];
  overweightEffectiveSets: OverweightDependencySetRow[];
  manualOnlyDependencies: ManualOnlyDependencyRow[];
  manualDependencyReviewGaps: ManualDependencyReviewGapRow[];
  reserveSlicesMissingCoinId: ReserveSliceCoverageRow[];
  depTypeWithoutCoinIdWarnings: ReserveSliceCoverageRow[];
  materialUnlinkedReserveSlices: MaterialUnlinkedReserveRow[];
  reserveDispositions: ReserveDispositionRow[];
  targetDispositionValidationIssues: TargetDispositionValidationIssue[];
  adapterMappingReviews: DependencyAdapterMappingReview[];
  adapterMappingReviewGaps: AdapterMappingReviewGapRow[];
  highestMarketCapMissingCandidates: MissingDependencyCandidateRow[];
  l2beatDeploymentContext: L2BeatDeploymentContextRow[];
  warnings: string[];
}

export interface DependencyCoverageAuditInput {
  activeCoins?: readonly StablecoinMeta[];
  trackedCoins?: readonly StablecoinMeta[];
  targetDispositions?: readonly DependencyTargetDisposition[];
  adapterMappingReviews?: readonly DependencyAdapterMappingReview[];
  reportCards?: unknown;
  stablecoins?: unknown;
  generatedAt?: string;
  mode?: DependencyCoverageAudit["mode"];
}

interface CliOptions {
  apiBase: string | null;
  prod: boolean;
  inputDir: string | null;
  reportCardsPath: string | null;
  stablecoinsPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  check: boolean;
  baselinePath: string;
  generatedAt: string | null;
}

const DEPENDENCY_SOURCE_VALUES = new Set<DependencyDerivationSource>([
  "live-reserve",
  "live-unmapped",
  "curated-reserve",
  "manual",
  "none",
  "variant",
]);
const DEPENDENCY_BASE_SOURCE_VALUES = new Set<DependencyDerivationBaseSource>([
  "live-reserve",
  "live-unmapped",
  "curated-reserve",
  "manual",
  "none",
]);
const DEPENDENCY_FALLBACK_REASON_VALUES = new Set<DependencyFallbackReason>([
  "live-unmapped-to-curated-reserve",
  "live-unmapped-to-manual",
  "live-cycle-to-curated",
]);

interface ParsedReportCardInput {
  cardsById: Map<string, Record<string, unknown>>;
  edges: DependencyGraphEdge[];
}

function malformedReportCard(path: string, expectation: string): never {
  throw new Error(`Report-card input is malformed at ${path}: ${expectation}.`);
}

function reportCardRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) malformedReportCard(path, "expected an object");
  return value;
}

function reportCardId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    malformedReportCard(path, "expected a nonempty, trimmed string");
  }
  return value;
}

function dependencyTypeValue(value: unknown, path: string, optional = false): DependencyType {
  if (optional && value === undefined) return "collateral";
  if (value === "wrapper" || value === "mechanism" || value === "collateral") return value;
  return malformedReportCard(path, "expected wrapper, mechanism, or collateral");
}

function dependencyWeightValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    malformedReportCard(path, "expected a finite number greater than 0 and at most 1");
  }
  return value;
}

function optionalNonnegativeNumber(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    malformedReportCard(path, "expected null or a finite nonnegative number");
  }
}

function dependencyKey(dependency: Pick<DependencyWeight, "id" | "type">): string {
  return `${dependency.id}::${dependency.type ?? "collateral"}`;
}

function reportCardsEnvelope(payload: unknown): Record<string, unknown> {
  const root = reportCardRecord(payload, "root");
  if (root.payload === undefined) return root;
  return reportCardRecord(root.payload, "payload");
}

function dependencyWeightsValue(value: unknown, path: string): DependencyWeight[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) malformedReportCard(path, "expected an array");
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const dependencyPath = `${path}[${index}]`;
    const dependency = reportCardRecord(candidate, dependencyPath);
    const parsed = {
      id: reportCardId(dependency.id, `${dependencyPath}.id`),
      weight: dependencyWeightValue(dependency.weight, `${dependencyPath}.weight`),
      type: dependencyTypeValue(dependency.type, `${dependencyPath}.type`, true),
    };
    const key = dependencyKey(parsed);
    if (seen.has(key)) malformedReportCard(dependencyPath, `duplicate dependency ${key}`);
    seen.add(key);
    return parsed;
  });
}

function validateReportCardRawInputs(rawInputs: Record<string, unknown>, path: string): void {
  dependencyWeightsValue(rawInputs.dependencies, `${path}.dependencies`);
  if (rawInputs.dependencySource !== undefined && !DEPENDENCY_SOURCE_VALUES.has(rawInputs.dependencySource as DependencyDerivationSource)) {
    malformedReportCard(`${path}.dependencySource`, "expected a known dependency source");
  }
  if (
    rawInputs.dependencyBaseSource !== undefined
    && !DEPENDENCY_BASE_SOURCE_VALUES.has(rawInputs.dependencyBaseSource as DependencyDerivationBaseSource)
  ) {
    malformedReportCard(`${path}.dependencyBaseSource`, "expected a known base dependency source");
  }
  if (
    rawInputs.dependencyFallbackReason !== undefined
    && rawInputs.dependencyFallbackReason !== null
    && !DEPENDENCY_FALLBACK_REASON_VALUES.has(rawInputs.dependencyFallbackReason as DependencyFallbackReason)
  ) {
    malformedReportCard(`${path}.dependencyFallbackReason`, "expected null or a known fallback reason");
  }
  if (rawInputs.dependencyFromLive !== undefined && typeof rawInputs.dependencyFromLive !== "boolean") {
    malformedReportCard(`${path}.dependencyFromLive`, "expected a boolean");
  }
  optionalNonnegativeNumber(rawInputs.mappedLiveReserveWeight, `${path}.mappedLiveReserveWeight`);
}

function validateReportCardDiagnostics(value: unknown, path: string): void {
  if (value === undefined) return;
  const dimensions = reportCardRecord(value, path);
  if (dimensions.dependencyRisk === undefined) return;
  const dependencyRisk = reportCardRecord(dimensions.dependencyRisk, `${path}.dependencyRisk`);
  if (dependencyRisk.dependencyDiagnostics === undefined) return;
  const diagnostics = reportCardRecord(
    dependencyRisk.dependencyDiagnostics,
    `${path}.dependencyRisk.dependencyDiagnostics`,
  );
  optionalNonnegativeNumber(
    diagnostics.availableWeight,
    `${path}.dependencyRisk.dependencyDiagnostics.availableWeight`,
  );
  optionalNonnegativeNumber(
    diagnostics.unavailableWeight,
    `${path}.dependencyRisk.dependencyDiagnostics.unavailableWeight`,
  );
  if (diagnostics.contributions === undefined) return;
  if (!Array.isArray(diagnostics.contributions)) {
    malformedReportCard(`${path}.dependencyRisk.dependencyDiagnostics.contributions`, "expected an array");
  }
  const seen = new Set<string>();
  diagnostics.contributions.forEach((candidate, index) => {
    const contributionPath = `${path}.dependencyRisk.dependencyDiagnostics.contributions[${index}]`;
    const contribution = reportCardRecord(candidate, contributionPath);
    const id = reportCardId(contribution.id, `${contributionPath}.id`);
    const type = dependencyTypeValue(contribution.type, `${contributionPath}.type`);
    if (typeof contribution.available !== "boolean") {
      malformedReportCard(`${contributionPath}.available`, "expected a boolean");
    }
    const key = `${id}::${type}`;
    if (seen.has(key)) malformedReportCard(contributionPath, `duplicate contribution ${key}`);
    seen.add(key);
  });
}

function parseReportCardInput(payload: unknown): ParsedReportCardInput {
  const envelope = reportCardsEnvelope(payload);
  if (!Array.isArray(envelope.cards)) malformedReportCard("cards", "expected an array");
  const cardsById = new Map<string, Record<string, unknown>>();
  envelope.cards.forEach((candidate, index) => {
    const cardPath = `cards[${index}]`;
    const card = reportCardRecord(candidate, cardPath);
    const id = reportCardId(card.id, `${cardPath}.id`);
    if (cardsById.has(id)) malformedReportCard(`${cardPath}.id`, `duplicate card ID ${id}`);
    if (card.overallScore !== null && (typeof card.overallScore !== "number" || !Number.isFinite(card.overallScore))) {
      malformedReportCard(`${cardPath}.overallScore`, "expected null or a finite number");
    }
    if (card.rawInputs !== undefined) {
      validateReportCardRawInputs(reportCardRecord(card.rawInputs, `${cardPath}.rawInputs`), `${cardPath}.rawInputs`);
    }
    validateReportCardDiagnostics(card.dimensions, `${cardPath}.dimensions`);
    cardsById.set(id, card);
  });

  const graph = reportCardRecord(envelope.dependencyGraph, "dependencyGraph");
  if (!Array.isArray(graph.edges)) malformedReportCard("dependencyGraph.edges", "expected an array");
  const seenEdges = new Set<string>();
  const edges = graph.edges.map((candidate, index): DependencyGraphEdge => {
    const edgePath = `dependencyGraph.edges[${index}]`;
    const edge = reportCardRecord(candidate, edgePath);
    const parsed = {
      from: reportCardId(edge.from, `${edgePath}.from`),
      to: reportCardId(edge.to, `${edgePath}.to`),
      weight: dependencyWeightValue(edge.weight, `${edgePath}.weight`),
      type: dependencyTypeValue(edge.type, `${edgePath}.type`),
    };
    const key = `${parsed.from}->${parsed.to}::${parsed.type}`;
    if (seenEdges.has(key)) malformedReportCard(edgePath, `duplicate dependency edge ${key}`);
    seenEdges.add(key);
    return parsed;
  });
  return { cardsById, edges };
}

function lifecycleForMeta(meta: StablecoinMeta | undefined): DependencyTargetLifecycle | "unknown" {
  if (!meta) return "unknown";
  if (meta.status === "pre-launch") return "pre-launch";
  if (meta.status === "frozen") return "frozen";
  return "active";
}

function findRawAuthoredSelfEdges(activeCoins: readonly StablecoinMeta[]): DependencyGraphEdge[] {
  const rows: DependencyGraphEdge[] = [];
  for (const coin of activeCoins) {
    for (const dependency of coin.dependencies ?? []) {
      if (dependency.id !== coin.id) continue;
      rows.push({
        from: coin.id,
        to: coin.id,
        weight: dependency.weight,
        type: dependency.type ?? "collateral",
      });
    }
    for (const reserve of coin.reserves ?? []) {
      if (reserve.coinId !== coin.id) continue;
      rows.push({
        from: coin.id,
        to: coin.id,
        weight: reserve.pct / 100,
        type: reserve.depType ?? "collateral",
      });
    }
    if (coin.variantOf === coin.id) {
      rows.push({ from: coin.id, to: coin.id, weight: 1, type: "wrapper" });
    }
  }
  return rows;
}

function diagnoseStaticGraph(
  edges: readonly DependencyGraphEdge[],
  activeCoins: readonly StablecoinMeta[],
): DependencyGraphDiagnostics {
  const diagnostics = diagnoseDependencyGraph(edges);
  const selfEdges = [...diagnostics.selfEdges];
  const seen = new Set(selfEdges.map((edge) => `${edge.from}::${edge.type}::${edge.weight}`));
  for (const edge of findRawAuthoredSelfEdges(activeCoins)) {
    const key = `${edge.from}::${edge.type}::${edge.weight}`;
    if (!seen.has(key)) selfEdges.push(edge);
    seen.add(key);
  }
  return {
    ...diagnostics,
    selfEdges: selfEdges.sort((left, right) => (
      left.from.localeCompare(right.from) || left.type.localeCompare(right.type) || left.weight - right.weight
    )),
  };
}

function findRawAuthoredDuplicates(activeCoins: readonly StablecoinMeta[]): RawAuthoredDuplicateRow[] {
  const rows: RawAuthoredDuplicateRow[] = [];
  for (const coin of activeCoins) {
    const groups: Array<{
      source: RawAuthoredDuplicateRow["source"];
      entries: Array<{ dependencyId: string; dependencyType: DependencyType; index: number; weight: number }>;
    }> = [
      {
        source: "dependencies",
        entries: (coin.dependencies ?? []).map((dependency, index) => ({
          dependencyId: dependency.id,
          dependencyType: dependency.type ?? "collateral",
          index,
          weight: dependency.weight,
        })),
      },
      {
        source: "reserves",
        entries: (coin.reserves ?? []).flatMap((reserve, index) => reserve.coinId
          ? [{
              dependencyId: reserve.coinId,
              dependencyType: reserve.depType ?? "collateral" as DependencyType,
              index,
              weight: reserve.pct / 100,
            }]
          : []),
      },
    ];

    for (const group of groups) {
      const byKey = new Map<string, typeof group.entries>();
      for (const entry of group.entries) {
        const key = `${entry.dependencyId}::${entry.dependencyType}`;
        byKey.set(key, [...(byKey.get(key) ?? []), entry]);
      }
      for (const entries of byKey.values()) {
        if (entries.length < 2) continue;
        rows.push({
          coinId: coin.id,
          symbol: coin.symbol,
          dependencyId: entries[0].dependencyId,
          dependencyType: entries[0].dependencyType,
          source: group.source,
          indices: entries.map((entry) => entry.index),
          totalWeight: entries.reduce((sum, entry) => sum + entry.weight, 0),
        });
      }
    }
  }
  return rows.sort((left, right) => (
    left.coinId.localeCompare(right.coinId)
    || left.source.localeCompare(right.source)
    || left.dependencyId.localeCompare(right.dependencyId)
    || left.dependencyType.localeCompare(right.dependencyType)
  ));
}

function findOverweightEffectiveSets(
  activeCoins: readonly StablecoinMeta[],
  cardsById: ReadonlyMap<string, Record<string, unknown>>,
  hasReportCards: boolean,
): OverweightDependencySetRow[] {
  const rows: OverweightDependencySetRow[] = [];
  for (const coin of activeCoins) {
    const card = cardsById.get(coin.id);
    const rawInputs = card && isRecord(card.rawInputs) ? card.rawInputs : null;
    const reportCardDependencies = rawInputs
      ? dependencyWeightsValue(rawInputs.dependencies, `card ${coin.id}.rawInputs.dependencies`)
      : [];
    const dependencies = hasReportCards && rawInputs && Array.isArray(rawInputs.dependencies)
      ? reportCardDependencies
      : deriveEffectiveDependencySet(coin).dependencies;
    const totalWeight = dependencies.reduce((sum, dependency) => sum + dependency.weight, 0);
    if (totalWeight <= 1 + WEIGHT_EPSILON) continue;
    rows.push({
      coinId: coin.id,
      symbol: coin.symbol,
      source: hasReportCards && rawInputs && Array.isArray(rawInputs.dependencies) ? "report-card" : "static",
      totalWeight,
      dependencies,
    });
  }
  return rows.sort((left, right) => right.totalWeight - left.totalWeight || left.coinId.localeCompare(right.coinId));
}

function findManualDependencyReviewRows(activeCoins: readonly StablecoinMeta[]): {
  manualOnlyDependencies: ManualOnlyDependencyRow[];
  gaps: ManualDependencyReviewGapRow[];
} {
  const manualOnlyDependencies: ManualOnlyDependencyRow[] = [];
  const gaps: ManualDependencyReviewGapRow[] = [];
  for (const coin of activeCoins) {
    const reserveDependencyKeys = new Set(
      (coin.reserves ?? [])
        .filter((reserve): reserve is ReserveSlice & { coinId: string } => Boolean(reserve.coinId))
        .map((reserve) => dependencyKey({ id: reserve.coinId, type: reserve.depType })),
    );
    const reviewedKeys = new Set((coin.dependencyReview?.relationships ?? []).map(dependencyKey));
    const manualKeys = new Set<string>();
    for (const dependency of coin.dependencies ?? []) {
      const key = dependencyKey(dependency);
      if (reserveDependencyKeys.has(key)) continue;
      manualKeys.add(key);
      const reviewStatus: ManualOnlyDependencyRow["reviewStatus"] = dependency.type == null
        ? "missing-explicit-type"
        : coin.dependencyReview == null
          ? "missing-review"
          : reviewedKeys.has(key)
            ? "reviewed"
            : "missing-relationship";
      manualOnlyDependencies.push({
        coinId: coin.id,
        symbol: coin.symbol,
        dependencyId: dependency.id,
        dependencyType: dependency.type ?? "collateral",
        weight: dependency.weight,
        reviewStatus,
      });
      if (reviewStatus !== "reviewed") {
        gaps.push({
          coinId: coin.id,
          symbol: coin.symbol,
          dependencyId: dependency.id,
          dependencyType: dependency.type ?? "collateral",
          reason: reviewStatus,
        });
      }
    }
    for (const relationship of coin.dependencyReview?.relationships ?? []) {
      const key = dependencyKey(relationship);
      if (manualKeys.has(key)) continue;
      gaps.push({
        coinId: coin.id,
        symbol: coin.symbol,
        dependencyId: relationship.id,
        dependencyType: relationship.type,
        reason: "stale-relationship",
      });
    }
  }
  const compare = (left: { coinId: string; dependencyId: string; dependencyType: string }, right: typeof left) => (
    left.coinId.localeCompare(right.coinId)
    || left.dependencyId.localeCompare(right.dependencyId)
    || left.dependencyType.localeCompare(right.dependencyType)
  );
  return {
    manualOnlyDependencies: manualOnlyDependencies.sort(compare),
    gaps: gaps.sort(compare),
  };
}

function summarizeDependencyGraph(
  edges: readonly DependencyGraphEdge[],
  activeIds: ReadonlySet<string>,
): DependencyGraphCoverageSummary {
  const activeEdges = filterDependencyGraphEdgesToLive(edges, activeIds);
  const sourceIds = new Set<string>();
  const dependentIds = new Set<string>();

  for (const edge of activeEdges) {
    sourceIds.add(edge.from);
    dependentIds.add(edge.to);
  }

  const participantIds = [...new Set([...sourceIds, ...dependentIds])].sort();
  const dependentIdList = [...dependentIds].sort();
  const upstreamOnlyIds = [...sourceIds].filter((id) => !dependentIds.has(id)).sort();

  return {
    edgeCount: edges.length,
    activeEdgeCount: activeEdges.length,
    participantCount: participantIds.length,
    dependentCount: dependentIdList.length,
    upstreamOnlyCount: upstreamOnlyIds.length,
    participantIds,
    dependentIds: dependentIdList,
    upstreamOnlyIds,
  };
}

function marketCapForId(marketCapById: ReadonlyMap<string, number> | null, id: string): number | null {
  return marketCapById?.get(id) ?? null;
}

interface StablecoinSymbolMatcher {
  coinId: string;
  symbol: string;
  matches: (text: string) => boolean;
}

function buildStablecoinSymbolMatchers(trackedCoins: readonly StablecoinMeta[]): StablecoinSymbolMatcher[] {
  return trackedCoins
    .filter((coin) => coin.symbol.length >= 3 && !GENERIC_STABLECOIN_SYMBOLS.has(coin.symbol.toUpperCase()))
    .map((coin) => ({ coinId: coin.id, symbol: coin.symbol, matches: buildReserveSymbolMatcher(coin.symbol) }))
    .sort((left, right) => right.symbol.length - left.symbol.length || left.coinId.localeCompare(right.coinId));
}

function findReserveReviewRows(input: {
  activeCoins: readonly StablecoinMeta[];
  trackedCoins: readonly StablecoinMeta[];
  marketCapById: ReadonlyMap<string, number> | null;
}): {
  materialSlices: MaterialUnlinkedReserveRow[];
  dispositions: ReserveDispositionRow[];
} {
  const matchers = buildStablecoinSymbolMatchers(input.trackedCoins);
  const trackedIds = new Set(input.trackedCoins.map((coin) => coin.id));
  const dispositions: ReserveDispositionRow[] = [];
  const dispositionBySlice = new Map<string, ReserveNonLinkReview>();

  for (const coin of input.activeCoins) {
    const reviewedIndices = new Set<number>();
    for (const disposition of coin.reserveReview?.nonLinkDispositions ?? []) {
      const reserve = coin.reserves?.[disposition.reserveIndex];
      const duplicate = reviewedIndices.has(disposition.reserveIndex);
      reviewedIndices.add(disposition.reserveIndex);
      const stale = duplicate
        || reserve == null
        || reserve.name !== disposition.reserveName
        || reserve.coinId != null
        || (disposition.candidateCoinIds ?? []).some((candidateId) => !trackedIds.has(candidateId));
      const reviewStatus: ReserveDispositionRow["reviewStatus"] = stale
        ? "stale"
        : UNRESOLVED_NON_LINK_DISPOSITIONS.has(disposition.disposition)
          ? "unresolved"
          : "reviewed";
      dispositions.push({
        coinId: coin.id,
        symbol: coin.symbol,
        reserveIndex: disposition.reserveIndex,
        reserveName: disposition.reserveName,
        currentReserveName: reserve?.name ?? null,
        disposition: disposition.disposition,
        reviewStatus,
        rationale: disposition.rationale,
        candidateCoinIds: disposition.candidateCoinIds ?? [],
        reviewedAt: coin.reserveReview!.reviewedAt,
        reviewer: coin.reserveReview!.reviewer,
      });
      if (!stale) dispositionBySlice.set(`${coin.id}::${disposition.reserveIndex}`, disposition);
    }
  }

  const materialSlices: MaterialUnlinkedReserveRow[] = [];
  input.activeCoins.forEach((coin, coinIndex) => {
    (coin.reserves ?? []).forEach((reserve, reserveIndex) => {
      if (reserve.coinId || reserve.pct + WEIGHT_EPSILON < MATERIAL_RESERVE_PCT) return;
      const matched = matchers.filter((matcher) => matcher.matches(reserve.name));
      const basketSignal = /\b(?:stablecoins?|stables)\b/i.test(reserve.name);
      if (matched.length === 0 && !basketSignal && reserve.depType == null) return;
      const disposition = dispositionBySlice.get(`${coin.id}::${reserveIndex}`);
      const reviewStatus: MaterialUnlinkedReserveRow["reviewStatus"] = disposition == null
        ? "unreviewed"
        : UNRESOLVED_NON_LINK_DISPOSITIONS.has(disposition.disposition)
          ? "unresolved"
          : "reviewed";
      materialSlices.push({
        coinId: coin.id,
        symbol: coin.symbol,
        reserveIndex,
        reserveName: reserve.name,
        pct: reserve.pct,
        risk: reserve.risk,
        depType: reserve.depType ?? null,
        marketCapUsd: marketCapForId(input.marketCapById, coin.id),
        rank: coinIndex + 1,
        matchedSymbols: [...new Set(matched.map((matcher) => matcher.symbol))].sort(),
        candidateCoinIds: [...new Set(matched.map((matcher) => matcher.coinId))].sort(),
        reviewStatus,
        disposition: disposition?.disposition ?? null,
        dispositionRationale: disposition?.rationale ?? null,
      });
    });
  });

  materialSlices.sort((left, right) => {
    if (left.marketCapUsd != null || right.marketCapUsd != null) {
      const marketCapOrder = (right.marketCapUsd ?? -1) - (left.marketCapUsd ?? -1);
      if (marketCapOrder !== 0) return marketCapOrder;
    } else if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return (
      Number(right.depType != null) - Number(left.depType != null)
      || right.pct - left.pct
      || left.coinId.localeCompare(right.coinId)
      || left.reserveIndex - right.reserveIndex
    );
  });
  return {
    materialSlices,
    dispositions: dispositions.sort((left, right) => (
      left.coinId.localeCompare(right.coinId) || left.reserveIndex - right.reserveIndex
    )),
  };
}

function extractDependencyProvenance(
  activeCoins: readonly StablecoinMeta[],
  cardsById: ReadonlyMap<string, Record<string, unknown>>,
  hasReportCards: boolean,
): DependencySetProvenanceRow[] {
  return activeCoins.map((coin) => {
    if (!hasReportCards) {
      const dependencySet = deriveEffectiveDependencySet(coin);
      return {
        coinId: coin.id,
        symbol: coin.symbol,
        source: dependencySet.source,
        baseSource: dependencySet.baseSource,
        fallbackReason: dependencySet.fallbackReason,
        dependencyFromLive: dependencySet.dependencyFromLive,
        availableWeight: null,
        unavailableWeight: null,
        mappedLiveReserveShare: null,
        unmappedLiveReserveShare: null,
      };
    }

    const card = cardsById.get(coin.id);
    const rawInputs = card && isRecord(card.rawInputs) ? card.rawInputs : null;
    const dimensions = card && isRecord(card.dimensions) ? card.dimensions : null;
    const dependencyRisk = dimensions && isRecord(dimensions.dependencyRisk) ? dimensions.dependencyRisk : null;
    const diagnostics = dependencyRisk && isRecord(dependencyRisk.dependencyDiagnostics)
      ? dependencyRisk.dependencyDiagnostics
      : null;
    const source = rawInputs ? stringValue(rawInputs.dependencySource) : null;
    const baseSource = rawInputs ? stringValue(rawInputs.dependencyBaseSource) : null;
    const fallbackReason = rawInputs ? stringValue(rawInputs.dependencyFallbackReason) : null;
    const dependencyFromLive = rawInputs && typeof rawInputs.dependencyFromLive === "boolean"
      ? rawInputs.dependencyFromLive
      : null;
    const mappedWeight = rawInputs ? numberValue(rawInputs.mappedLiveReserveWeight) : null;

    return {
      coinId: coin.id,
      symbol: coin.symbol,
      source: source as DependencyDerivationSource | null,
      baseSource: baseSource as DependencyDerivationBaseSource | null,
      fallbackReason: fallbackReason as DependencyFallbackReason | null,
      dependencyFromLive,
      availableWeight: diagnostics ? numberValue(diagnostics.availableWeight) : null,
      unavailableWeight: diagnostics ? numberValue(diagnostics.unavailableWeight) : null,
      mappedLiveReserveShare: dependencyFromLive === true && mappedWeight != null ? mappedWeight : null,
      unmappedLiveReserveShare: dependencyFromLive === true && mappedWeight != null
        ? Math.max(0, 1 - mappedWeight)
        : null,
    };
  });
}

function contributionAvailabilityByEdge(cardsById: ReadonlyMap<string, Record<string, unknown>>): Map<string, boolean> {
  const availability = new Map<string, boolean>();
  for (const [dependentId, card] of cardsById) {
    const dimensions = isRecord(card.dimensions) ? card.dimensions : null;
    const dependencyRisk = dimensions && isRecord(dimensions.dependencyRisk) ? dimensions.dependencyRisk : null;
    const diagnostics = dependencyRisk && isRecord(dependencyRisk.dependencyDiagnostics)
      ? dependencyRisk.dependencyDiagnostics
      : null;
    if (!diagnostics || !Array.isArray(diagnostics.contributions)) continue;
    diagnostics.contributions.forEach((candidate, index) => {
      const path = `card ${dependentId}.dimensions.dependencyRisk.dependencyDiagnostics.contributions[${index}]`;
      const contribution = reportCardRecord(candidate, path);
      const id = reportCardId(contribution.id, `${path}.id`);
      if (typeof contribution.available !== "boolean") malformedReportCard(`${path}.available`, "expected a boolean");
      availability.set(
        `${dependentId}::${id}::${dependencyTypeValue(contribution.type, `${path}.type`)}`,
        contribution.available,
      );
    });
  }
  return availability;
}

function classifyTargetScoreability(input: {
  upstreamId: string;
  dependentId: string;
  type: DependencyType;
  lifecycle: DependencyTargetLifecycle | "unknown";
  cardsById: ReadonlyMap<string, Record<string, unknown>>;
  contributionAvailability: ReadonlyMap<string, boolean>;
  hasReportCards: boolean;
}): TargetScoreability {
  if (input.lifecycle === "unknown") return "unknown-target";
  if (input.lifecycle === "pre-launch") return "pre-launch";
  if (input.lifecycle === "frozen") return "frozen";
  if (!input.hasReportCards) return "not-evaluated";
  const edgeAvailability = input.contributionAvailability.get(
    `${input.dependentId}::${input.upstreamId}::${input.type}`,
  );
  if (edgeAvailability != null) return edgeAvailability ? "scoreable" : "active-nr";
  const upstreamCard = input.cardsById.get(input.upstreamId);
  if (!upstreamCard) return "not-evaluated";
  return numberValue(upstreamCard.overallScore) != null ? "scoreable" : "active-nr";
}

function buildDependencyEdgeRows(input: {
  edges: readonly DependencyGraphEdge[];
  graphSource: DependencyEdgeCoverageRow["graphSource"];
  trackedCoins: readonly StablecoinMeta[];
  cardsById: ReadonlyMap<string, Record<string, unknown>>;
  hasReportCards: boolean;
  targetDispositions: readonly DependencyTargetDisposition[];
}): DependencyEdgeCoverageRow[] {
  const trackedById = new Map(input.trackedCoins.map((coin) => [coin.id, coin]));
  const dispositionByTarget = new Map(input.targetDispositions.map((entry) => [entry.targetId, entry]));
  const contributionAvailability = contributionAvailabilityByEdge(input.cardsById);
  return input.edges.map((edge) => {
    const upstream = trackedById.get(edge.from);
    const dependent = trackedById.get(edge.to);
    const lifecycle = lifecycleForMeta(upstream);
    return {
      ...edge,
      graphSource: input.graphSource,
      upstreamSymbol: upstream?.symbol ?? null,
      dependentSymbol: dependent?.symbol ?? null,
      targetLifecycle: lifecycle,
      targetScoreability: classifyTargetScoreability({
        upstreamId: edge.from,
        dependentId: edge.to,
        type: edge.type,
        lifecycle,
        cardsById: input.cardsById,
        contributionAvailability,
        hasReportCards: input.hasReportCards,
      }),
      targetDisposition: dispositionByTarget.get(edge.from) ?? null,
    };
  }).sort((left, right) => (
    left.to.localeCompare(right.to)
    || left.from.localeCompare(right.from)
    || left.type.localeCompare(right.type)
    || left.weight - right.weight
  ));
}

function validateTargetDispositions(input: {
  trackedCoins: readonly StablecoinMeta[];
  edges: readonly DependencyEdgeCoverageRow[];
  referencedTargetIds: ReadonlySet<string>;
  dispositions: readonly DependencyTargetDisposition[];
  hasReportCards: boolean;
}): TargetDispositionValidationIssue[] {
  const issues: TargetDispositionValidationIssue[] = [];
  const trackedById = new Map(input.trackedCoins.map((coin) => [coin.id, coin]));
  const seen = new Set<string>();
  for (const disposition of input.dispositions) {
    if (seen.has(disposition.targetId)) {
      issues.push({
        targetId: disposition.targetId,
        reason: "duplicate-disposition",
        detail: "Unavailable target has more than one disposition.",
      });
    }
    seen.add(disposition.targetId);
    const target = trackedById.get(disposition.targetId);
    if (!target) {
      issues.push({
        targetId: disposition.targetId,
        reason: "unknown-target",
        detail: "Disposition target is not a canonical tracked stablecoin.",
      });
      continue;
    }
    const lifecycle = lifecycleForMeta(target);
    if (lifecycle !== disposition.expectedLifecycle) {
      issues.push({
        targetId: disposition.targetId,
        reason: "lifecycle-mismatch",
        detail: `Expected ${disposition.expectedLifecycle}, found ${lifecycle}.`,
      });
    }
    if (
      !disposition.reviewer.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(disposition.reviewedAt)
      || disposition.sources.length === 0
      || disposition.sources.some((source) => !source.label.trim() || !/^https:\/\//.test(source.url))
      || !disposition.rationale.trim()
    ) {
      issues.push({
        targetId: disposition.targetId,
        reason: "invalid-provenance",
        detail: "Disposition requires reviewer, ISO review date, rationale, and at least one HTTPS source.",
      });
    }
    if (!input.referencedTargetIds.has(disposition.targetId)) {
      issues.push({
        targetId: disposition.targetId,
        reason: "no-current-edge",
        detail: "Disposition target is no longer referenced by the audited dependency graph.",
      });
    }
    if (
      input.hasReportCards
      && input.edges.some((edge) => edge.from === disposition.targetId && edge.targetScoreability === "scoreable")
    ) {
      issues.push({
        targetId: disposition.targetId,
        reason: "target-now-scoreable",
        detail: "Target is now scoreable; remove the unavailable-target disposition.",
      });
    }
  }
  return issues.sort((left, right) => left.targetId.localeCompare(right.targetId) || left.reason.localeCompare(right.reason));
}

function validateAdapterMappingReviews(input: {
  activeCoins: readonly StablecoinMeta[];
  provenance: readonly DependencySetProvenanceRow[];
  reviews: readonly DependencyAdapterMappingReview[];
  hasReportCards: boolean;
}): AdapterMappingReviewGapRow[] {
  const gaps: AdapterMappingReviewGapRow[] = [];
  const activeAdapters = new Set<string>(
    input.activeCoins.flatMap((coin) => coin.liveReservesConfig?.adapter ? [coin.liveReservesConfig.adapter] : []),
  );
  const reviewByAdapter = new Map<string, DependencyAdapterMappingReview>();
  for (const review of input.reviews) {
    if (reviewByAdapter.has(review.adapter)) {
      gaps.push({
        coinId: null,
        adapter: review.adapter,
        reason: "duplicate-review",
        detail: "Adapter mapping registry contains a duplicate review.",
      });
    }
    reviewByAdapter.set(review.adapter, review);
    if (!activeAdapters.has(review.adapter)) {
      gaps.push({
        coinId: null,
        adapter: review.adapter,
        reason: "stale-review",
        detail: "Reviewed adapter is not configured by any active stablecoin.",
      });
    }
    if (
      !review.reviewer.trim()
      || !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAt)
      || review.sourceFiles.length === 0
      || review.sourceFiles.some((sourceFile) => (
        !sourceFile.startsWith("worker/src/cron/reserve-adapters/") || !existsSync(sourceFile)
      ))
      || !review.rationale.trim()
    ) {
      gaps.push({
        coinId: null,
        adapter: review.adapter,
        reason: "invalid-provenance",
        detail: "Adapter review requires reviewer, ISO review date, rationale, and reserve-adapter source files.",
      });
    }
  }

  if (!input.hasReportCards) return gaps;
  const activeById = new Map(input.activeCoins.map((coin) => [coin.id, coin]));
  for (const row of input.provenance) {
    if (row.baseSource !== "live-reserve") continue;
    const adapter = activeById.get(row.coinId)?.liveReservesConfig?.adapter;
    if (adapter && reviewByAdapter.has(adapter)) continue;
    gaps.push({
      coinId: row.coinId,
      adapter: adapter ?? "unknown",
      reason: "missing-review",
      detail: adapter
        ? "Mapped live dependency set has no reviewed adapter-mapping rule."
        : "Mapped live dependency set has no configured adapter identity.",
    });
  }
  return gaps.sort((left, right) => (
    left.adapter.localeCompare(right.adapter) || (left.coinId ?? "").localeCompare(right.coinId ?? "")
  ));
}

function findReserveSlicesMissingCoinId(
  activeCoins: readonly StablecoinMeta[],
  marketCapById: ReadonlyMap<string, number> | null,
): ReserveSliceCoverageRow[] {
  const rows: ReserveSliceCoverageRow[] = [];

  activeCoins.forEach((coin, coinIndex) => {
    (coin.reserves ?? []).forEach((reserve, reserveIndex) => {
      if (reserve.coinId) return;
      rows.push({
        coinId: coin.id,
        symbol: coin.symbol,
        reserveIndex,
        reserveName: reserve.name,
        pct: reserve.pct,
        risk: reserve.risk,
        depType: reserve.depType ?? null,
        marketCapUsd: marketCapForId(marketCapById, coin.id),
        rank: coinIndex + 1,
      });
    });
  });

  return sortByMarketCapOrRank(rows);
}

function findMissingCandidates(input: {
  activeCoins: readonly StablecoinMeta[];
  graph: DependencyGraphCoverageSummary;
  marketCapById: ReadonlyMap<string, number> | null;
}): MissingDependencyCandidateRow[] {
  const participantIds = new Set(input.graph.participantIds);
  const rows = input.activeCoins.flatMap((coin, index): MissingDependencyCandidateRow[] => (
    participantIds.has(coin.id)
      ? []
      : [{
          coinId: coin.id,
          symbol: coin.symbol,
          name: coin.name,
          marketCapUsd: marketCapForId(input.marketCapById, coin.id),
          rank: index + 1,
        }]
  ));

  return sortByMarketCapOrRank(rows);
}

function findL2BeatDeploymentContextRows(activeCoins: readonly StablecoinMeta[]): L2BeatDeploymentContextRow[] {
  const rows: L2BeatDeploymentContextRow[] = [];
  const seen = new Set<string>();

  for (const coin of activeCoins) {
    const deployments = [
      ...(coin.contracts ?? []).map((contract) => ({ ...contract, routeKind: "canonical-contract" as const })),
      ...(coin.tradedContracts ?? []).map((contract) => ({ ...contract, routeKind: "traded-contract" as const })),
    ];

    for (const deployment of deployments) {
      const context = getL2BeatInfrastructureContext(deployment.chain);
      if (!context) continue;
      const key = `${coin.id}::${deployment.chain}::${deployment.routeKind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        coinId: coin.id,
        symbol: coin.symbol,
        chainId: deployment.chain,
        routeKind: deployment.routeKind,
        projectId: context.projectId,
        l2beatName: context.name,
        layer: context.layer,
        category: context.category,
        hostChain: context.hostChain,
        hostChainId: context.hostChainId,
        stage: context.stage,
        isUnderReview: context.isUnderReview,
        chainEnvironmentScore: context.chainEnvironmentScore,
        chainTier: coin.chainTier ?? null,
        deploymentModel: coin.deploymentModel ?? null,
      });
    }
  }

  return rows.sort((left, right) => (
    left.chainEnvironmentScore - right.chainEnvironmentScore ||
    left.coinId.localeCompare(right.coinId) ||
    left.chainId.localeCompare(right.chainId) ||
    left.routeKind.localeCompare(right.routeKind)
  ));
}

export function buildDependencyCoverageAudit(input: DependencyCoverageAuditInput = {}): DependencyCoverageAudit {
  const activeCoins = input.activeCoins ?? ACTIVE_STABLECOINS;
  const trackedCoins = input.trackedCoins ?? (input.activeCoins ? activeCoins : TRACKED_STABLECOINS);
  const targetDispositions = input.targetDispositions
    ?? (input.activeCoins ? [] : DEPENDENCY_TARGET_DISPOSITIONS);
  const adapterMappingReviews = input.adapterMappingReviews
    ?? (input.activeCoins ? [] : DEPENDENCY_ADAPTER_MAPPING_REVIEWS);
  const activeIds = new Set(activeCoins.map((coin) => coin.id));
  const marketCapById = buildMarketCapMapFromStablecoins(input.stablecoins);
  const parsedReportCards = input.reportCards === undefined ? null : parseReportCardInput(input.reportCards);
  const hasReportCards = parsedReportCards !== null;
  const cardsById = parsedReportCards?.cardsById ?? new Map<string, Record<string, unknown>>();
  const warnings: string[] = [];
  if (input.stablecoins !== undefined && marketCapById?.size === 0) {
    warnings.push("Stablecoin payload did not contain any pegged asset rows.");
  }

  const staticEdges = buildDependencyGraphEdges(activeCoins);
  const staticGraph = summarizeDependencyGraph(staticEdges, activeIds);
  const staticGraphDiagnostics = diagnoseStaticGraph(staticEdges, activeCoins);

  let reportCardGraph: DependencyGraphCoverageSummary | null = null;
  let reportCardEdges: DependencyGraphEdge[] | null = null;
  let reportCardGraphDiagnostics: DependencyGraphDiagnostics | null = null;
  if (parsedReportCards) {
    reportCardEdges = parsedReportCards.edges;
    reportCardGraph = summarizeDependencyGraph(reportCardEdges, activeIds);
    reportCardGraphDiagnostics = diagnoseDependencyGraph(reportCardEdges);
  }

  const graphForMissingCandidates = reportCardGraph ?? staticGraph;
  const selectedEdges = reportCardEdges ?? staticEdges;
  const dependencyEdges = buildDependencyEdgeRows({
    edges: selectedEdges,
    graphSource: reportCardEdges ? "report-card" : "static",
    trackedCoins,
    cardsById,
    hasReportCards,
    targetDispositions,
  });
  const missingCandidates = findMissingCandidates({
    activeCoins,
    graph: graphForMissingCandidates,
    marketCapById,
  });
  const reserveMissing = findReserveSlicesMissingCoinId(activeCoins, marketCapById);
  const depTypeWithoutCoinIdWarnings = reserveMissing.filter((row) => row.depType != null);
  const manualReview = findManualDependencyReviewRows(activeCoins);
  const reserveReview = findReserveReviewRows({ activeCoins, trackedCoins, marketCapById });
  const rawAuthoredDuplicates = findRawAuthoredDuplicates(activeCoins);
  const overweightEffectiveSets = findOverweightEffectiveSets(activeCoins, cardsById, hasReportCards);
  const dependencyProvenance = extractDependencyProvenance(activeCoins, cardsById, hasReportCards);
  const targetDispositionValidationIssues = validateTargetDispositions({
    trackedCoins,
    edges: dependencyEdges,
    referencedTargetIds: new Set([...staticEdges, ...selectedEdges].map((edge) => edge.from)),
    dispositions: targetDispositions,
    hasReportCards,
  });
  const adapterMappingReviewGaps = validateAdapterMappingReviews({
    activeCoins,
    provenance: dependencyProvenance,
    reviews: adapterMappingReviews,
    hasReportCards,
  });
  const l2beatDeploymentContext = findL2BeatDeploymentContextRows(activeCoins);
  const unavailableTargetEdges = dependencyEdges.filter((edge) => (
    edge.targetScoreability !== "scoreable" && edge.targetScoreability !== "not-evaluated"
  ));
  const unavailableTargetDispositionGaps = new Set(
    unavailableTargetEdges.filter((edge) => edge.targetDisposition == null).map((edge) => edge.from),
  );
  const availableWeights = dependencyProvenance.flatMap((row) => row.availableWeight == null ? [] : [row.availableWeight]);
  const unavailableWeights = dependencyProvenance.flatMap((row) => row.unavailableWeight == null ? [] : [row.unavailableWeight]);
  const liveShares = dependencyProvenance.filter((row) => (
    row.mappedLiveReserveShare != null && row.unmappedLiveReserveShare != null
  ));

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode ?? "static",
    summary: {
      activeCount: activeCoins.length,
      staticEdgeCount: staticGraph.edgeCount,
      staticActiveEdgeCount: staticGraph.activeEdgeCount,
      staticParticipantCount: staticGraph.participantCount,
      staticDependentCount: staticGraph.dependentCount,
      staticUpstreamOnlyCount: staticGraph.upstreamOnlyCount,
      reportCardEdgeCount: reportCardGraph?.edgeCount ?? null,
      reportCardActiveEdgeCount: reportCardGraph?.activeEdgeCount ?? null,
      reportCardParticipantCount: reportCardGraph?.participantCount ?? null,
      reportCardDependentCount: reportCardGraph?.dependentCount ?? null,
      reportCardUpstreamOnlyCount: reportCardGraph?.upstreamOnlyCount ?? null,
      manualOnlyDependencyCount: manualReview.manualOnlyDependencies.length,
      reserveSlicesMissingCoinId: reserveMissing.length,
      depTypeWithoutCoinIdWarnings: depTypeWithoutCoinIdWarnings.length,
      staticSelfEdgeCount: staticGraphDiagnostics.selfEdges.length,
      staticDuplicateEdgeCount: staticGraphDiagnostics.duplicateEdges.length,
      staticStronglyConnectedComponentCount: staticGraphDiagnostics.stronglyConnectedComponents.length,
      reportCardSelfEdgeCount: reportCardGraphDiagnostics?.selfEdges.length ?? null,
      reportCardDuplicateEdgeCount: reportCardGraphDiagnostics?.duplicateEdges.length ?? null,
      reportCardStronglyConnectedComponentCount:
        reportCardGraphDiagnostics?.stronglyConnectedComponents.length ?? null,
      rawAuthoredDuplicateCount: rawAuthoredDuplicates.length,
      overweightEffectiveSetCount: overweightEffectiveSets.length,
      unknownTargetEdgeCount: dependencyEdges.filter((edge) => edge.targetLifecycle === "unknown").length,
      unavailableTargetEdgeCount: unavailableTargetEdges.length,
      unavailableTargetDispositionGapCount: unavailableTargetDispositionGaps.size,
      targetDispositionValidationIssueCount: targetDispositionValidationIssues.length,
      adapterMappingReviewGapCount: adapterMappingReviewGaps.length,
      dependencyProvenanceCount: dependencyProvenance.length,
      dependencyAvailableWeight: availableWeights.length > 0
        ? availableWeights.reduce((sum, weight) => sum + weight, 0)
        : null,
      dependencyUnavailableWeight: unavailableWeights.length > 0
        ? unavailableWeights.reduce((sum, weight) => sum + weight, 0)
        : null,
      liveMappedReserveShare: liveShares.length > 0
        ? liveShares.reduce((sum, row) => sum + row.mappedLiveReserveShare!, 0) / liveShares.length
        : null,
      liveUnmappedReserveShare: liveShares.length > 0
        ? liveShares.reduce((sum, row) => sum + row.unmappedLiveReserveShare!, 0) / liveShares.length
        : null,
      materialUnlinkedReserveSliceCount: reserveReview.materialSlices.length,
      reviewedReserveDispositionCount:
        reserveReview.dispositions.filter((row) => row.reviewStatus === "reviewed").length,
      unresolvedReserveDispositionCount:
        reserveReview.dispositions.filter((row) => row.reviewStatus === "unresolved").length,
      unresolvedMaterialReserveSliceCount:
        reserveReview.materialSlices.filter((row) => row.reviewStatus !== "reviewed").length,
      staleReserveDispositionCount:
        reserveReview.dispositions.filter((row) => row.reviewStatus === "stale").length,
      manualDependencyReviewGapCount: manualReview.gaps.length,
      missingCandidateCount: missingCandidates.length,
      l2beatDeploymentContextCount: l2beatDeploymentContext.length,
      l2beatLayer3DeploymentContextCount: l2beatDeploymentContext.filter((row) => row.layer === "layer3").length,
      l2beatUnderReviewDeploymentContextCount: l2beatDeploymentContext.filter((row) => row.isUnderReview).length,
      missingCandidateRankSource: marketCapById ? "stablecoin-api-market-cap" : "local-canonical-order",
      missingCandidateGraphSource: reportCardGraph ? "report-card" : "static",
    },
    staticGraph,
    staticGraphDiagnostics,
    reportCardGraph,
    reportCardGraphDiagnostics,
    dependencyEdges,
    dependencyProvenance,
    rawAuthoredDuplicates,
    overweightEffectiveSets,
    manualOnlyDependencies: manualReview.manualOnlyDependencies,
    manualDependencyReviewGaps: manualReview.gaps,
    reserveSlicesMissingCoinId: reserveMissing,
    depTypeWithoutCoinIdWarnings,
    materialUnlinkedReserveSlices: reserveReview.materialSlices,
    reserveDispositions: reserveReview.dispositions,
    targetDispositionValidationIssues,
    adapterMappingReviews: [...adapterMappingReviews],
    adapterMappingReviewGaps,
    highestMarketCapMissingCandidates: missingCandidates,
    l2beatDeploymentContext,
    warnings,
  };
}

function renderMissingCandidates(rows: readonly MissingDependencyCandidateRow[]): string[] {
  const clipped = rows.slice(0, MISSING_CANDIDATE_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | local rank",
    "--- | ---: | ---:",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.rank,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderReserveRows(rows: readonly ReserveSliceCoverageRow[], limit: number): string[] {
  const clipped = rows.slice(0, limit);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | reserve index | reserve slice | pct | risk | depType",
    "--- | ---: | ---: | --- | ---: | --- | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.reserveIndex,
      row.reserveName,
      row.pct,
      row.risk,
      row.depType,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderManualDependencyRows(rows: readonly ManualOnlyDependencyRow[]): string[] {
  const clipped = rows.slice(0, MANUAL_DEPENDENCY_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | dependency | type | weight | review",
    "--- | --- | --- | ---: | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.dependencyId,
      row.dependencyType,
      row.weight,
      row.reviewStatus,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderGraphDiagnostics(
  label: string,
  diagnostics: DependencyGraphDiagnostics | null,
): string[] {
  if (!diagnostics) return [`_${label} graph not supplied._`];
  const duplicateKeys = diagnostics.duplicateEdges.map((row) => `${row.key} (${row.count})`);
  return [
    `- ${label} self-edges: ${diagnostics.selfEdges.length}`,
    `- ${label} duplicate edge groups: ${diagnostics.duplicateEdges.length}`,
    `- ${label} multi-node SCCs: ${diagnostics.stronglyConnectedComponents.length}`,
    ...(diagnostics.selfEdges.length > 0
      ? [`- Self-edge details: ${diagnostics.selfEdges.map((edge) => `${edge.from}:${edge.type}`).join(", ")}`]
      : []),
    ...(duplicateKeys.length > 0 ? [`- Duplicate details: ${duplicateKeys.join(", ")}`] : []),
    ...(diagnostics.stronglyConnectedComponents.length > 0
      ? [`- SCC details: ${diagnostics.stronglyConnectedComponents.map((row) => row.join(" <-> ")).join(", ")}`]
      : []),
  ];
}

function renderDependencyEdges(rows: readonly DependencyEdgeCoverageRow[]): string[] {
  const clipped = rows.slice(0, FINDING_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "dependent | upstream | type | weight | lifecycle | scoreability | unavailable disposition",
    "--- | --- | --- | ---: | --- | --- | ---",
    ...clipped.map((row) => [
      `${row.dependentSymbol ?? "?"} (${row.to})`,
      `${row.upstreamSymbol ?? "?"} (${row.from})`,
      row.type,
      row.weight,
      row.targetLifecycle,
      row.targetScoreability,
      row.targetDisposition?.action ?? null,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderDependencyProvenance(rows: readonly DependencySetProvenanceRow[]): string[] {
  const relevant = rows.filter((row) => (
    row.source !== "none" || row.fallbackReason != null || row.availableWeight != null || row.unavailableWeight != null
  ));
  const clipped = relevant.slice(0, FINDING_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | source | base | fallback | available | unavailable | live mapped | live unmapped",
    "--- | --- | --- | --- | ---: | ---: | ---: | ---:",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.source,
      row.baseSource,
      row.fallbackReason,
      row.availableWeight,
      row.unavailableWeight,
      row.mappedLiveReserveShare,
      row.unmappedLiveReserveShare,
    ].map(markdownValue).join(" | ")),
    ...(relevant.length > clipped.length ? [`_Plus ${relevant.length - clipped.length} more rows._`] : []),
  ];
}

function renderMaterialReserveRows(rows: readonly MaterialUnlinkedReserveRow[]): string[] {
  const clipped = rows.slice(0, FINDING_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | mcap | index | slice | pct | matches | review | disposition",
    "--- | ---: | ---: | --- | ---: | --- | --- | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.reserveIndex,
      row.reserveName,
      row.pct,
      row.matchedSymbols.join(", ") || "stablecoin basket/depType",
      row.reviewStatus,
      row.disposition,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderFindingRows(
  rows: ReadonlyArray<{ coinId?: string | null; targetId?: string; adapter?: string; reason: string; detail?: string }>,
): string[] {
  const clipped = rows.slice(0, FINDING_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "subject | reason | detail",
    "--- | --- | ---",
    ...clipped.map((row) => [
      row.coinId ?? row.targetId ?? row.adapter ?? "registry",
      row.reason,
      row.detail ?? "",
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

function renderRawDuplicateRows(rows: readonly RawAuthoredDuplicateRow[]): string[] {
  const clipped = rows.slice(0, FINDING_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | source | upstream | type | indices | total weight",
    "--- | --- | --- | --- | --- | ---:",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.source,
      row.dependencyId,
      row.dependencyType,
      row.indices.join(", "),
      row.totalWeight,
    ].map(markdownValue).join(" | ")),
  ];
}

function renderOverweightRows(rows: readonly OverweightDependencySetRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "coin | source | total weight | dependencies",
    "--- | --- | ---: | ---",
    ...rows.slice(0, FINDING_LIMIT).map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.source,
      row.totalWeight,
      row.dependencies.map((dependency) => `${dependency.id}:${dependency.type ?? "collateral"}=${dependency.weight}`).join(", "),
    ].map(markdownValue).join(" | ")),
  ];
}

function renderReserveDispositionRows(rows: readonly ReserveDispositionRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "coin | index | reviewed slice | current slice | disposition | status | reviewed",
    "--- | ---: | --- | --- | --- | --- | ---",
    ...rows.slice(0, FINDING_LIMIT).map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.reserveIndex,
      row.reserveName,
      row.currentReserveName,
      row.disposition,
      row.reviewStatus,
      `${row.reviewer}, ${row.reviewedAt}`,
    ].map(markdownValue).join(" | ")),
  ];
}

function renderManualReviewGapRows(rows: readonly ManualDependencyReviewGapRow[]): string[] {
  if (rows.length === 0) return ["_None._"];
  return [
    "coin | dependency | type | reason",
    "--- | --- | --- | ---",
    ...rows.slice(0, FINDING_LIMIT).map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.dependencyId,
      row.dependencyType,
      row.reason,
    ].map(markdownValue).join(" | ")),
  ];
}

function renderL2BeatDeploymentContextRows(rows: readonly L2BeatDeploymentContextRow[]): string[] {
  const clipped = rows.slice(0, L2BEAT_CONTEXT_LIMIT);
  if (clipped.length === 0) return ["_None._"];
  return [
    "coin | chain | route | L2BEAT project | layer | category | host | stage | env score | chainTier | deploymentModel",
    "--- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      row.chainId,
      row.routeKind,
      `${row.l2beatName} (${row.projectId})`,
      row.layer,
      row.category,
      row.hostChain,
      row.stage,
      row.chainEnvironmentScore,
      row.chainTier,
      row.deploymentModel,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > clipped.length ? [`_Plus ${rows.length - clipped.length} more rows._`] : []),
  ];
}

export function renderDependencyCoverageAuditMarkdown(audit: DependencyCoverageAudit): string {
  const lines = [
    "# Dependency Coverage Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Mode: ${audit.mode}`,
    "",
    "## Summary",
    "",
    `- Active stablecoins: ${audit.summary.activeCount}`,
    `- Static dependency edges: ${audit.summary.staticEdgeCount}`,
    `- Static active-to-active dependency edges: ${audit.summary.staticActiveEdgeCount}`,
    `- Static graph participants: ${audit.summary.staticParticipantCount}`,
    `- Static graph dependents: ${audit.summary.staticDependentCount}`,
    `- Static graph upstream-only participants: ${audit.summary.staticUpstreamOnlyCount}`,
    `- Report-card dependency edges: ${audit.summary.reportCardEdgeCount ?? "not supplied"}`,
    `- Report-card graph participants: ${audit.summary.reportCardParticipantCount ?? "not supplied"}`,
    `- Manual-only dependency entries: ${audit.summary.manualOnlyDependencyCount}`,
    `- Reserve slices missing coinId: ${audit.summary.reserveSlicesMissingCoinId}`,
    `- depType without coinId warnings: ${audit.summary.depTypeWithoutCoinIdWarnings}`,
    `- Static self / duplicate / SCC findings: ${audit.summary.staticSelfEdgeCount} / ${audit.summary.staticDuplicateEdgeCount} / ${audit.summary.staticStronglyConnectedComponentCount}`,
    `- Report-card self / duplicate / SCC findings: ${audit.summary.reportCardSelfEdgeCount ?? "not supplied"} / ${audit.summary.reportCardDuplicateEdgeCount ?? "not supplied"} / ${audit.summary.reportCardStronglyConnectedComponentCount ?? "not supplied"}`,
    `- Raw authored duplicate groups: ${audit.summary.rawAuthoredDuplicateCount}`,
    `- Overweight effective dependency sets: ${audit.summary.overweightEffectiveSetCount}`,
    `- Unknown target edges: ${audit.summary.unknownTargetEdgeCount}`,
    `- Unavailable target edges: ${audit.summary.unavailableTargetEdgeCount}`,
    `- Unavailable target disposition gaps: ${audit.summary.unavailableTargetDispositionGapCount}`,
    `- Target disposition validation issues: ${audit.summary.targetDispositionValidationIssueCount}`,
    `- Adapter mapping review gaps: ${audit.summary.adapterMappingReviewGapCount}`,
    `- Dependency available / unavailable weight: ${audit.summary.dependencyAvailableWeight ?? "not supplied"} / ${audit.summary.dependencyUnavailableWeight ?? "not supplied"}`,
    `- Average live mapped / unmapped reserve share: ${audit.summary.liveMappedReserveShare ?? "not supplied"} / ${audit.summary.liveUnmappedReserveShare ?? "not supplied"}`,
    `- Material stablecoin-looking unlinked slices: ${audit.summary.materialUnlinkedReserveSliceCount}`,
    `- Reviewed / unresolved / stale reserve dispositions: ${audit.summary.reviewedReserveDispositionCount} / ${audit.summary.unresolvedReserveDispositionCount} / ${audit.summary.staleReserveDispositionCount}`,
    `- Unresolved material reserve slices: ${audit.summary.unresolvedMaterialReserveSliceCount}`,
    `- Manual dependency review gaps: ${audit.summary.manualDependencyReviewGapCount}`,
    `- Missing graph-participant candidates: ${audit.summary.missingCandidateCount}`,
    `- L2BEAT deployment context rows: ${audit.summary.l2beatDeploymentContextCount}`,
    `- L2BEAT layer 3 context rows: ${audit.summary.l2beatLayer3DeploymentContextCount}`,
    `- L2BEAT under-review context rows: ${audit.summary.l2beatUnderReviewDeploymentContextCount}`,
    `- Missing candidate graph source: ${audit.summary.missingCandidateGraphSource}`,
    `- Missing candidate rank source: ${audit.summary.missingCandidateRankSource}`,
    "",
    "## Graph Diagnostics",
    "",
    ...renderGraphDiagnostics("Static", audit.staticGraphDiagnostics),
    ...renderGraphDiagnostics("Report-card", audit.reportCardGraphDiagnostics),
    "",
    "## Raw Authored Duplicate Groups",
    "",
    ...renderRawDuplicateRows(audit.rawAuthoredDuplicates),
    "",
    "## Overweight Effective Dependency Sets",
    "",
    ...renderOverweightRows(audit.overweightEffectiveSets),
    "",
    "## Dependency Edges And Target Status",
    "",
    ...renderDependencyEdges(audit.dependencyEdges),
    "",
    "## Dependency Provenance",
    "",
    ...renderDependencyProvenance(audit.dependencyProvenance),
    "",
    "## Material Stablecoin-Looking Unlinked Reserves",
    "",
    ...renderMaterialReserveRows(audit.materialUnlinkedReserveSlices),
    "",
    "## Reserve Non-Link Dispositions",
    "",
    ...renderReserveDispositionRows(audit.reserveDispositions),
    "",
    "## Manual Dependency Review Gaps",
    "",
    ...renderManualReviewGapRows(audit.manualDependencyReviewGaps),
    "",
    "## Target Disposition Validation",
    "",
    ...renderFindingRows(audit.targetDispositionValidationIssues),
    "",
    "## Adapter Mapping Review Gaps",
    "",
    ...renderFindingRows(audit.adapterMappingReviewGaps),
    "",
    "## Highest-Market-Cap Missing Candidates",
    "",
    ...renderMissingCandidates(audit.highestMarketCapMissingCandidates),
    "",
    "## depType Without coinId Warnings",
    "",
    ...renderReserveRows(audit.depTypeWithoutCoinIdWarnings, RESERVE_SLICE_LIMIT),
    "",
    "## Manual-Only Dependencies",
    "",
    ...renderManualDependencyRows(audit.manualOnlyDependencies),
    "",
    "## L2BEAT Deployment Context",
    "",
    ...renderL2BeatDeploymentContextRows(audit.l2beatDeploymentContext),
    "",
    "## Reserve Slices Missing coinId",
    "",
    ...renderReserveRows(audit.reserveSlicesMissingCoinId, RESERVE_SLICE_LIMIT),
    "",
    "## Warnings",
    "",
    ...(audit.warnings.length > 0 ? audit.warnings.map((warning) => `- ${warning}`) : ["_None._"]),
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

export function evaluateDependencyCoverageBaseline(
  audit: DependencyCoverageAudit,
  baseline: DependencyCoverageBaseline,
): string[] {
  const failures: string[] = [];
  const structuralFindings: Array<[string, number]> = [
    ["static self-edge", audit.summary.staticSelfEdgeCount],
    ["static duplicate-edge group", audit.summary.staticDuplicateEdgeCount],
    ["static strongly connected component", audit.summary.staticStronglyConnectedComponentCount],
    ["report-card self-edge", audit.summary.reportCardSelfEdgeCount ?? 0],
    ["report-card duplicate-edge group", audit.summary.reportCardDuplicateEdgeCount ?? 0],
    ["report-card strongly connected component", audit.summary.reportCardStronglyConnectedComponentCount ?? 0],
    ["overweight effective dependency set", audit.summary.overweightEffectiveSetCount],
    ["unknown dependency target edge", audit.summary.unknownTargetEdgeCount],
    ["depType without coinId", audit.summary.depTypeWithoutCoinIdWarnings],
  ];
  for (const [label, count] of structuralFindings) {
    if (count > 0) failures.push(`${label} invariant failed with ${count} finding${count === 1 ? "" : "s"}`);
  }

  const ratchets: Array<[keyof DependencyCoverageBaseline, number, string]> = [
    ["reserveSlicesMissingCoinId", audit.summary.reserveSlicesMissingCoinId, "reserve slices missing coinId"],
    [
      "unresolvedMaterialReserveSlices",
      audit.summary.unresolvedMaterialReserveSliceCount,
      "unresolved material reserve slices",
    ],
    ["manualDependencyReviewGaps", audit.summary.manualDependencyReviewGapCount, "manual dependency review gaps"],
    ["staleReserveDispositions", audit.summary.staleReserveDispositionCount, "stale reserve dispositions"],
    [
      "unavailableTargetDispositionGaps",
      audit.summary.unavailableTargetDispositionGapCount,
      "unavailable target disposition gaps",
    ],
    [
      "targetDispositionValidationIssues",
      audit.summary.targetDispositionValidationIssueCount,
      "target disposition validation issues",
    ],
    ["adapterMappingReviewGaps", audit.summary.adapterMappingReviewGapCount, "adapter mapping review gaps"],
  ];
  for (const [key, count, label] of ratchets) {
    const limit = baseline[key];
    if (count > limit) failures.push(`${label} increased from ${limit} to ${count}`);
  }
  return failures;
}

const DEPENDENCY_COVERAGE_BASELINE_KEYS = [
  "reserveSlicesMissingCoinId",
  "unresolvedMaterialReserveSlices",
  "manualDependencyReviewGaps",
  "staleReserveDispositions",
  "unavailableTargetDispositionGaps",
  "targetDispositionValidationIssues",
  "adapterMappingReviewGaps",
] as const satisfies readonly (keyof DependencyCoverageBaseline)[];

function parseBaseline(payload: unknown): DependencyCoverageBaseline {
  if (!isRecord(payload)) throw new Error("Dependency coverage baseline must be an object.");
  const record = payload;
  const expectedKeys = new Set<string>(DEPENDENCY_COVERAGE_BASELINE_KEYS);
  const actualKeys = Object.keys(record);
  const missing = DEPENDENCY_COVERAGE_BASELINE_KEYS.filter((key) => !(key in record));
  const unknown = actualKeys.filter((key) => !expectedKeys.has(key)).sort();
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(unknown.length > 0 ? [`unknown: ${unknown.join(", ")}`] : []),
    ];
    throw new Error(`Dependency coverage baseline must contain the exact supported keys (${details.join("; ")}).`);
  }

  function baselineCount(key: keyof DependencyCoverageBaseline): number {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`Dependency coverage baseline ${key} must be a nonnegative integer.`);
    }
    return value;
  }
  return {
    reserveSlicesMissingCoinId: baselineCount("reserveSlicesMissingCoinId"),
    unresolvedMaterialReserveSlices: baselineCount("unresolvedMaterialReserveSlices"),
    manualDependencyReviewGaps: baselineCount("manualDependencyReviewGaps"),
    staleReserveDispositions: baselineCount("staleReserveDispositions"),
    unavailableTargetDispositionGaps: baselineCount("unavailableTargetDispositionGaps"),
    targetDispositionValidationIssues: baselineCount("targetDispositionValidationIssues"),
    adapterMappingReviewGaps: baselineCount("adapterMappingReviewGaps"),
  };
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apiBase: null,
    prod: false,
    inputDir: null,
    reportCardsPath: null,
    stablecoinsPath: null,
    format: "markdown",
    reportPath: null,
    check: false,
    baselinePath: DEFAULT_BASELINE_PATH,
    generatedAt: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prod") {
      options.prod = true;
      continue;
    }
    if (arg === "--api-base") {
      const value = argv[i + 1];
      if (!value) throw new Error("--api-base requires a URL");
      options.apiBase = value;
      i += 1;
      continue;
    }
    if (arg === "--input") {
      const value = argv[i + 1];
      if (!value) throw new Error("--input requires a directory path");
      options.inputDir = value;
      i += 1;
      continue;
    }
    if (arg === "--report-cards") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report-cards requires a file path");
      options.reportCardsPath = value;
      i += 1;
      continue;
    }
    if (arg === "--stablecoins") {
      const value = argv[i + 1];
      if (!value) throw new Error("--stablecoins requires a file path");
      options.stablecoinsPath = value;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--markdown") {
      options.format = "markdown";
      continue;
    }
    if (arg === "--report") {
      const value = argv[i + 1];
      if (!value) throw new Error("--report requires a path");
      options.reportPath = value;
      i += 1;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--baseline") {
      const value = argv[i + 1];
      if (!value) throw new Error("--baseline requires a file path");
      options.baselinePath = value;
      i += 1;
      continue;
    }
    if (arg === "--generated-at") {
      const value = argv[i + 1];
      if (!value) throw new Error("--generated-at requires an ISO timestamp or 'now'");
      options.generatedAt = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.prod && options.apiBase) {
    throw new Error("Choose only one of --prod or --api-base.");
  }

  return options;
}

async function loadOptionalInputs(
  options: CliOptions,
  cwd: string,
  fetchImpl: typeof fetch,
): Promise<Pick<DependencyCoverageAuditInput, "reportCards" | "stablecoins" | "mode">> {
  const fetchedInputs = await loadCoverageAuditSiteDataInputs(
    { prod: options.prod, apiBase: options.apiBase, apiKeyEnv: "DEPENDENCY_COVERAGE_API_KEY" },
    fetchImpl,
  );
  if (fetchedInputs) return fetchedInputs;

  const inputDir = options.inputDir ? resolve(cwd, options.inputDir) : null;
  if (inputDir && !existsSync(inputDir)) {
    throw new Error(`--input directory not found: ${inputDir}`);
  }
  const reportCardsPath = options.reportCardsPath
    ? resolve(cwd, options.reportCardsPath)
    : inputDir
      ? resolve(inputDir, "report-cards.json")
      : null;
  const stablecoinsPath = options.stablecoinsPath
    ? resolve(cwd, options.stablecoinsPath)
    : inputDir
      ? resolve(inputDir, "stablecoins.json")
      : null;
  const reportCards = options.reportCardsPath
    ? readRequiredJsonFile(reportCardsPath!, "--report-cards")
    : reportCardsPath && existsSync(reportCardsPath)
      ? readJsonFile(reportCardsPath)
      : undefined;
  const stablecoins = options.stablecoinsPath
    ? readRequiredJsonFile(stablecoinsPath!, "--stablecoins")
    : stablecoinsPath && existsSync(stablecoinsPath)
      ? readJsonFile(stablecoinsPath)
      : undefined;

  if (inputDir && reportCards === undefined && stablecoins === undefined) {
    throw new Error(`--input directory contains neither report-cards.json nor stablecoins.json: ${inputDir}`);
  }

  return {
    reportCards,
    stablecoins,
    mode: reportCards !== undefined || stablecoins !== undefined ? "input" : "static",
  };
}

function writeOutput(path: string, output: string, cwd: string): void {
  const target = writeOutputFile(path, output, cwd);
  process.stdout.write(`Wrote dependency coverage audit to ${target}\n`);
}

function readBaseline(path: string, cwd: string): DependencyCoverageBaseline {
  const target = resolve(cwd, path);
  if (!existsSync(target)) throw new Error(`Dependency coverage baseline file not found: ${target}`);
  return parseBaseline(readJsonFile(target));
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const options = parseArgs(argv);
  const baseline = options.check ? readBaseline(options.baselinePath, cwd) : null;
  const loaded = await loadOptionalInputs(options, cwd, fetchImpl);
  const audit = buildDependencyCoverageAudit({
    ...loaded,
    generatedAt: resolveGeneratedAt(options),
  });
  const output = options.format === "json"
    ? `${JSON.stringify(audit, null, 2)}\n`
    : renderDependencyCoverageAuditMarkdown(audit);

  if (options.reportPath) {
    writeOutput(options.reportPath, output, cwd);
  } else {
    process.stdout.write(output);
  }

  if (!options.check) return 0;

  const failures = evaluateDependencyCoverageBaseline(audit, baseline!);
  if (failures.length === 0) {
    process.stdout.write("Dependency coverage check: OK\n");
    return 0;
  }

  process.stderr.write(`Dependency coverage check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  return 1;
}

runAsMain(import.meta.url, runCli);
