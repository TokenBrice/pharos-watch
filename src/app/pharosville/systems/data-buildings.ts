import {
  DEX_GLOBAL_KEY,
  type BlacklistSummaryResponse,
  type DexLiquidityData,
  type DexLiquidityMap,
  type MintBurnCoinFlow,
  type MintBurnFlowsResponse,
  type RedemptionBackstopsResponse,
  type ReportCard,
  type ReportCardsResponse,
  type YieldRanking,
  type YieldRankingsResponse,
} from "@shared/types";
import type { AreaNode, BuildingNode, BuildingStatus, BuildingType, PharosVilleFreshness } from "./world-types";

export interface DataBuildingInputs {
  blacklistSummary: BlacklistSummaryResponse | null | undefined;
  dexLiquidity: DexLiquidityMap | null | undefined;
  freshness: PharosVilleFreshness;
  mintBurnFlows: MintBurnFlowsResponse | null | undefined;
  redemptionBackstops: RedemptionBackstopsResponse | null | undefined;
  reportCards: ReportCardsResponse | null | undefined;
  yieldRankings: YieldRankingsResponse | null | undefined;
}

const BUILDING_TILES: Record<BuildingType, { x: number; y: number }> = {
  "mint-burn-foundry": { x: 29, y: 30 },
  "dependency-loom-chainworks": { x: 34, y: 28 },
  "yield-orchard-moonwell": { x: 40, y: 30 },
  "exit-route-gatehouse": { x: 31, y: 34 },
};

const BUILDING_LABELS: Record<BuildingType, string> = {
  "mint-burn-foundry": "Royal Mint And Burn Foundry",
  "exit-route-gatehouse": "Exit Route Gatehouse",
  "yield-orchard-moonwell": "Yield Orchard And Moonwell",
  "dependency-loom-chainworks": "Dependency Loom / Chainworks",
};

const STATUS_LABELS: Record<BuildingStatus, string> = {
  balanced: "Balanced",
  "broad-coverage": "Broad source coverage",
  burning: "Burn-heavy",
  concentrated: "Concentrated exits",
  "deep-exit": "Deep exits",
  "high-hub-concentration": "High hub concentration",
  "high-median-apy": "High median APY",
  "large-active-frozen": "Active freezes",
  "many-direct-dependents": "Many direct dependents",
  minting: "Mint-heavy",
  quiet: "Quiet",
  "recent-freeze": "Recent freeze activity",
  "source-switch": "Source switching",
  stale: "Stale",
  "thin-exit": "Thin exits",
  unavailable: "Unavailable",
};

const BUILDING_ACCENTS: Record<BuildingType, string> = {
  "mint-burn-foundry": "#f1b84f",
  "exit-route-gatehouse": "#65c7bd",
  "yield-orchard-moonwell": "#89c96f",
  "dependency-loom-chainworks": "#c99bff",
};

const BUILDING_ASSET_IDS: Record<BuildingType, string> = {
  "mint-burn-foundry": "building.mint-burn-foundry",
  "exit-route-gatehouse": "building.exit-route-gatehouse",
  "yield-orchard-moonwell": "building.yield-orchard-moonwell",
  "dependency-loom-chainworks": "building.dependency-loom-chainworks",
};

const compactUsd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const ratioPercent = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent",
});

export function buildDataBuildings(inputs: DataBuildingInputs): BuildingNode[] {
  return [
    buildMintBurnFoundry(inputs.mintBurnFlows, inputs.freshness),
    buildExitRouteGatehouse(inputs.dexLiquidity, inputs.redemptionBackstops, inputs.reportCards, inputs.freshness),
    buildYieldOrchard(inputs.yieldRankings, inputs.freshness),
    buildDependencyLoom(inputs.reportCards, inputs.freshness),
  ];
}

const NORTH_FROZE_POLE_TILE = { x: 0, y: 0 } as const;
const NORTH_FROZE_POLE_ACCENT = "#9ed8ff";

