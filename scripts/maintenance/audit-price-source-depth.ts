#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { StablecoinMeta } from "@shared/types";
import { toErrorMessage } from "@shared/lib/error-utils";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  circulatingForStablecoinRow,
  extractStablecoinRows,
  fetchJson,
  formatNumber,
  formatUsd,
  isRecord,
  markdownValue,
  numberValue,
  PROD_ORIGIN,
  PROD_STABLECOINS_URL,
  parseReportCliArgs,
  readJsonFile,
  runReportCli,
  stringValue,
  type UnknownRecord,
} from "../lib/report-cli";

const PROD_PEG_SUMMARY_URL = `${PROD_ORIGIN}/_site-data/peg-summary`;
const PROD_REFERER = `${PROD_ORIGIN}/coverage/`;

export const DEPTH_BUCKETS = ["0", "1", "2", "3", "4", "5+"] as const;
export type DepthBucket = (typeof DEPTH_BUCKETS)[number];
export type DepthDistribution = Record<DepthBucket, number>;

export const SOURCE_FAMILIES = [
  "oracle",
  "market",
  "dex",
  "protocol",
  "protocol-override",
  "list-aggregator",
  "aggregator",
  "fallback-search",
  "cached",
  "unknown",
] as const;
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export type PipelineLane = "primary" | "fallback" | "dex-discovery" | "history" | "metadata-only";
export type ExpectedMetricImpact = "moves-to-3" | "no-count-impact" | "needs-runtime-provider-change";
export type ExpectedTrustImpact =
  | "candidate-count-only"
  | "agreeing-source-lift"
  | "primaryTrust-lift"
  | "fallback-only"
  | "unknown";

export type AuditStablecoinMeta = Pick<
  StablecoinMeta,
  | "id"
  | "name"
  | "symbol"
  | "status"
  | "geckoId"
  | "llamaId"
  | "cmcSlug"
  | "contracts"
  | "tradedContracts"
  | "links"
>;

export interface PriceSourceMetadataSnapshot {
  geckoId: boolean;
  llamaId: boolean;
  cmcSlug: boolean;
  contracts: number;
  tradedContracts: number;
}

export interface CandidateTriage {
  currentSources: string[];
  missingFields: string[];
  fieldAlreadyPresent: string[];
  potentialNewSource: string | null;
  pipelineLane: PipelineLane;
  expectedMetricImpact: ExpectedMetricImpact;
  expectedTrustImpact: ExpectedTrustImpact;
  verificationSourceUrl: string;
  blocker: string;
}

export interface SourceClassification {
  source: string;
  family: SourceFamily;
  depegSourceFamily: string | null;
  trustTier: string | null;
  isListAggregator: boolean;
  isSearchDerived: boolean;
  freshnessKind: string | null;
  requiresObservedAt: boolean;
  supportsUpstreamObservedAt: boolean;
  maxTrustedAgeSec: number | null;
  isReplaySafe: boolean;
  canBeDepegAuthoritative: boolean;
  canSingleSourceDepegAuthoritative: boolean;
  isSoftSource: boolean;
  isProtocolOverride: boolean;
  isRetired: boolean;
  circuit: string;
  circuitEnforced: boolean;
  confirmationFamily: string;
}

export interface PriceSourceDepthRow {
  coinId: string;
  symbol: string;
  name: string;
  status: "active";
  marketCapUsd: number;
  price: number | null;
  priceSource: string;
  priceConfidence: string | null;
  primaryTrust: string | null;
  pegSummaryPresent: boolean;
  stablecoinPresent: boolean;
  consensusSources: string[];
  agreeSources: string[];
  authoritativeAgreeSources: string[];
  candidateSourceCount: number;
  agreeSourceCount: number;
  authoritativeAgreeSourceCount: number;
  sourceClassifications: SourceClassification[];
  metadata: PriceSourceMetadataSnapshot;
  candidateTriage: CandidateTriage;
  fallbackOnlyFill: boolean;
  missingOrUnusablePrice: boolean;
}

export interface SourceFrequencyRow extends SourceClassification {
  count: number;
}

