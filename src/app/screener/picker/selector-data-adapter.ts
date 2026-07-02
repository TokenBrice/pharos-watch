import { CLIENT_ACTIVE_META_BY_ID, CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  SELECTOR_VERSION,
  canonicalizeForDatasetHash,
  type MergedRow,
  type SelectorInput,
  type SelectorOutput,
} from "@shared/lib/selector";
import { sha256Hex } from "@shared/lib/sha256";
import { COLLATERAL_QUALITY_SCORE } from "@shared/lib/report-card-policy";
import type {
  AltYieldSource,
  BluechipRatingsMap,
  DexLiquidityMap,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCardsResponse,
  StablecoinListResponse,
  StressSignalsAllResponse,
  YieldDeploymentPlace,
  YieldRanking,
  YieldRankingsResponse,
  YieldSourceRisk,
  YieldType,
  YieldVenueRiskTier,
} from "@shared/types";

export interface BuildSelectorRowsArgs {
  stablecoinsData: StablecoinListResponse | null;
  pegCurrency?: SelectorInput["pegCurrency"] | null;
  pegData: PegSummaryResponse | null;
  reportData: ReportCardsResponse | null;
  stressData: StressSignalsAllResponse | null;
  dexData: DexLiquidityMap | null;
  yieldData: YieldRankingsResponse | null;
  bluechipData: BluechipRatingsMap | null;
  redemptionData?: RedemptionBackstopsResponse | null;
  /** `Date.now()`-style milliseconds or Unix seconds. */
  now: number;
}

export interface BuildSelectorRowsResult {
  rows: ReadonlyMap<string, MergedRow>;
  timestamp: number;
  datasetHash: string;
  methodologyVersions: SelectorOutput["methodologyVersions"];
}