function buildMintBurnFoundry(
  flows: MintBurnFlowsResponse | null | undefined,
  freshness: PharosVilleFreshness,
): BuildingNode {
  const sourceFields = ["gauge", "coins[]", "hourly[]", "scope", "sync"];
  if (!flows) {
    return makeBuilding({
      buildingType: "mint-burn-foundry",
      status: "unavailable",
      summary: "Configured issuance-chain mint and burn events are not available yet.",
      facts: unavailableFacts("Source fields", sourceFields.join(", ")),
      sourceFields,
      links: [{ label: "Mint/burn flows", href: "/flows/" }],
      visual: unavailableVisual("mint-burn-foundry"),
    });
  }

  const hourlyMint = sum(flows.hourly.map((bucket) => bucket.mintVolumeUsd));
  const hourlyBurn = sum(flows.hourly.map((bucket) => bucket.burnVolumeUsd));
  const hourlyNet = sum(flows.hourly.map((bucket) => bucket.netFlowUsd));
  const coinMint = sum(flows.coins.map((coin) => coin.mintVolume24hUsd));
  const coinBurn = sum(flows.coins.map((coin) => coin.burnVolume24hUsd));
  const coinNet = sum(flows.coins.map((coin) => coin.netFlow24hUsd));
  const mintVolume24hUsd = flows.hourly.length > 0 ? hourlyMint : coinMint;
  const burnVolume24hUsd = flows.hourly.length > 0 ? hourlyBurn : coinBurn;
  const netFlow24hUsd = flows.hourly.length > 0 ? hourlyNet : coinNet;
  const activityUsd = mintVolume24hUsd + burnVolume24hUsd;
  const flowScore = finiteNumber(flows.gauge.score);
  const activeCoins = flows.coins.filter((coin) => (
    coin.has24hActivity === true || coin.mintCount24h + coin.burnCount24h > 0
  ));
  const largestEvent = largestMintBurnEvent(flows.coins);
  const stale = freshness.mintBurnStale === true
    || flows.sync?.freshnessStatus === "stale"
    || flows.sync?.criticalLaneHealthy === false;
  let status: BuildingStatus = "balanced";
  if (stale) status = "stale";
  else if (activityUsd <= 0) status = "quiet";
  else if (flowScore != null && flowScore >= 20) status = "minting";
  else if (flowScore != null && flowScore <= -20) status = "burning";

  const activityIntensity = logIntensity(activityUsd, 5, 10);
  const totalDirectional = Math.max(1, mintVolume24hUsd + burnVolume24hUsd);
  const mintIntensity = status === "stale" ? activityIntensity * 0.24 : activityIntensity * (mintVolume24hUsd / totalDirectional);
  const burnIntensity = status === "stale" ? activityIntensity * 0.24 : activityIntensity * (burnVolume24hUsd / totalDirectional);

  return makeBuilding({
    buildingType: "mint-burn-foundry",
    status,
    summary: "Shows configured issuance-chain mint and burn events over the current window, not complete global issuance or redemption coverage.",
    facts: [
      { label: "Status", value: STATUS_LABELS[status] },
      { label: "Gauge band", value: flows.gauge.band ?? "Unavailable" },
      { label: "Flow score", value: flowScore == null ? "Unavailable" : decimal.format(flowScore) },
      { label: "24h mint volume", value: formatUsd(mintVolume24hUsd) },
      { label: "24h burn volume", value: formatUsd(burnVolume24hUsd) },
      { label: "24h net flow", value: formatSignedUsd(netFlow24hUsd) },
      { label: "Active coins", value: integer.format(activeCoins.length) },
      { label: "Largest event", value: largestEvent ? `${largestEvent.symbol} ${largestEvent.direction} ${formatUsd(largestEvent.amountUsd)}` : "Unavailable" },
      { label: "Scope", value: flows.scope?.label ?? "Configured issuance-chain events" },
      { label: "Sync", value: flows.sync?.freshnessStatus ?? "Unavailable" },
      { label: "Updated", value: formatTimestamp(flows.updatedAt) },
      { label: "Source fields", value: sourceFields.join(", ") },
    ],
    sourceFields,
    links: [{ label: "Mint/burn flows", href: "/flows/" }],
    membersHeading: "Most active coins",
    members: activeCoins
      .toSorted(compareMintBurnCoinActivity)
      .slice(0, 5)
      .map((coin) => ({
        id: coin.stablecoinId,
        label: coin.symbol,
        href: `/stablecoin/${coin.stablecoinId}/`,
        value: `${formatSignedUsd(coin.netFlow24hUsd)} net, ${formatUsd(coin.mintVolume24hUsd + coin.burnVolume24hUsd)} activity`,
      })),
    visual: {
      accent: BUILDING_ACCENTS["mint-burn-foundry"],
      dataFogIntensity: status === "stale" ? 0.62 : 0,
      intensity: activityIntensity,
      scale: 1,
      secondaryIntensity: clamp01(mintIntensity),
      tertiaryIntensity: clamp01(burnIntensity),
    },
  });
}