export interface PriceSourceDepthAudit {
  generatedAt: string;
  mode: "prod" | "input";
  activeCount: number;
  pegSummaryRows: number;
  stablecoinRows: number;
  sourceDepthDistribution: DepthDistribution;
  agreeDepthDistribution: DepthDistribution;
  authoritativeAgreeDepthDistribution: DepthDistribution;
  mcapWeightedReach: {
    totalMarketCapUsd: number;
    sourceAtLeast3MarketCapUsd: number;
    sourceAtLeast3Pct: number;
    agreeAtLeast3MarketCapUsd: number;
    agreeAtLeast3Pct: number;
    authoritativeAgreeAtLeast3MarketCapUsd: number;
    authoritativeAgreeAtLeast3Pct: number;
  };
  sourceFrequency: {
    bySource: SourceFrequencyRow[];
    byFamily: Record<SourceFamily, number>;
    unknownSources: string[];
  };
  cohorts: {
    exact2: PriceSourceDepthRow[];
    exact1: PriceSourceDepthRow[];
    zeroOrMissing: PriceSourceDepthRow[];
    claimableMovesTo3: PriceSourceDepthRow[];
    providerPresentButNull: PriceSourceDepthRow[];
    dexEnabler: PriceSourceDepthRow[];
    fallbackOnly: PriceSourceDepthRow[];
  };
  rows: PriceSourceDepthRow[];
  warnings: string[];
}

export interface AuditInput {
  pegSummary: unknown;
  stablecoins: unknown;
  activeStablecoins?: AuditStablecoinMeta[];
  generatedAt?: string;
  mode?: "prod" | "input";
}

interface LoadedInputs extends AuditInput {
  mode: "prod" | "input";
}

interface CliOptions {
  source: "prod" | "input" | null;
  inputDir: string | null;
  pegSummaryPath: string | null;
  stablecoinsPath: string | null;
  activeStablecoinsPath: string | null;
  format: "markdown" | "json";
  reportPath: string | null;
  writeAgentsBaseline: boolean;
  generatedAt: string | null;
}

function createDepthDistribution(): DepthDistribution {
  return { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5+": 0 };
}

function createFamilyCounts(): Record<SourceFamily, number> {
  return Object.fromEntries(SOURCE_FAMILIES.map((family) => [family, 0])) as Record<SourceFamily, number>;
}

export function bucketSourceDepth(count: number): DepthBucket {
  if (count >= 5) return "5+";
  if (count <= 0) return "0";
  return String(count) as DepthBucket;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function expandCompositeSources(sources: string[]): string[] {
  return uniqueStrings(sources.flatMap((source) => splitCompositePriceSource(source)));
}

function findCompositeSources(sources: string[]): string[] {
  return sources.filter((source) => splitCompositePriceSource(source).length > 1);
}

function extractPegRows(payload: unknown): UnknownRecord[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.coins) ? payload.coins : [];
  return rows.filter(isRecord);
}

function normalizeActiveStablecoins(payload: unknown): AuditStablecoinMeta[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.coins) ? payload.coins : [];

  return rows.filter(isRecord).flatMap((row) => {
    const id = stringValue(row.id);
    if (!id) return [];

    return [{
      id,
      name: stringValue(row.name) ?? id,
      symbol: stringValue(row.symbol) ?? id.toUpperCase(),
      status: "active",
      geckoId: stringValue(row.geckoId) ?? undefined,
      llamaId: stringValue(row.llamaId) ?? undefined,
      cmcSlug: stringValue(row.cmcSlug) ?? undefined,
      contracts: Array.isArray(row.contracts) ? row.contracts as AuditStablecoinMeta["contracts"] : undefined,
      tradedContracts: Array.isArray(row.tradedContracts)
        ? row.tradedContracts as AuditStablecoinMeta["tradedContracts"]
        : undefined,
      links: Array.isArray(row.links) ? row.links as AuditStablecoinMeta["links"] : undefined,
    }];
  });
}

function mapRowsById(rows: UnknownRecord[]): Map<string, UnknownRecord> {
  const map = new Map<string, UnknownRecord>();
  for (const row of rows) {
    const id = stringValue(row.id);
    if (id) map.set(id, row);
  }
  return map;
}

function metadataSnapshot(meta: AuditStablecoinMeta): PriceSourceMetadataSnapshot {
  return {
    geckoId: Boolean(meta.geckoId),
    llamaId: Boolean(meta.llamaId),
    cmcSlug: Boolean(meta.cmcSlug),
    contracts: meta.contracts?.length ?? 0,
    tradedContracts: meta.tradedContracts?.length ?? 0,
  };
}