export function buildSelectorRows(args: BuildSelectorRowsArgs): BuildSelectorRowsResult {
  const rows = new Map<string, MergedRow>();

  const pegById = new Map((args.pegData?.coins ?? []).map((coin) => [coin.id, coin] as const));
  const reportById = new Map((args.reportData?.cards ?? []).map((card) => [card.id, card] as const));
  const yieldById = new Map((args.yieldData?.rankings ?? []).map((ranking) => [ranking.id, ranking] as const));

  const supplyById = new Map<string, number>();
  for (const asset of args.stablecoinsData?.peggedAssets ?? []) {
    supplyById.set(asset.id, getCirculatingRaw(asset));
  }

  for (const meta of CLIENT_TRACKED_STABLECOINS) {
    const id = meta.id;
    const lifecycle = (meta.status ?? "active") as MergedRow["lifecycle"];
    if (lifecycle !== "active") continue;
    if (args.pegCurrency != null && meta.flags.pegCurrency !== args.pegCurrency) continue;

    const peg = pegById.get(id);
    const safety = reportById.get(id);
    const rawInputs = safety?.rawInputs;
    const stress = args.stressData?.signals?.[id];
    const dex = args.dexData?.[id];
    const yieldEntry = yieldById.get(id);
    const yieldRisk = yieldEntry?.sourceRisk ?? null;
    const rowSafetyScore =
      yieldEntry?.yieldType === "structured-tranche" && yieldEntry.safetyScore != null
        ? yieldEntry.safetyScore
        : safety?.overallScore ?? null;
    const rowSafetyGrade =
      yieldEntry?.yieldType === "structured-tranche" && yieldEntry.safetyGrade != null
        ? yieldEntry.safetyGrade
        : safety?.overallGrade ?? null;
    const redemption = args.redemptionData?.coins?.[id];
    const bluechip = args.bluechipData?.[id];
    const currentDeviationBps =
      peg?.currentDeviationBps
      ?? rawInputs?.activeDepegBps
      ?? dex?.dexDeviationBps
      ?? null;

    const row: MergedRow = {
      id,
      symbol: meta.symbol,
      name: meta.name,
      protocolSlug: meta.protocolSlug ?? null,
      variantOf: meta.variantOf ?? null,
      isYieldBearing: Boolean(meta.flags.yieldBearing),
      pegCurrency: meta.flags.pegCurrency,
      lifecycle,
      governance: meta.flags.governance,
      canBeBlacklisted: rawInputs?.canBeBlacklisted ?? meta.canBeBlacklisted ?? null,
      mechanismArchetype: resolveMechanismArchetype(meta, CLIENT_ACTIVE_META_BY_ID),

      supplyUsd: supplyById.get(id) ?? 0,

      pegScore: peg?.pegScore ?? rawInputs?.pegScore ?? null,
      pegStabilityScore: safety?.dimensions.pegStability.score ?? null,
      activeDepeg: peg?.activeDepeg ?? rawInputs?.activeDepeg ?? false,
      currentDeviationBps,
      depegEventCount: peg?.eventCount ?? rawInputs?.depegEventCount ?? 0,
      lastEventAt: peg?.lastEventAt ?? rawInputs?.lastEventAt ?? null,

      dewsScore: stress?.score ?? null,
      safetyGrade: rowSafetyGrade,
      safetyScore: rowSafetyScore,
      safetyResilienceScore: safety?.dimensions.resilience.score ?? null,
      safetyDependencyRiskScore: safety?.dimensions.dependencyRisk.score ?? null,
      safetyDecentralizationScore: safety?.dimensions.decentralization.score ?? null,
      safetyLiquidityScore: safety?.dimensions.liquidity.score ?? null,
      collateralQuality:
        rawInputs?.collateralQuality != null
          ? COLLATERAL_QUALITY_SCORE[rawInputs.collateralQuality]
          : null,
      custodyModel: rawInputs?.custodyModel ?? null,
      bluechipGrade: bluechip?.grade ?? rawInputs?.bluechipGrade ?? null,

      liquidityScore: dex?.liquidityScore ?? rawInputs?.liquidityScore ?? null,
      effectiveTvlUsd: dex?.effectiveTvlUsd ?? null,
      concentrationHhi: dex?.concentrationHhi ?? rawInputs?.concentrationHhi ?? null,
      chainTvl: dex?.chainTvl ?? {},
      effectiveExitScore:
        rawInputs?.effectiveExitScore
        ?? redemption?.effectiveExitScore
        ?? null,

      pharosYieldScore: yieldEntry?.pharosYieldScore ?? null,
      apy30d: yieldEntry?.apy30d ?? null,
      apyVariance30d: yieldEntry?.apyVariance30d ?? null,
      benchmarkRate:
        yieldEntry?.benchmarkRate
        ?? yieldEntry?.provenance?.benchmarkRate
        ?? args.yieldData?.provenance?.benchmark.rate
        ?? args.yieldData?.riskFreeRate
        ?? null,
      sourceRiskScore: yieldRisk?.sourceRiskScore ?? null,
      venueRiskTier: normalizeVenueRiskTier(yieldRisk?.venueRiskTier),
      warningSignals: yieldEntry?.warningSignals ?? [],
      deploymentPlace: normalizeDeploymentPlace(yieldRisk?.deploymentPlace),
      sourceSwitch:
        yieldEntry?.provenance?.sourceSwitch
        ?? yieldEntry?.decisionLedger?.sourceSwitch
        ?? ((yieldRisk?.sourceSwitchCount30d ?? 0) > 0),
      yieldProtocolSlug: yieldRisk?.venueProtocol ?? yieldEntry?.yieldSource ?? null,
      yieldVenueChain: yieldRisk?.venueChain ?? null,
      yieldHistoryDays: yieldRisk?.observationCount30d ?? 0,
      yieldFreshness: yieldFreshnessFrom(yieldEntry, args.now),
      yieldSources: buildYieldSourceCandidates(yieldEntry, args.now),

      trackingSpanDays: peg?.trackingSpanDays ?? 0,
      isRecentListing: (peg?.trackingSpanDays ?? 0) > 0 && (peg?.trackingSpanDays ?? 0) < 90,
      pegSummaryAgeSec: ageSecondsFromTimestamp(
        peg?.priceObservedAt ?? peg?.priceUpdatedAt ?? peg?.priceSyncedAt ?? null,
        args.now,
      ),
      dexTvlAgeSec: ageSecondsFromTimestamp(dex?.updatedAt ?? null, args.now),
      dewsAgeSec: ageSecondsFromTimestamp(stress?.computedAt ?? args.stressData?.updatedAt ?? null, args.now),
    };
    rows.set(id, row);
  }

  const methodologyVersions = {
    safetyScore: args.reportData?.methodology?.version ?? "unversioned",
    pegScoreAndDews: joinVersions(
      args.pegData?.methodology?.version,
      args.stressData?.methodology?.version,
    ),
    yieldIntelligence: args.yieldData?.methodology?.version ?? "unversioned",
    bluechipAlignment: "unversioned",
    exclusionFilters: SELECTOR_VERSION,
  };

  const datasetContent = {
    methodologyVersions,
    rows: Array.from(rows.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, row]) => ({
        id,
        symbol: row.symbol,
        name: row.name,
        pegCurrency: row.pegCurrency,
        safetyGrade: row.safetyGrade,
        overallScore: row.safetyScore,
        pegScore: row.pegScore,
        dewsScore: row.dewsScore,
        liquidityScore: row.liquidityScore,
        protocolSlug: row.protocolSlug,
        variantOf: row.variantOf,
        isYieldBearing: row.isYieldBearing,
        lifecycle: row.lifecycle,
        governance: row.governance,
        canBeBlacklisted: row.canBeBlacklisted,
        mechanismArchetype: row.mechanismArchetype,
        activeDepeg: row.activeDepeg,
        currentDeviationBps: row.currentDeviationBps,
        depegEventCount: row.depegEventCount,
        safetyPegStabilityScore: row.pegStabilityScore,
        safetyResilienceScore: row.safetyResilienceScore,
        safetyDependencyRiskScore: row.safetyDependencyRiskScore,
        safetyDecentralizationScore: row.safetyDecentralizationScore,
        safetyLiquidityScore: row.safetyLiquidityScore,
        collateralQuality: row.collateralQuality,
        custodyModel: row.custodyModel,
        pharosYieldScore: row.pharosYieldScore,
        apy30d: row.apy30d,
        apyVariance30d: row.apyVariance30d,
        benchmarkRate: row.benchmarkRate,
        sourceRiskScore: row.sourceRiskScore,
        venueRiskTier: row.venueRiskTier,
        warningSignals: [...row.warningSignals].sort(),
        deploymentPlace: row.deploymentPlace,
        sourceSwitch: row.sourceSwitch,
        yieldProtocolSlug: row.yieldProtocolSlug,
        yieldVenueChain: row.yieldVenueChain,
        yieldHistoryDays: row.yieldHistoryDays,
        yieldFreshnessAgeSec: row.yieldFreshness?.ageSeconds ?? null,
        effectiveTvlUsd: row.effectiveTvlUsd,
        concentrationHhi: row.concentrationHhi,
        chainTvl: sortRecord(row.chainTvl),
        effectiveExitScore: row.effectiveExitScore,
        bluechipGrade: row.bluechipGrade,
        supplyUsd: row.supplyUsd,
        isRecentListing: row.isRecentListing,
        trackingSpanDays: row.trackingSpanDays,
        yieldSources: (row.yieldSources ?? [])
          .map((source) => ({
            sourceKey: source.sourceKey,
            protocol: source.protocol,
            chain: source.chain,
            yieldType: source.yieldType,
            apy30d: source.apy30d,
            pharosYieldScore: source.pharosYieldScore,
            sourceTvlUsd: source.sourceTvlUsd,
            dataSource: source.dataSource,
            sourceRiskScore: source.sourceRiskScore,
            venueRiskTier: source.venueRiskTier,
            deploymentPlace: source.deploymentPlace,
            sourceDepthRatio: source.sourceDepthRatio,
            sourceSwitchCount30d: source.sourceSwitchCount30d,
            observationCount30d: source.observationCount30d,
            freshnessAgeSec: source.freshness?.ageSeconds ?? null,
            isPrimary: source.isPrimary,
          }))
          .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
      })),
  };

  return {
    rows,
    timestamp: args.now,
    datasetHash: sha256Hex(canonicalizeForDatasetHash(datasetContent)),
    methodologyVersions,
  };
}