export function buildNorthFrozePoleArea(
  summary: BlacklistSummaryResponse | null | undefined,
  freshness: PharosVilleFreshness,
): AreaNode {
  const sourceFields = ["stats", "stats.perCoinFrozenTotal", "stats.recentCount24h", "chains", "methodology"];
  if (!summary) {
    return makeNorthFrozePoleArea({
      count: null,
      status: "unavailable",
      summary: "Observed blacklist and freeze tracker summary is not available yet.",
      facts: unavailableFacts("Source fields", sourceFields.join(", ")),
      sourceFields,
      links: [{ label: "Blacklist tracker", href: "/blacklist/" }],
      visual: unavailableNorthFrozePoleVisual(),
    });
  }

  const stats = summary.stats;
  let status: BuildingStatus = "quiet";
  if (freshness.blacklistStale === true) status = "stale";
  else if (stats.recentCount24h > 0 || stats.recentCount > 0) status = "recent-freeze";
  else if (stats.activeFrozenTotal > 0 || stats.activeAddressCount > 0) status = "large-active-frozen";

  const frostIntensity = clamp01((Math.log10(stats.activeFrozenTotal + 1) - 4) / 5);
  const mistIntensity = Math.max(frostIntensity * 0.75, clamp01(Math.log10(stats.activeAddressCount + 1) / 3) * 0.6);
  const chainIntensity = clamp01(Math.sqrt(stats.recentCount24h) / 4 + Math.sqrt(Math.max(stats.recentCount - stats.recentCount24h, 0)) / 12);
  const dataFogIntensity = status === "stale"
    ? 0.75
    : clamp01((stats.activeAmountGapCount + stats.recoverableGapCount) / 20) * 0.6;

  return makeNorthFrozePoleArea({
    count: stats.recentCount24h > 0 ? stats.recentCount24h : stats.recentCount || null,
    status,
    summary: "Northern frozen-water route for observed freeze, blacklist, unblacklist, and destroy events from tracked contracts.",
    facts: [
      { label: "Status", value: STATUS_LABELS[status] },
      { label: "Active frozen value", value: formatUsd(stats.activeFrozenTotal) },
      { label: "Active frozen addresses", value: integer.format(stats.activeAddressCount) },
      { label: "Frozen addresses observed", value: integer.format(stats.frozenAddresses) },
      { label: "Destroyed total", value: formatUsd(stats.destroyedTotal) },
      { label: "Recent events", value: integer.format(stats.recentCount) },
      { label: "Last 24h", value: integer.format(stats.recentCount24h) },
      { label: "Amount gaps", value: integer.format(stats.activeAmountGapCount) },
      { label: "Recoverable gaps", value: integer.format(stats.recoverableGapCount) },
      { label: "Supported chains", value: integer.format(summary.chains.length) },
      { label: "Total events", value: integer.format(summary.totalEvents) },
      { label: "Methodology", value: summary.methodology?.currentVersionLabel ?? summary.methodology?.versionLabel ?? "Unavailable" },
      { label: "Source fields", value: sourceFields.join(", ") },
    ],
    sourceFields,
    links: [{ label: "Blacklist tracker", href: "/blacklist/" }],
    membersHeading: "Largest active frozen totals",
    members: Object.entries(stats.perCoinFrozenTotal)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([symbol, frozenUsd]) => ({
        id: symbol,
        label: symbol,
        href: "/blacklist/",
        value: `${formatUsd(frozenUsd)} frozen`,
      })),
    visual: {
      accent: NORTH_FROZE_POLE_ACCENT,
      dataFogIntensity,
      intensity: frostIntensity,
      scale: 1,
      secondaryIntensity: chainIntensity,
      tertiaryIntensity: Math.max(chainIntensity, frostIntensity * 0.55, mistIntensity),
    },
  });
}