function firstVerificationUrl(meta: AuditStablecoinMeta): string {
  return meta.links?.find((link) => typeof link.url === "string" && link.url.length > 0)?.url ?? "";
}

export function classifySourceFamily(source: string): SourceFamily {
  const entry = getPricingSourceRegistryEntry(source);
  if (!entry) return "unknown";
  if (entry.isProtocolOverride) return "protocol-override";
  if (entry.trustTier === "fallback_search") return "fallback-search";
  if (entry.trustTier === "cached_replay") return "cached";
  if (entry.isListAggregator) return "list-aggregator";
  if (entry.trustTier === "hard_oracle") return "oracle";
  if (entry.trustTier === "hard_market") return "market";
  if (entry.trustTier === "hard_protocol") return "protocol";
  if (entry.trustTier === "soft_dex") return "dex";
  if (entry.trustTier === "soft_aggregator") return "aggregator";
  return "unknown";
}

function confirmationFamilyForSource(source: string, family: SourceFamily): string {
  if (source === "pyth") return "pyth";
  if (source === "redstone") return "redstone";
  if (source === "coingecko" || source.startsWith("coingecko-") || source === "cg-ticker") return "coingecko";
  if (source.startsWith("defillama")) return "defillama";
  if (family === "dex" || source.endsWith("-dex") || source === "pool-tvl-weighted") return "dex";
  if (family === "market") return "cex";
  if (family === "protocol" || family === "protocol-override") return "protocol";
  if (family === "fallback-search") return "fallback-search";
  return family;
}

function circuitForSource(source: string, family: SourceFamily): string {
  if (getPricingSourceRegistryEntry(source)?.isRetired) return "retired";
  if (source === "redstone") return "redstone-prices";
  if (family === "dex") return "dex-discovery";
  if (family === "fallback-search") return "fallback-search";
  if (family === "protocol" || family === "protocol-override") return "protocol";
  if (family === "market" || family === "list-aggregator" || family === "aggregator") return "primary-provider";
  if (family === "cached") return "cache-replay";
  return "unknown";
}

export function classifySource(source: string): SourceClassification {
  const entry = getPricingSourceRegistryEntry(source);
  const family = classifySourceFamily(source);

  return {
    source,
    family,
    depegSourceFamily: entry?.depegSourceFamily ?? null,
    trustTier: entry?.trustTier ?? null,
    isListAggregator: entry?.isListAggregator ?? false,
    isSearchDerived: entry?.isSearchDerived ?? false,
    freshnessKind: entry?.freshnessKind ?? null,
    requiresObservedAt: entry?.requiresObservedAt ?? false,
    supportsUpstreamObservedAt: entry?.supportsUpstreamObservedAt ?? false,
    maxTrustedAgeSec: entry?.maxTrustedAgeSec ?? null,
    isReplaySafe: entry?.isReplaySafe ?? false,
    canBeDepegAuthoritative: entry?.canBeDepegAuthoritative ?? false,
    canSingleSourceDepegAuthoritative: entry?.canSingleSourceDepegAuthoritative ?? false,
    isSoftSource: entry?.isSoftSource ?? false,
    isProtocolOverride: entry?.isProtocolOverride ?? false,
    isRetired: entry?.isRetired ?? false,
    circuit: circuitForSource(source, family),
    circuitEnforced: entry != null && !entry.isRetired && family !== "fallback-search" && family !== "cached",
    confirmationFamily: confirmationFamilyForSource(source, family),
  };
}

function authoritativeAgreeSources(rawAgreeSources: string[]): string[] {
  return expandCompositeSources(rawAgreeSources).filter(
    (source) => getPricingSourceRegistryEntry(source)?.canBeDepegAuthoritative === true,
  );
}

function isFallbackOnlyFill(priceConfidence: string | null, consensusSources: string[], priceSource: string): boolean {
  if (priceConfidence === "fallback") return true;
  const sources = consensusSources.length > 0 ? consensusSources : splitCompositePriceSource(priceSource);
  if (sources.length === 0) return false;
  return sources.every((source) => {
    const family = classifySourceFamily(source);
    return family === "fallback-search" || family === "cached";
  });
}

