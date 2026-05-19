import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { canonicalizeForDatasetHash, type MergedRow, type SelectorOutput } from "@shared/lib/selector";
import { COLLATERAL_QUALITY_SCORE } from "@shared/lib/report-card-policy";
import type {
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
  YieldVenueRiskTier,
} from "@shared/types";

export interface BuildSelectorRowsArgs {
  stablecoinsData: StablecoinListResponse | null;
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
    if (meta.flags.pegCurrency !== "USD") continue;

    const peg = pegById.get(id);
    const safety = reportById.get(id);
    const rawInputs = safety?.rawInputs;
    const stress = args.stressData?.signals?.[id];
    const dex = args.dexData?.[id];
    const yieldEntry = yieldById.get(id);
    const yieldRisk = yieldEntry?.sourceRisk ?? null;
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
      mechanismArchetype: meta.mechanismArchetype ?? null,

      supplyUsd: supplyById.get(id) ?? 0,

      pegScore: peg?.pegScore ?? rawInputs?.pegScore ?? null,
      pegStabilityScore: safety?.dimensions.pegStability.score ?? null,
      activeDepeg: peg?.activeDepeg ?? rawInputs?.activeDepeg ?? false,
      currentDeviationBps,
      depegEventCount: peg?.eventCount ?? rawInputs?.depegEventCount ?? 0,
      lastEventAt: peg?.lastEventAt ?? rawInputs?.lastEventAt ?? null,

      dewsScore: stress?.score ?? null,
      safetyGrade: safety?.overallGrade ?? null,
      safetyScore: safety?.overallScore ?? null,
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
        redemption?.effectiveExitScore
        ?? rawInputs?.effectiveExitScore
        ?? (dex as { effectiveExitScore?: number | null } | undefined)?.effectiveExitScore
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

  const datasetContent = Array.from(rows.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, row]) => ({
      id,
      safetyGrade: row.safetyGrade,
      overallScore: row.safetyScore,
      pegScore: row.pegScore,
      dewsScore: row.dewsScore,
      liquidityScore: row.liquidityScore,
      safetyPegStabilityScore: row.pegStabilityScore,
      safetyResilienceScore: row.safetyResilienceScore,
      safetyDependencyRiskScore: row.safetyDependencyRiskScore,
      safetyDecentralizationScore: row.safetyDecentralizationScore,
      safetyLiquidityScore: row.safetyLiquidityScore,
      pharosYieldScore: row.pharosYieldScore,
      apy30d: row.apy30d,
      bluechipGrade: row.bluechipGrade,
      supplyUsd: row.supplyUsd,
    }));

  return {
    rows,
    timestamp: args.now,
    datasetHash: djb2Hex(canonicalizeForDatasetHash(datasetContent)),
    methodologyVersions: {
      safetyScore: args.reportData?.methodology?.version ?? "unversioned",
      pegScoreAndDews: joinVersions(
        args.pegData?.methodology?.version,
        args.stressData?.methodology?.version,
      ),
      yieldIntelligence: args.yieldData?.methodology?.version ?? "unversioned",
      bluechipAlignment: "unversioned",
      exclusionFilters: "selector-v1.0",
    },
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
      return "lending";
    default:
      return null;
  }
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

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