function normalizeVenueRiskTier(tier: YieldVenueRiskTier | null | undefined): MergedRow["venueRiskTier"] {
  if (tier === "low" || tier === "high") return tier;
  if (tier === "medium") return "mid";
  return null;
}

function normalizeDeploymentPlace(place: YieldDeploymentPlace | null | undefined): MergedRow["deploymentPlace"] {
  switch (place) {
    case "native-wrapper":
    case "issuer-savings":
      return place;
    case "lp-or-dex":
      return "lp";
    case "lending-market":
    case "structured-tranche":
      return "lending";
    default:
      return null;
  }
}

function buildYieldSourceCandidates(
  ranking: YieldRanking | undefined,
  now: number,
): NonNullable<MergedRow["yieldSources"]> {
  if (!ranking) return [];
  const selectedRisk = ranking.sourceRisk ?? null;
  const selected: NonNullable<MergedRow["yieldSources"]>[number] = {
    sourceKey: ranking.provenance?.sourceKey ?? sourceKeyFor(ranking.yieldSource, ranking.yieldType, selectedRisk),
    protocol: selectedRisk?.venueProtocol ?? ranking.yieldSource,
    chain: selectedRisk?.venueChain ?? null,
    yieldType: ranking.yieldType,
    apy30d: ranking.apy30d,
    pharosYieldScore: ranking.pharosYieldScore,
    sourceTvlUsd: ranking.sourceTvlUsd,
    dataSource: ranking.dataSource,
    sourceRiskScore: selectedRisk?.sourceRiskScore ?? null,
    venueRiskTier: normalizeVenueRiskTier(selectedRisk?.venueRiskTier),
    deploymentPlace: normalizeDeploymentPlace(selectedRisk?.deploymentPlace),
    sourceDepthRatio: selectedRisk?.sourceDepthRatio ?? null,
    sourceSwitchCount30d: selectedRisk?.sourceSwitchCount30d ?? null,
    observationCount30d: selectedRisk?.observationCount30d ?? null,
    freshness: yieldFreshnessFrom(ranking, now),
    isPrimary: true,
  };

  const alternates = (ranking.altSources ?? []).map((source) =>
    altYieldSourceCandidate(source, ranking.pharosYieldScore, now),
  );

  return [selected, ...alternates];
}