function buildExitRouteGatehouse(
  dexLiquidity: DexLiquidityMap | null | undefined,
  redemptionBackstops: RedemptionBackstopsResponse | null | undefined,
  reportCards: ReportCardsResponse | null | undefined,
  freshness: PharosVilleFreshness,
): BuildingNode {
  const sourceFields = ["dexLiquidity[__global__]", "dexLiquidity[coin]", "redemptionBackstops.coins", "redemptionBackstops.methodology"];
  const dexEntries = Object.entries(dexLiquidity ?? {}).filter(([id]) => id !== DEX_GLOBAL_KEY);
  const globalDex = dexLiquidity?.[DEX_GLOBAL_KEY] ?? null;
  const redemptionEntries = Object.values(redemptionBackstops?.coins ?? {});
  const hasDex = !!globalDex || dexEntries.length > 0;
  const hasRedemption = redemptionEntries.length > 0;
  if (!hasDex && !hasRedemption) {
    return makeBuilding({
      buildingType: "exit-route-gatehouse",
      status: "unavailable",
      summary: "DEX liquidity telemetry and modeled redemption backstops are not available yet.",
      facts: unavailableFacts("Source fields", sourceFields.join(", ")),
      sourceFields,
      links: [
        { label: "Liquidity", href: "/liquidity/" },
        { label: "Redemption methodology", href: "/methodology/#redemption-backstops" },
      ],
      visual: unavailableVisual("exit-route-gatehouse"),
    });
  }

  const totalEffectiveTvlUsd = globalDex?.effectiveTvlUsd ?? sum(dexEntries.map(([, data]) => data.effectiveTvlUsd));
  const totalTvlUsd = globalDex?.totalTvlUsd ?? sum(dexEntries.map(([, data]) => data.totalTvlUsd));
  const totalVolume24hUsd = globalDex?.totalVolume24hUsd ?? sum(dexEntries.map(([, data]) => data.totalVolume24hUsd));
  const totalVolume7dUsd = globalDex?.totalVolume7dUsd ?? sum(dexEntries.map(([, data]) => data.totalVolume7dUsd));
  const liquidityScore = globalDex?.liquidityScore
    ?? weightedAverage(dexEntries.map(([, data]) => [data.liquidityScore, Math.max(data.effectiveTvlUsd, data.totalTvlUsd)]));
  const coverageConfidence = globalDex?.coverageConfidence
    ?? weightedAverage(dexEntries.map(([, data]) => [data.coverageConfidence, Math.max(data.effectiveTvlUsd, data.totalTvlUsd)]));
  const protocolTvl = mergeProtocolTvl(globalDex, dexEntries.map(([, data]) => data));
  const protocolTvlTotal = sum(Object.values(protocolTvl));
  const dominantProtocolShare = protocolTvlTotal > 0 ? Math.max(0, ...Object.values(protocolTvl)) / protocolTvlTotal : 0;
  const concentrationHhi = globalDex?.concentrationHhi ?? hhi(Object.values(protocolTvl));
  const volumeVs7dAverage = totalVolume7dUsd > 0 ? (totalVolume24hUsd / (totalVolume7dUsd / 7)) - 1 : null;

  const openRoutes = redemptionEntries.filter((entry) => entry.routeStatus === "open").length;
  const degradedRoutes = redemptionEntries.filter((entry) => entry.routeStatus === "degraded" || entry.routeStatus === "cohort-limited").length;
  const pausedRoutes = redemptionEntries.filter((entry) => entry.routeStatus === "paused").length;
  const routeCount = redemptionEntries.length;
  const openRouteShare = routeCount > 0 ? openRoutes / routeCount : 0;
  const medianExitScore = median(redemptionEntries.map((entry) => finiteNumber(entry.effectiveExitScore ?? entry.score)));
  const immediateCapacityUsd = sum(redemptionEntries.map((entry) => finiteNumber(entry.immediateCapacityUsd) ?? 0));
  const strongRouteCount = redemptionEntries.filter((entry) => (
    (entry.effectiveExitScore ?? entry.score ?? 0) >= 70 && entry.routeStatus === "open"
  )).length;
  const topRouteFamily = topCategory(redemptionEntries.map((entry) => entry.routeFamily));
  const topAccessModel = topCategory(redemptionEntries.map((entry) => entry.accessModel));
  const topSettlementModel = topCategory(redemptionEntries.map((entry) => entry.settlementModel));

  let status: BuildingStatus = "thin-exit";
  if (freshness.dexLiquidityStale === true || freshness.redemptionBackstopsStale === true) status = "stale";
  else if (concentrationHhi >= 0.35 || dominantProtocolShare >= 0.55) status = "concentrated";
  else if ((liquidityScore ?? 0) >= 70 && (medianExitScore ?? 0) >= 70 && openRouteShare >= 0.65) status = "deep-exit";

  const volumeIntensity = logIntensity(totalVolume24hUsd, 4, 9);
  const depthIntensity = clamp01((liquidityScore ?? 0) / 100);

  return makeBuilding({
    buildingType: "exit-route-gatehouse",
    status,
    summary: "Combines observed DEX liquidity telemetry with modeled redemption backstops; these are not guarantees of executable exit capacity.",
    facts: [
      { label: "Exit route state", value: STATUS_LABELS[status] },
      { label: "DEX effective TVL", value: formatUsd(totalEffectiveTvlUsd) },
      { label: "DEX total TVL", value: formatUsd(totalTvlUsd) },
      { label: "DEX 24h volume", value: formatUsd(totalVolume24hUsd) },
      { label: "DEX volume vs 7d avg", value: formatSignedRatio(volumeVs7dAverage) },
      { label: "DEX liquidity score", value: formatScore(liquidityScore) },
      { label: "DEX coverage confidence", value: formatRatio(coverageConfidence) },
      { label: "Redemption effective exit score", value: formatScore(medianExitScore) },
      { label: "Immediate redemption capacity", value: formatUsd(immediateCapacityUsd) },
      { label: "Open/degraded/paused routes", value: `${openRoutes}/${degradedRoutes}/${pausedRoutes}` },
      { label: "Strong open routes", value: integer.format(strongRouteCount) },
      { label: "Primary route family", value: topRouteFamily ?? "Unavailable" },
      { label: "Primary access model", value: topAccessModel ?? "Unavailable" },
      { label: "Primary settlement model", value: topSettlementModel ?? "Unavailable" },
      { label: "Concentration HHI", value: formatRatio(concentrationHhi) },
      { label: "Caveat", value: "DEX telemetry and modeled redemption routes are not guarantees of executable exit capacity." },
      { label: "Methodology", value: redemptionBackstops?.methodology.currentVersionLabel ?? redemptionBackstops?.methodology.versionLabel ?? "Unavailable" },
      { label: "Source fields", value: sourceFields.join(", ") },
    ],
    sourceFields,
    links: [
      { label: "Liquidity", href: "/liquidity/" },
      { label: "Redemption methodology", href: "/methodology/#redemption-backstops" },
    ],
    membersHeading: "Weakest visible exits",
    members: weakestExitMembers(dexEntries, redemptionBackstops, reportCards),
    visual: {
      accent: BUILDING_ACCENTS["exit-route-gatehouse"],
      dataFogIntensity: status === "stale" ? 0.7 : 0,
      intensity: Math.max(depthIntensity, volumeIntensity * 0.7),
      scale: 1,
      secondaryIntensity: volumeIntensity,
      tertiaryIntensity: status === "concentrated" ? 1 : openRouteShare,
    },
  });
}