function fieldLists(snapshot: PriceSourceMetadataSnapshot): {
  missingFields: string[];
  fieldAlreadyPresent: string[];
} {
  const missingFields: string[] = [];
  const fieldAlreadyPresent: string[] = [];

  const checks = [
    ["geckoId", snapshot.geckoId],
    ["llamaId", snapshot.llamaId],
    ["cmcSlug", snapshot.cmcSlug],
    ["contracts", snapshot.contracts > 0],
    ["tradedContracts", snapshot.tradedContracts > 0],
  ] as const;

  for (const [field, present] of checks) {
    if (present) fieldAlreadyPresent.push(field);
    else missingFields.push(field);
  }

  return { missingFields, fieldAlreadyPresent };
}

function impactForPotentialSource(
  source: string | null,
  lane: PipelineLane,
  snapshot: PriceSourceMetadataSnapshot,
  candidateSourceCount: number,
  missingOrUnusablePrice: boolean,
): ExpectedMetricImpact {
  if (!source) return "no-count-impact";
  if (candidateSourceCount >= 3) return "no-count-impact";
  if (candidateSourceCount !== 2) return "needs-runtime-provider-change";
  if (missingOrUnusablePrice || lane !== "primary") return "needs-runtime-provider-change";
  if (source === "coingecko") return snapshot.geckoId ? "moves-to-3" : "needs-runtime-provider-change";
  if (source === "defillama-list") return snapshot.llamaId ? "moves-to-3" : "needs-runtime-provider-change";
  return "needs-runtime-provider-change";
}

function trustImpactForSource(source: string | null): ExpectedTrustImpact {
  if (!source) return "unknown";
  const entry = getPricingSourceRegistryEntry(source);
  if (!entry) return "unknown";
  if (entry.canBeDepegAuthoritative) return "primaryTrust-lift";
  if (entry.trustTier === "soft_dex") return "agreeing-source-lift";
  if (entry.trustTier === "fallback_search" || entry.trustTier === "cached_replay") return "fallback-only";
  return "candidate-count-only";
}

function buildCandidateTriage(
  meta: AuditStablecoinMeta,
  snapshot: PriceSourceMetadataSnapshot,
  consensusSources: string[],
  candidateSourceCount: number,
  missingOrUnusablePrice: boolean,
): CandidateTriage {
  const { missingFields, fieldAlreadyPresent } = fieldLists(snapshot);
  const sourceSet = new Set(consensusSources);
  const verificationSourceUrl = firstVerificationUrl(meta);

  let potentialNewSource: string | null = null;
  let pipelineLane: PipelineLane = "metadata-only";
  let blocker = candidateSourceCount >= 3
    ? "Already has at least three candidate price sources."
    : "Needs source-level research before claiming metric lift.";

  if (candidateSourceCount < 3) {
    if (missingOrUnusablePrice) {
      potentialNewSource = "coingecko";
      pipelineLane = "fallback";
      blocker = "Price is missing or unusable; first restore a current non-fallback price lane.";
    } else if (!sourceSet.has("coingecko") && snapshot.geckoId) {
      potentialNewSource = "coingecko";
      pipelineLane = "primary";
      blocker = "CoinGecko metadata exists but the current runtime payload does not emit it as a candidate source.";
    } else if (!sourceSet.has("defillama-list") && snapshot.llamaId) {
      potentialNewSource = "defillama-list";
      pipelineLane = "primary";
      blocker = "DefiLlama metadata exists but the current runtime payload does not emit it as a candidate source.";
    } else if (snapshot.contracts > 0 || snapshot.tradedContracts > 0) {
      potentialNewSource = "dex-promoted";
      pipelineLane = "dex-discovery";
      blocker = "On-chain contracts are present; DEX candidate lift still requires runtime pool discovery, freshness, TVL, and corroboration.";
    } else if (!snapshot.geckoId) {
      potentialNewSource = "coingecko";
      pipelineLane = "primary";
      blocker = "Requires verified CoinGecko ID metadata before claiming provider coverage lift.";
    } else if (!snapshot.llamaId) {
      potentialNewSource = "defillama-list";
      pipelineLane = "primary";
      blocker = "Requires verified DefiLlama ID metadata before claiming provider coverage lift.";
    }
  }

  return {
    currentSources: consensusSources,
    missingFields,
    fieldAlreadyPresent,
    potentialNewSource,
    pipelineLane,
    expectedMetricImpact: impactForPotentialSource(
      potentialNewSource,
      pipelineLane,
      snapshot,
      candidateSourceCount,
      missingOrUnusablePrice,
    ),
    expectedTrustImpact: trustImpactForSource(potentialNewSource),
    verificationSourceUrl,
    blocker,
  };
}