function altYieldSourceCandidate(
  source: AltYieldSource,
  pharosYieldScore: number | null,
  now: number,
): NonNullable<MergedRow["yieldSources"]>[number] {
  const risk = source.sourceRisk ?? null;
  return {
    sourceKey: source.sourceKey,
    protocol: risk?.venueProtocol ?? source.yieldSource,
    chain: risk?.venueChain ?? null,
    yieldType: source.yieldType,
    apy30d: source.apy30d,
    pharosYieldScore,
    sourceTvlUsd: source.sourceTvlUsd,
    dataSource: source.dataSource,
    sourceRiskScore: risk?.sourceRiskScore ?? null,
    venueRiskTier: normalizeVenueRiskTier(risk?.venueRiskTier),
    deploymentPlace: normalizeDeploymentPlace(risk?.deploymentPlace),
    sourceDepthRatio: risk?.sourceDepthRatio ?? null,
    sourceSwitchCount30d: risk?.sourceSwitchCount30d ?? null,
    observationCount30d: risk?.observationCount30d ?? null,
    freshness: freshnessFromRisk(risk, now),
    isPrimary: false,
  };
}

function sourceKeyFor(
  protocol: string,
  yieldType: YieldType,
  risk: YieldSourceRisk | null,
): string {
  return [
    risk?.venueProtocol ?? protocol,
    risk?.venueChain ?? "unknown-chain",
    yieldType,
  ].join(":");
}

function yieldFreshnessFrom(
  ranking: YieldRanking | undefined,
  now: number,
): MergedRow["yieldFreshness"] {
  if (ranking?.provenance) {
    return {
      capturedAt: ranking.provenance.sourceObservedAt,
      ageSeconds: ranking.provenance.sourceAgeSeconds,
    };
  }
  const sourceAgeSeconds = ranking?.sourceRisk?.sourceAgeSeconds;
  if (sourceAgeSeconds == null) return null;
  return {
    capturedAt: Math.max(0, Math.round(toUnixSeconds(now) - sourceAgeSeconds)),
    ageSeconds: sourceAgeSeconds,
  };
}

function freshnessFromRisk(
  risk: YieldSourceRisk | null,
  now: number,
): MergedRow["yieldFreshness"] {
  const sourceAgeSeconds = risk?.sourceAgeSeconds;
  if (sourceAgeSeconds == null) return null;
  return {
    capturedAt: Math.max(0, Math.round(toUnixSeconds(now) - sourceAgeSeconds)),
    ageSeconds: sourceAgeSeconds,
  };
}

function ageSecondsFromTimestamp(timestamp: number | null | undefined, now: number): number | null {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round(toUnixSeconds(now) - toUnixSeconds(timestamp)));
}

function toUnixSeconds(timestamp: number): number {
  return timestamp > 1_000_000_000_000 ? timestamp / 1000 : timestamp;
}

function joinVersions(...versions: Array<string | null | undefined>): string {
  const present = versions.filter((version): version is string => Boolean(version));
  if (present.length === 0) return "unversioned";
  return Array.from(new Set(present)).join("+");
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}