function buildYieldOrchard(
  yieldRankings: YieldRankingsResponse | null | undefined,
  freshness: PharosVilleFreshness,
): BuildingNode {
  const sourceFields = ["rankings[]", "rankings[].provenance", "provenance.benchmark", "provenance.safetySnapshot"];
  if (!yieldRankings) {
    return makeBuilding({
      buildingType: "yield-orchard-moonwell",
      status: "unavailable",
      summary: "Yield ranking and source context are not available yet.",
      facts: unavailableFacts("Source fields", sourceFields.join(", ")),
      sourceFields,
      links: [{ label: "Yield intelligence", href: "/yield/" }],
      visual: unavailableVisual("yield-orchard-moonwell"),
    });
  }

  const rankings = yieldRankings.rankings;
  const sourceKeys = new Set(rankings.map(sourceKeyForYieldRanking));
  const sourceSwitches = rankings.filter((ranking) => ranking.provenance?.sourceSwitch === true).length;
  const anomalyCount = sum(rankings.map((ranking) => ranking.provenance?.anomalies.length ?? ranking.warningSignals.length));
  const safetyCoverage = yieldRankings.provenance?.safetySnapshot.coverageRatio ?? coverageRatio(rankings.map((ranking) => ranking.safetyScore));
  const medianApy = finiteNumber(yieldRankings.medianApy) ?? median(rankings.map((ranking) => finiteNumber(ranking.currentApy))) ?? 0;
  const riskFreeRate = finiteNumber(yieldRankings.riskFreeRate) ?? 0;
  const spread = medianApy - riskFreeRate;
  const benchmark = yieldRankings.provenance?.benchmark ?? yieldRankings.benchmarks?.USD ?? null;

  let status: BuildingStatus = "quiet";
  if (freshness.yieldStale === true) status = "stale";
  else if (sourceSwitches > 0 || anomalyCount > 0) status = "source-switch";
  else if (sourceKeys.size >= 4 || safetyCoverage >= 0.75) status = "broad-coverage";
  else if (isHighYieldSpread(spread, medianApy, riskFreeRate)) status = "high-median-apy";

  return makeBuilding({
    buildingType: "yield-orchard-moonwell",
    status,
    summary: "Shows yield ranking source breadth and benchmark context; higher APY is not presented as safer or better.",
    facts: [
      { label: "Status", value: STATUS_LABELS[status] },
      { label: "Ranked opportunities", value: integer.format(rankings.length) },
      { label: "Represented sources", value: integer.format(sourceKeys.size) },
      { label: "Median APY", value: formatApy(medianApy) },
      { label: "Benchmark", value: benchmark?.label ?? "USD default" },
      { label: "Benchmark rate", value: formatApy(benchmark?.rate ?? riskFreeRate) },
      { label: "Source switches", value: integer.format(sourceSwitches) },
      { label: "Warnings/anomalies", value: integer.format(anomalyCount) },
      { label: "Safety snapshot coverage", value: formatRatio(safetyCoverage) },
      { label: "Updated", value: formatTimestamp(yieldRankings.updatedAt) },
      { label: "Source fields", value: sourceFields.join(", ") },
    ],
    sourceFields,
    links: [{ label: "Yield intelligence", href: "/yield/" }],
    membersHeading: "Top ranked opportunities",
    members: rankings.slice(0, 5).map((ranking) => ({
      id: ranking.id,
      label: `${ranking.symbol} via ${ranking.yieldSource}`,
      href: `/stablecoin/${ranking.id}/`,
      value: `${formatApy(ranking.currentApy)} APY, ${ranking.safetyGrade ?? "NR"} safety`,
    })),
    visual: {
      accent: BUILDING_ACCENTS["yield-orchard-moonwell"],
      dataFogIntensity: status === "stale" ? 0.62 : 0,
      intensity: clamp01(safetyCoverage),
      scale: 1,
      secondaryIntensity: clamp01(sourceKeys.size / 6),
      tertiaryIntensity: clamp01(sourceSwitches / 8 + anomalyCount / 16),
    },
  });
}