function buildAuditRow(
  meta: AuditStablecoinMeta,
  pegRow: UnknownRecord | undefined,
  stablecoinRow: UnknownRecord | undefined,
): PriceSourceDepthRow {
  const consensusSources = normalizeStringArray(pegRow?.consensusSources ?? stablecoinRow?.consensusSources);
  const agreeSources = normalizeStringArray(pegRow?.agreeSources ?? stablecoinRow?.agreeSources);
  const priceSource = stringValue(pegRow?.priceSource ?? stablecoinRow?.priceSource) ?? "missing";
  const priceConfidence = stringValue(pegRow?.priceConfidence ?? stablecoinRow?.priceConfidence);
  const primaryTrust = stringValue(pegRow?.primaryTrust);
  const price = numberValue(stablecoinRow?.price);
  const authoritativeSources = authoritativeAgreeSources(agreeSources);
  const sourceKeys = expandCompositeSources([
    ...consensusSources,
    ...agreeSources,
    priceSource,
  ]);
  const sourceClassifications = sourceKeys.map(classifySource);
  const snapshot = metadataSnapshot(meta);
  const missingOrUnusablePrice = !pegRow || !stablecoinRow || price == null || priceSource === "missing";
  const candidateTriage = buildCandidateTriage(
    meta,
    snapshot,
    consensusSources,
    consensusSources.length,
    missingOrUnusablePrice,
  );

  return {
    coinId: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    status: "active",
    marketCapUsd: circulatingForStablecoinRow(stablecoinRow),
    price,
    priceSource,
    priceConfidence,
    primaryTrust,
    pegSummaryPresent: Boolean(pegRow),
    stablecoinPresent: Boolean(stablecoinRow),
    consensusSources,
    agreeSources,
    authoritativeAgreeSources: authoritativeSources,
    candidateSourceCount: consensusSources.length,
    agreeSourceCount: agreeSources.length,
    authoritativeAgreeSourceCount: authoritativeSources.length,
    sourceClassifications,
    metadata: snapshot,
    candidateTriage,
    fallbackOnlyFill: isFallbackOnlyFill(priceConfidence, consensusSources, priceSource),
    missingOrUnusablePrice,
  };
}

function countDistribution(rows: PriceSourceDepthRow[], pickCount: (row: PriceSourceDepthRow) => number): DepthDistribution {
  const distribution = createDepthDistribution();
  for (const row of rows) {
    distribution[bucketSourceDepth(pickCount(row))] += 1;
  }
  return distribution;
}

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function buildSourceFrequency(rows: PriceSourceDepthRow[]): PriceSourceDepthAudit["sourceFrequency"] {
  const counts = new Map<string, number>();
  const byFamily = createFamilyCounts();

  for (const row of rows) {
    for (const source of expandCompositeSources(row.consensusSources)) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
      byFamily[classifySourceFamily(source)] += 1;
    }
  }

  const bySource = [...counts.entries()]
    .map(([source, count]) => ({ ...classifySource(source), count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const unknownSources = bySource
    .filter((row) => row.family === "unknown")
    .map((row) => row.source);

  return { bySource, byFamily, unknownSources };
}

function sortByMarketCap(rows: PriceSourceDepthRow[]): PriceSourceDepthRow[] {
  return [...rows].sort((a, b) => b.marketCapUsd - a.marketCapUsd || a.symbol.localeCompare(b.symbol));
}

export function buildPriceSourceDepthAudit(input: AuditInput): PriceSourceDepthAudit {
  const activeStablecoins = input.activeStablecoins ?? ACTIVE_STABLECOINS;
  const pegRows = extractPegRows(input.pegSummary);
  const stablecoinRows = extractStablecoinRows(input.stablecoins, { unwrapPayload: false });
  const pegById = mapRowsById(pegRows);
  const stablecoinById = mapRowsById(stablecoinRows);

  const rows = activeStablecoins.map((meta) => buildAuditRow(
    meta,
    pegById.get(meta.id),
    stablecoinById.get(meta.id),
  ));
  const totalMarketCapUsd = rows.reduce((sum, row) => sum + row.marketCapUsd, 0);
  const sourceAtLeast3MarketCapUsd = rows
    .filter((row) => row.candidateSourceCount >= 3)
    .reduce((sum, row) => sum + row.marketCapUsd, 0);
  const agreeAtLeast3MarketCapUsd = rows
    .filter((row) => row.agreeSourceCount >= 3)
    .reduce((sum, row) => sum + row.marketCapUsd, 0);
  const authoritativeAgreeAtLeast3MarketCapUsd = rows
    .filter((row) => row.authoritativeAgreeSourceCount >= 3)
    .reduce((sum, row) => sum + row.marketCapUsd, 0);

  const exact2 = sortByMarketCap(rows.filter((row) => row.candidateSourceCount === 2));
  const exact1 = sortByMarketCap(rows.filter((row) => row.candidateSourceCount === 1));
  const zeroOrMissing = sortByMarketCap(rows.filter((row) => row.candidateSourceCount === 0 || row.missingOrUnusablePrice));
  const claimableMovesTo3 = sortByMarketCap(rows.filter((row) => (
    row.candidateTriage.expectedMetricImpact === "moves-to-3" &&
    row.candidateTriage.pipelineLane === "primary"
  )));
  const providerPresentButNull = sortByMarketCap(rows.filter((row) => {
    const sourceSet = new Set(row.consensusSources);
    return row.candidateSourceCount === 2 && (
      (row.metadata.geckoId && !sourceSet.has("coingecko") && !sourceSet.has("coingecko-low-volume")) ||
      (row.metadata.llamaId && !sourceSet.has("defillama-list") && !sourceSet.has("defillama"))
    );
  }));
  const dexEnabler = sortByMarketCap(rows.filter((row) => (
    row.candidateSourceCount === 2 &&
    (row.metadata.contracts > 0 || row.metadata.tradedContracts > 0) &&
    row.consensusSources.every((source) => classifySourceFamily(source) !== "dex")
  )));
  const fallbackOnly = sortByMarketCap(rows.filter((row) => row.fallbackOnlyFill));

  const sourceFrequency = buildSourceFrequency(rows);
  const warnings = sourceFrequency.unknownSources.map((source) => (
    `Unknown source key '${source}' counted as non-authoritative.`
  ));
  for (const row of rows) {
    for (const source of findCompositeSources(row.consensusSources)) {
      warnings.push(
        `Composite consensus source key '${source}' on ${row.coinId} expanded for source-frequency classification but counted as one candidate source.`,
      );
    }
  }
  if (pegRows.length === 0) warnings.push("Peg summary payload did not contain any rows.");
  if (stablecoinRows.length === 0) warnings.push("Stablecoin payload did not contain any pegged asset rows.");

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode ?? "input",
    activeCount: activeStablecoins.length,
    pegSummaryRows: pegRows.length,
    stablecoinRows: stablecoinRows.length,
    sourceDepthDistribution: countDistribution(rows, (row) => row.candidateSourceCount),
    agreeDepthDistribution: countDistribution(rows, (row) => row.agreeSourceCount),
    authoritativeAgreeDepthDistribution: countDistribution(rows, (row) => row.authoritativeAgreeSourceCount),
    mcapWeightedReach: {
      totalMarketCapUsd,
      sourceAtLeast3MarketCapUsd,
      sourceAtLeast3Pct: pct(sourceAtLeast3MarketCapUsd, totalMarketCapUsd),
      agreeAtLeast3MarketCapUsd,
      agreeAtLeast3Pct: pct(agreeAtLeast3MarketCapUsd, totalMarketCapUsd),
      authoritativeAgreeAtLeast3MarketCapUsd,
      authoritativeAgreeAtLeast3Pct: pct(authoritativeAgreeAtLeast3MarketCapUsd, totalMarketCapUsd),
    },
    sourceFrequency,
    cohorts: {
      exact2,
      exact1,
      zeroOrMissing,
      claimableMovesTo3,
      providerPresentButNull,
      dexEnabler,
      fallbackOnly,
    },
    rows: sortByMarketCap(rows),
    warnings,
  };
}

function formatPercent(value: number): string {
  return `${formatNumber(value)}%`;
}

function renderDistribution(distribution: DepthDistribution): string {
  return DEPTH_BUCKETS.map((bucket) => `${bucket}: ${distribution[bucket]}`).join(", ");
}

function renderRows(rows: PriceSourceDepthRow[], limit: number): string[] {
  const clipped = rows.slice(0, limit);
  if (clipped.length === 0) return ["_None._"];

  return [
    "coin | mcap | sources | price source | potential | lane | blocker",
    "--- | ---: | --- | --- | --- | --- | ---",
    ...clipped.map((row) => [
      `${row.symbol} (${row.coinId})`,
      formatUsd(row.marketCapUsd),
      row.consensusSources.join(", "),
      row.priceSource,
      row.candidateTriage.potentialNewSource ?? "",
      row.candidateTriage.pipelineLane,
      row.candidateTriage.blocker,
    ].map(markdownValue).join(" | ")),
    ...(rows.length > limit ? [`_Plus ${rows.length - limit} more rows._`] : []),
  ];
}

export function renderPriceSourceDepthAuditMarkdown(audit: PriceSourceDepthAudit): string {
  const lines = [
    "# Price Source Depth Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Mode: ${audit.mode}`,
    `Active rows: ${audit.activeCount}`,
    `Peg summary rows: ${audit.pegSummaryRows}`,
    `Stablecoin rows: ${audit.stablecoinRows}`,
    "",
    "## Distributions",
    "",
    `Candidate source depth: ${renderDistribution(audit.sourceDepthDistribution)}`,
    `Agreeing source depth: ${renderDistribution(audit.agreeDepthDistribution)}`,
    `Authoritative agreeing source depth: ${renderDistribution(audit.authoritativeAgreeDepthDistribution)}`,
    "",
    "## Market-Cap Weighted Reach",
    "",
    `Total active mcap: ${formatUsd(audit.mcapWeightedReach.totalMarketCapUsd)}`,
    `Candidate >=3: ${formatUsd(audit.mcapWeightedReach.sourceAtLeast3MarketCapUsd)} (${formatPercent(audit.mcapWeightedReach.sourceAtLeast3Pct)})`,
    `Agreeing >=3: ${formatUsd(audit.mcapWeightedReach.agreeAtLeast3MarketCapUsd)} (${formatPercent(audit.mcapWeightedReach.agreeAtLeast3Pct)})`,
    `Authoritative agreeing >=3: ${formatUsd(audit.mcapWeightedReach.authoritativeAgreeAtLeast3MarketCapUsd)} (${formatPercent(audit.mcapWeightedReach.authoritativeAgreeAtLeast3Pct)})`,
    "",
    "## Cohorts",
    "",
    `Exact 2 candidate sources: ${audit.cohorts.exact2.length}`,
    `Exact 1 candidate source: ${audit.cohorts.exact1.length}`,
    `Zero/missing/unusable: ${audit.cohorts.zeroOrMissing.length}`,
    `Claimable primary moves to 3: ${audit.cohorts.claimableMovesTo3.length}`,
    `Provider metadata present but not emitted: ${audit.cohorts.providerPresentButNull.length}`,
    `DEX enabler candidates: ${audit.cohorts.dexEnabler.length}`,
    `Fallback-only fills: ${audit.cohorts.fallbackOnly.length}`,
    "",
    "## Top Exact-2 Rows",
    "",
    ...renderRows(audit.cohorts.exact2, 30),
    "",
    "## Top Exact-1 Rows",
    "",
    ...renderRows(audit.cohorts.exact1, 30),
    "",
    "## Source Frequency",
    "",
    "source | count | family | trust tier | authoritative",
    "--- | ---: | --- | --- | ---",
    ...audit.sourceFrequency.bySource.slice(0, 60).map((row) => [
      row.source,
      row.count,
      row.family,
      row.trustTier,
      row.canBeDepegAuthoritative,
    ].map(markdownValue).join(" | ")),
    "",
    "## Warnings",
    "",
    ...(audit.warnings.length > 0 ? audit.warnings.map((warning) => `- ${warning}`) : ["_None._"]),
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseArgs(argv: string[]): CliOptions {
  return parseReportCliArgs(argv, {
    createOptions: (): CliOptions => ({
      source: null,
      inputDir: null,
      pegSummaryPath: null,
      stablecoinsPath: null,
      activeStablecoinsPath: null,
      format: "markdown",
      reportPath: null,
      writeAgentsBaseline: false,
      generatedAt: null,
    }),
    includeGeneratedAt: true,
    generatedAtMissingMessage: "--generated-at requires an ISO timestamp or 'now'",
    options: [
      { flag: "--prod", kind: "boolean", apply: (options) => { options.source = "prod"; } },
      { flag: "--input", kind: "value", missingMessage: "--input requires a directory path", apply: (options, value) => { options.source = "input"; options.inputDir = value!; } },
      { flag: "--peg-summary", kind: "value", missingMessage: "--peg-summary requires a file path", apply: (options, value) => { options.source = "input"; options.pegSummaryPath = value!; } },
      { flag: "--stablecoins", kind: "value", missingMessage: "--stablecoins requires a file path", apply: (options, value) => { options.source = "input"; options.stablecoinsPath = value!; } },
      { flag: "--active-stablecoins", kind: "value", missingMessage: "--active-stablecoins requires a file path", apply: (options, value) => { options.activeStablecoinsPath = value!; } },
      { flag: "--write-agents-baseline", kind: "boolean", apply: (options) => { options.writeAgentsBaseline = true; options.format = "json"; } },
    ],
    validate: (options) => {
      if (!options.source) {
        throw new Error("Choose --prod or --input <dir> / --peg-summary <file> --stablecoins <file>.");
      }
      if (options.source === "input" && !options.inputDir && (!options.pegSummaryPath || !options.stablecoinsPath)) {
        throw new Error("Input mode requires --input <dir> or both --peg-summary and --stablecoins.");
      }
    },
  });
}

function generatedAtFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = stringValue(payload.generatedAt ?? payload.fetchedAt ?? payload.updatedAt);
  if (direct) return direct;
  if (isRecord(payload.methodology)) {
    return stringValue(payload.methodology.generatedAt ?? payload.methodology.updatedAt);
  }
  return null;
}

function resolveGeneratedAt(options: CliOptions, loaded: LoadedInputs): string {
  if (options.generatedAt === "now") return new Date().toISOString();
  if (options.generatedAt) return options.generatedAt;
  return generatedAtFromPayload(loaded.pegSummary)
    ?? generatedAtFromPayload(loaded.stablecoins)
    ?? (loaded.mode === "input" ? "1970-01-01T00:00:00.000Z" : new Date().toISOString());
}

async function loadInputs(options: CliOptions, cwd: string, fetchImpl: typeof fetch): Promise<LoadedInputs> {
  if (options.source === "prod") {
    const [pegSummary, stablecoins] = await Promise.all([
      fetchJson(PROD_PEG_SUMMARY_URL, fetchImpl, undefined, { Referer: PROD_REFERER }),
      fetchJson(PROD_STABLECOINS_URL, fetchImpl, undefined, { Referer: PROD_REFERER }),
    ]);
    return { mode: "prod", pegSummary, stablecoins };
  }

  const inputDir = options.inputDir ? resolve(cwd, options.inputDir) : null;
  const pegSummaryPath = resolve(cwd, options.pegSummaryPath ?? `${inputDir}/peg-summary.json`);
  const stablecoinsPath = resolve(cwd, options.stablecoinsPath ?? `${inputDir}/stablecoins.json`);
  const inputActivePath = inputDir ? resolve(inputDir, "active-stablecoins.json") : null;
  const activeStablecoinsPath = options.activeStablecoinsPath
    ? resolve(cwd, options.activeStablecoinsPath)
    : inputActivePath && existsSync(inputActivePath)
      ? inputActivePath
      : null;

  return {
    mode: "input",
    pegSummary: readJsonFile(pegSummaryPath),
    stablecoins: readJsonFile(stablecoinsPath),
    activeStablecoins: activeStablecoinsPath ? normalizeActiveStablecoins(readJsonFile(activeStablecoinsPath)) : undefined,
  };
}

function defaultBaselinePath(cwd: string, generatedAt: string): string {
  return resolve(cwd, "agents", `source-depth-baseline-${generatedAt.slice(0, 10)}.json`);
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  return runReportCli(argv, {
    parse: parseArgs,
    cwd,
    build: async (options) => {
      const loaded = await loadInputs(options, cwd, fetchImpl);
      return buildPriceSourceDepthAudit({
        ...loaded,
        generatedAt: resolveGeneratedAt(options, loaded),
      });
    },
    renderMarkdown: renderPriceSourceDepthAuditMarkdown,
    resolveReportPath: (audit, options) => options.writeAgentsBaseline
      ? options.reportPath ?? defaultBaselinePath(cwd, audit.generatedAt)
      : options.reportPath,
    writeMessage: (target) => `Wrote price source depth audit to ${target}`,
  });
}

if (process.argv[1]?.endsWith("audit-price-source-depth.ts")) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(toErrorMessage(error));
      process.exitCode = 1;
    },
  );
}