function buildDependencyLoom(
  reportCards: ReportCardsResponse | null | undefined,
  freshness: PharosVilleFreshness,
): BuildingNode {
  const sourceFields = ["reportCards.cards[]", "reportCards.dependencyGraph.edges[]", "reportCards.methodology"];
  if (!reportCards) {
    return makeBuilding({
      buildingType: "dependency-loom-chainworks",
      status: "unavailable",
      summary: "Report-card dependency graph is not available yet.",
      facts: unavailableFacts("Source fields", sourceFields.join(", ")),
      sourceFields,
      links: [{ label: "Dependency map", href: "/dependency-map/" }],
      visual: unavailableVisual("dependency-loom-chainworks"),
    });
  }

  const cardsById = new Map(reportCards.cards.map((card) => [card.id, card]));
  const liveIds = new Set(reportCards.cards.filter((card) => card.isDefunct !== true).map((card) => card.id));
  const edges = reportCards.dependencyGraph.edges.filter((edge) => (
    liveIds.has(edge.to) && (liveIds.has(edge.from) || cardsById.has(edge.from))
  ));
  const edgeCount = edges.length;
  const dependents = new Set(edges.map((edge) => edge.to));
  const hubs = dependencyHubs(edges, cardsById);
  const topHub = hubs[0] ?? null;
  const topHubShare = edgeCount > 0 ? (topHub?.edgeCount ?? 0) / edgeCount : 0;
  const typeCounts = topCounts(edges.map((edge) => edge.type));
  let status: BuildingStatus = "quiet";
  if (freshness.reportCardsStale === true) status = "stale";
  else if (edgeCount === 0) status = "quiet";
  else if (topHubShare >= 0.4 && edgeCount >= 5) status = "high-hub-concentration";
  else if (dependents.size >= 20 || edgeCount >= 30) status = "many-direct-dependents";

  return makeBuilding({
    buildingType: "dependency-loom-chainworks",
    status,
    summary: "Shows direct report-card dependency graph links only; it does not draw transitive or value-at-risk exposure.",
    facts: [
      { label: "Status", value: STATUS_LABELS[status] },
      { label: "Direct links", value: integer.format(edgeCount) },
      { label: "Dependents", value: integer.format(dependents.size) },
      { label: "Upstream hubs", value: integer.format(hubs.length) },
      { label: "Strongest hub", value: topHub ? topHub.label : "Unavailable" },
      { label: "Hub concentration", value: formatRatio(topHubShare) },
      { label: "Dependency types", value: typeCounts.map((entry) => `${entry.label} ${entry.count}`).join(", ") || "Unavailable" },
      { label: "Methodology", value: reportCards.methodology.version },
      { label: "Source fields", value: sourceFields.join(", ") },
    ],
    sourceFields,
    links: [{ label: "Dependency map", href: "/dependency-map/" }],
    membersHeading: "Largest direct hubs",
    members: hubs.slice(0, 5).map((hub) => ({
      id: hub.id,
      label: hub.label,
      href: `/stablecoin/${hub.id}/`,
      value: `${integer.format(hub.edgeCount)} direct links, weight ${decimal.format(hub.weight)}`,
    })),
    visual: {
      accent: BUILDING_ACCENTS["dependency-loom-chainworks"],
      dataFogIntensity: status === "stale" ? 0.7 : 0,
      intensity: clamp01(Math.sqrt(edgeCount) / 7),
      scale: 1,
      secondaryIntensity: clamp01(topHubShare),
      tertiaryIntensity: clamp01(dependents.size / 35),
    },
  });
}

function makeBuilding(input: {
  buildingType: BuildingType;
  facts: Array<{ label: string; value: string }>;
  links: Array<{ label: string; href: string }>;
  members?: Array<{ id: string; label: string; href: string; value?: string }>;
  membersHeading?: string;
  sourceFields: string[];
  status: BuildingStatus;
  summary: string;
  visual: BuildingNode["visual"];
}): BuildingNode {
  return {
    id: `building.${input.buildingType}`,
    kind: "building",
    buildingType: input.buildingType,
    label: BUILDING_LABELS[input.buildingType],
    assetId: BUILDING_ASSET_IDS[input.buildingType],
    tile: BUILDING_TILES[input.buildingType],
    status: input.status,
    statusLabel: STATUS_LABELS[input.status],
    summary: input.summary,
    facts: input.facts,
    sourceFields: input.sourceFields,
    links: input.links,
    membersHeading: input.membersHeading,
    members: input.members,
    detailId: `building.${input.buildingType}`,
    visual: input.visual,
  };
}

function makeNorthFrozePoleArea(input: {
  count: number | null;
  facts: Array<{ label: string; value: string }>;
  links: Array<{ label: string; href: string }>;
  members?: Array<{ id: string; label: string; href: string; value?: string }>;
  membersHeading?: string;
  sourceFields: string[];
  status: BuildingStatus;
  summary: string;
  visual: AreaNode["visual"];
}): AreaNode {
  return {
    id: "area.north-froze-pole",
    kind: "area",
    label: "North Froze Pole",
    tile: NORTH_FROZE_POLE_TILE,
    dataAreaType: "north-froze-pole",
    count: input.count,
    status: input.status,
    statusLabel: STATUS_LABELS[input.status],
    summary: input.summary,
    facts: input.facts,
    sourceFields: input.sourceFields,
    links: input.links,
    membersHeading: input.membersHeading,
    members: input.members,
    detailId: "area.north-froze-pole",
    visual: input.visual,
  };
}

function unavailableVisual(buildingType: BuildingType): BuildingNode["visual"] {
  return {
    accent: BUILDING_ACCENTS[buildingType],
    dataFogIntensity: 0.72,
    intensity: 0.16,
    scale: 1,
    secondaryIntensity: 0.08,
    tertiaryIntensity: 0.08,
  };
}

function unavailableNorthFrozePoleVisual(): AreaNode["visual"] {
  return {
    accent: NORTH_FROZE_POLE_ACCENT,
    dataFogIntensity: 0.72,
    intensity: 0.16,
    scale: 1,
    secondaryIntensity: 0.08,
    tertiaryIntensity: 0.08,
  };
}

function unavailableFacts(label: string, value: string): Array<{ label: string; value: string }> {
  return [
    { label: "Status", value: "Unavailable" },
    { label, value },
  ];
}

function largestMintBurnEvent(coins: readonly MintBurnCoinFlow[]) {
  return coins.reduce<{
    amountUsd: number;
    direction: "mint" | "burn";
    symbol: string;
    timestamp: number;
  } | null>((best, coin) => {
    const event = coin.largestEvent24h;
    if (!event) return best;
    if (best && best.amountUsd >= event.amountUsd) return best;
    return {
      amountUsd: event.amountUsd,
      direction: event.direction,
      symbol: coin.symbol,
      timestamp: event.timestamp,
    };
  }, null);
}

function compareMintBurnCoinActivity(a: MintBurnCoinFlow, b: MintBurnCoinFlow): number {
  const aActivity = a.mintVolume24hUsd + a.burnVolume24hUsd;
  const bActivity = b.mintVolume24hUsd + b.burnVolume24hUsd;
  return bActivity - aActivity || Math.abs(b.netFlow24hUsd) - Math.abs(a.netFlow24hUsd) || a.symbol.localeCompare(b.symbol);
}

function weakestExitMembers(
  dexEntries: Array<[string, DexLiquidityData]>,
  redemptionBackstops: RedemptionBackstopsResponse | null | undefined,
  reportCards: ReportCardsResponse | null | undefined,
): BuildingNode["members"] {
  const cardsById = new Map(reportCards?.cards.map((card) => [card.id, card]) ?? []);
  const ids = new Set([
    ...dexEntries.map(([id]) => id),
    ...Object.keys(redemptionBackstops?.coins ?? {}),
  ]);
  return [...ids]
    .map((id) => {
      const dex = dexEntries.find(([entryId]) => entryId === id)?.[1] ?? null;
      const redemption = redemptionBackstops?.coins[id] ?? null;
      const card = cardsById.get(id) ?? null;
      const score = Math.min(
        finiteNumber(dex?.liquidityScore) ?? 100,
        finiteNumber(redemption?.effectiveExitScore ?? redemption?.score) ?? 100,
      );
      return { card, dex, id, redemption, score };
    })
    .toSorted((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map(({ card, dex, id, redemption, score }) => ({
      id,
      label: card ? `${card.symbol} (${card.name})` : id,
      href: `/stablecoin/${id}/`,
      value: `exit floor ${formatScore(score)}, DEX ${formatScore(dex?.liquidityScore ?? null)}, redemption ${formatScore(redemption?.effectiveExitScore ?? redemption?.score ?? null)}`,
    }));
}

function dependencyHubs(
  edges: ReportCardsResponse["dependencyGraph"]["edges"],
  cardsById: ReadonlyMap<string, ReportCard>,
) {
  const hubs = new Map<string, { edgeCount: number; id: string; label: string; weight: number }>();
  for (const edge of edges) {
    const hub = hubs.get(edge.from) ?? {
      edgeCount: 0,
      id: edge.from,
      label: cardsById.get(edge.from)?.symbol ?? edge.from,
      weight: 0,
    };
    hub.edgeCount += 1;
    hub.weight += edge.weight;
    hubs.set(edge.from, hub);
  }
  return [...hubs.values()].toSorted((a, b) => b.edgeCount - a.edgeCount || b.weight - a.weight || a.id.localeCompare(b.id));
}

function mergeProtocolTvl(globalDex: DexLiquidityData | null, data: readonly DexLiquidityData[]): Record<string, number> {
  if (globalDex && Object.keys(globalDex.protocolTvl).length > 0) return globalDex.protocolTvl;
  const merged: Record<string, number> = {};
  for (const entry of data) {
    for (const [protocol, tvl] of Object.entries(entry.protocolTvl)) {
      merged[protocol] = (merged[protocol] ?? 0) + tvl;
    }
  }
  return merged;
}

function sourceKeyForYieldRanking(ranking: YieldRanking): string {
  return ranking.provenance?.sourceKey
    ?? `${ranking.dataSource}:${ranking.yieldSource}`;
}

function isHighYieldSpread(spread: number, medianApy: number, riskFreeRate: number): boolean {
  if (Math.abs(medianApy) <= 1 && Math.abs(riskFreeRate) <= 1) return spread >= 0.03;
  return spread >= 1;
}

function coverageRatio(values: Array<number | null>): number {
  if (values.length === 0) return 0;
  return values.filter((value) => value != null).length / values.length;
}

function topCategory(values: readonly string[]): string | null {
  return topCounts(values)[0]?.label ?? null;
}

function topCounts(values: readonly string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ count, label }))
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function hhi(values: readonly number[]): number {
  const total = sum(values);
  if (total <= 0) return 0;
  return sum(values.map((value) => (value / total) ** 2));
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => value != null && Number.isFinite(value)).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? null;
}

function weightedAverage(pairs: Array<[number | null | undefined, number]>): number | null {
  const usable = pairs.filter((pair): pair is [number, number] => Number.isFinite(pair[0]) && Number.isFinite(pair[1]) && pair[1] > 0);
  const totalWeight = sum(usable.map(([, weight]) => weight));
  if (totalWeight <= 0) return null;
  return sum(usable.map(([value, weight]) => value * weight)) / totalWeight;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function logIntensity(value: number, minPower: number, maxPower: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp01((Math.log10(value + 1) - minPower) / (maxPower - minPower));
}

function formatUsd(value: number | null | undefined): string {
  return Number.isFinite(value) ? compactUsd.format(value as number) : "Unavailable";
}

function formatSignedUsd(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "Unavailable";
  const prefix = (value as number) > 0 ? "+" : "";
  return `${prefix}${compactUsd.format(value as number)}`;
}

function formatScore(value: number | null | undefined): string {
  return Number.isFinite(value) ? decimal.format(value as number) : "Unavailable";
}

function formatRatio(value: number | null | undefined): string {
  return Number.isFinite(value) ? ratioPercent.format(value as number) : "Unavailable";
}

function formatSignedRatio(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "Unavailable";
  const prefix = (value as number) > 0 ? "+" : "";
  return `${prefix}${ratioPercent.format(value as number)}`;
}

function formatApy(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${decimal.format(value as number)}%` : "Unavailable";
}

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!Number.isFinite(timestamp)) return "Unavailable";
  const value = timestamp as number;
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}
