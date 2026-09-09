import { z } from "zod";
import { DailySocialSnapshotSchema, formatDailySocialValue, type DailySocialSnapshot, type DailySocialTopic } from "@shared/lib/daily-social";
import { getCirculatingRaw, getPrevWeekRawOrNull } from "@shared/lib/supply";
import { isFreshnessWarningHeader } from "@shared/lib/api-freshness";
import { StablecoinListResponseSchema, DexLiquidityMapSchema, DexLiquidityHistoryResponseSchema, DepegEventsResponseSchema,
  type StablecoinData, type DexLiquidityMap, type DexLiquidityHistoryPoint, type DepegEvent } from "@shared/types/market";
import { YieldRankingsResponseSchema, type YieldRankingsResponse } from "@shared/types/yield";
import { ReportCardsV9ResponseSchema, type ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { buildMaintenanceApiRequest } from "./maintenance-api";

const DAY = 86400;
const WEEK = 7 * DAY;
export type DailySocialEdition = { editionDate: string; scheduledAt: number };
type Base = DailySocialEdition & { capturedAt: number; asOf: number };
type Content = Pick<DailySocialSnapshot, "topic" | "title" | "subtitle" | "unit" | "rows" | "methodology"> & Partial<Pick<DailySocialSnapshot, "highlights" | "source">>;
const usd = (value: number) => formatDailySocialValue(value, "usd");
function finish(base: Base, content: Content): DailySocialSnapshot {
  return DailySocialSnapshotSchema.parse({ schemaVersion: 1, highlights: [], source: "Pharos API", ...base, ...content });
}
function fresh(timestamp: number, now: number, maxAge = 7200): boolean {
  return Number.isInteger(timestamp) && timestamp > 0 && timestamp <= now + 60 && now - timestamp <= maxAge;
}
function bucketValid(bucket: Record<string, number> | null | undefined): boolean {
  return !!bucket && Object.keys(bucket).length > 0 && Object.values(bucket).every((value) => Number.isFinite(value) && value >= 0);
}
export function eligibleSocialAssets(assets: readonly StablecoinData[], now: number): StablecoinData[] {
  return assets.filter((asset) => !asset.frozen && !asset.supplyRestored && bucketValid(asset.circulating)
    && (asset.supplyObservedAt == null || fresh(asset.supplyObservedAt, now, 3600)) && getCirculatingRaw(asset) > 0);
}

export function buildMarketSocial(topic: "market-growth" | "market-share" | "market-overview", assets: readonly StablecoinData[], base: Base): DailySocialSnapshot {
  const eligible = eligibleSocialAssets(assets, base.capturedAt);
  const cohort = eligible.filter((asset) => bucketValid(asset.circulatingPrevWeek) && (getPrevWeekRawOrNull(asset) ?? 0) > 0);
  const total = cohort.reduce((sum, asset) => sum + getCirculatingRaw(asset), 0);
  const previousTotal = cohort.reduce((sum, asset) => sum + getPrevWeekRawOrNull(asset)!, 0);
  if (!eligible.length || (topic !== "market-overview" && (!total || !previousTotal))) throw new Error("No comparable market data");
  if (topic === "market-overview") {
    return finish(base, { topic, title: "The stablecoin market, today", subtitle: "Largest tracked assets by circulating market cap", unit: "usd",
      rows: [...eligible].sort((a, b) => getCirculatingRaw(b) - getCirculatingRaw(a) || a.id.localeCompare(b.id)).slice(0, 5).map((asset) => ({ id: asset.id, name: asset.name, symbol: asset.symbol, value: getCirculatingRaw(asset), context: "Circulating market cap" })),
      highlights: [{ label: "Eligible tracked assets", value: String(eligible.length) }],
      methodology: "Current circulating market caps as published by Pharos. Frozen, restored and stale observed supplies excluded. Asset caps are not a deduplicated ecosystem total.", source: "Pharos · circulating supply" });
  }
  const changes = cohort.filter((asset) => getCirculatingRaw(asset) >= 10_000_000).map((asset) => {
    const current = getCirculatingRaw(asset), previous = getPrevWeekRawOrNull(asset)!;
    return { id: asset.id, name: asset.name, symbol: asset.symbol,
      value: topic === "market-growth" ? current - previous : 100 * (current / total - previous / previousTotal),
      context: topic === "market-growth" ? `${((current / previous - 1) * 100).toFixed(2)}% in 7d · ${usd(current)} cap` : `${(current / total * 100).toFixed(2)}% of comparable cohort today` };
  }).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const rows = topic === "market-growth" ? changes.filter((row) => row.value > 0).slice(0, 5)
    : [...changes.filter((row) => row.value > 0).slice(0, 3), ...changes.filter((row) => row.value < 0).sort((a, b) => a.value - b.value || a.id.localeCompare(b.id)).slice(0, 2)];
  return finish(base, { topic, title: topic === "market-growth" ? "This week's market-cap growers" : "This week's market-share movers",
    subtitle: "7-day change · $10M+ current market cap · comparable tracked assets", unit: topic === "market-growth" ? "usd" : "percentage-points",
    rows: rows.length ? rows : [{ id: "no-movers", name: topic === "market-growth" ? "Qualifying gainers" : "Qualifying movers", value: 0, context: "No qualifying changes among eligible tracked assets" }],
    ...(rows.length ? {} : { unit: "count" as const }),
    highlights: [{ label: "Comparable cohort", value: `${cohort.length} assets` }],
    methodology: topic === "market-growth" ? "Ranked by dollars added over seven days, not price returns. Valid positive baselines only; frozen, restored and stale observed supplies excluded."
      : "Three largest percentage-point gains and two largest losses in share of the same eligible asset cohort at both dates. Not whole-market share; wrappers may overlap underlying supply. Frozen, restored and stale observed supplies excluded.", source: "Pharos · circulating supply" });
}

export function buildLiquiditySocial(map: DexLiquidityMap, histories: Record<string, DexLiquidityHistoryPoint[]>, assets: readonly StablecoinData[], base: Base): DailySocialSnapshot {
  const names = new Map(eligibleSocialAssets(assets, base.capturedAt).map((asset) => [asset.id, asset]));
  const candidates = Object.entries(map).flatMap(([id, current]) => {
    const asset = names.get(id);
    if (!asset || !fresh(current.updatedAt, base.capturedAt) || !current.trendworthy || !current.hasMeasuredLiquidityEvidence || current.warning || current.totalTvlUsd <= 0) return [];
    const target = current.updatedAt - WEEK;
    const previous = (histories[id] ?? []).filter((point) => point.trendworthy && point.hasMeasuredLiquidityEvidence && point.methodologyVersion === current.methodologyVersion && point.coverageClass === current.coverageClass && point.tvl > 0 && Math.abs(point.date - target) <= 36 * 3600)
      .sort((a, b) => Math.abs(a.date - target) - Math.abs(b.date - target))[0];
    if (!previous || current.totalTvlUsd <= previous.tvl) return [];
    return [{ id, name: asset.name, symbol: asset.symbol, value: current.totalTvlUsd - previous.tvl,
      context: `${((current.totalTvlUsd / previous.tvl - 1) * 100).toFixed(2)}% · ${usd(current.totalTvlUsd)} liquidity`, observedAt: current.updatedAt }];
  }).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)).slice(0, 5);
  if (!candidates.length) throw new Error("No comparable positive liquidity growth");
  return finish({ ...base, asOf: Math.min(base.asOf, ...candidates.map((row) => row.observedAt)) }, { topic: "liquidity-growth", title: "Where DEX liquidity is growing", subtitle: "Approx. 7-day dollars added · comparable measured liquidity", unit: "usd",
    rows: candidates.map(({ observedAt: _observedAt, ...row }) => row),
    methodology: "Ranked by tracked pool TVL added. Nearest daily baseline within 36 hours of seven days earlier; same methodology and coverage class, measured trendworthy evidence only. Coverage changes can affect TVL; this is not net deposits.", source: "Pharos · DEX liquidity history" });
}

export function buildYieldSocial(data: YieldRankingsResponse, assets: readonly StablecoinData[], base: Base): DailySocialSnapshot {
  const safety = data.provenance?.liveSafetyHydration ?? data.provenance?.safetySnapshot;
  if (!safety || safety.kind !== "ok" || !safety.publishedAt || !fresh(safety.publishedAt, base.capturedAt)
    || !safety.safetyScoreIdentity) throw new Error("Yield safety evidence unavailable or stale");
  const eligible = new Set(eligibleSocialAssets(assets, base.capturedAt).map((asset) => asset.id));
  const rows = data.rankings.filter((row) => eligible.has(row.id) && row.currentApy > 0 && row.currentApy <= 100
    && (row.safetyScore ?? 0) >= 70 && row.safetyGrade !== "NR" && (row.sourceTvlUsd ?? 0) >= 1_000_000
    && row.warningSignals.length === 0 && row.provenance?.sourceFreshness === "fresh" && row.provenance.scoreQualified === true
    && !row.provenance.usedDefaultSafety && row.provenance.anomalies.length === 0 && row.provenance.safetyScoreIdentity?.model === "v9"
    && row.provenance.safetyScoreIdentity.publicationGenerationId === safety.safetyScoreIdentity!.publicationGenerationId
    && fresh(row.provenance.sourceObservedAt, base.capturedAt, 7200) && (row.sourceRisk?.investabilityFlags?.length ?? 0) === 0)
    .sort((a, b) => b.currentApy - a.currentApy || a.id.localeCompare(b.id)).slice(0, 5);
  if (!rows.length) throw new Error("No qualifying fresh yield opportunities");
  return finish({ ...base, asOf: Math.min(base.asOf, data.updatedAt, safety.publishedAt, ...rows.map((row) => row.provenance!.sourceObservedAt)) }, {
    topic: "yield-watch", title: "This week's yield watch", subtitle: "Current APY · Safety Score 70+ · $1M+ source TVL", unit: "percent",
    rows: rows.map((row) => ({ id: row.id, name: row.name, symbol: row.symbol, value: row.currentApy,
      context: `${row.safetyGrade} ${row.safetyScore}/100 · ${usd(row.sourceTvlUsd!)} TVL · ${row.yieldSource}` })),
    methodology: "Current variable APY, not guaranteed returns. Ranked by APY among sources with Safety Score at least 70, $1M source TVL, fresh qualified evidence and no warning/anomaly/investability flags. Safety and source TVL do not guarantee access or withdrawals.", source: "Pharos · Yield Intelligence" });
}

export function buildStabilitySocial(events: readonly DepegEvent[], base: Base): DailySocialSnapshot {
  const start = base.asOf - WEEK;
  const started = events.filter((event) => event.startedAt >= start && event.startedAt <= base.asOf);
  const recovered = events.filter((event) => event.endedAt != null && event.endedAt >= start && event.endedAt <= base.asOf && (!event.closeReason || event.closeReason.startsWith("recovered-")));
  const ongoing = events.filter((event) => event.startedAt <= base.asOf && event.endedAt == null);
  return finish(base, { topic: "stability", title: "The weekly stability report", subtitle: "Confirmed incidents · trailing 7 days · all tracked assets", unit: "count",
    rows: [{ id: "started", name: "New incidents", value: started.length, context: "Confirmed incidents that began in the last seven days" },
      { id: "recovered", name: "Recoveries", value: recovered.length, context: "Incidents recorded as recovered in the last seven days" },
      { id: "ongoing", name: "Still open", value: ongoing.length, context: "All currently open incidents, including older episodes" }],
    highlights: started.length ? [{ label: "New incidents: highest lifetime peak", value: `${Math.max(...started.map((event) => Math.abs(event.peakDeviationBps)))} bps` }] : [{ label: "New confirmed incidents", value: "None recorded" }],
    methodology: "Complete confirmed-incident archive; pending observations excluded. Counts are incidents, not distinct coins. New-incident lifetime peaks may extend beyond the reporting window. Closure types other than recovery are excluded from recoveries.", source: "Pharos · depeg incidents" });
}

export function buildSafetySocial(data: ReportCardsV9Response, assets: readonly StablecoinData[], base: Base): DailySocialSnapshot {
  if (data.publicationHealth.status !== "current" || !fresh(data.asOfSec, base.capturedAt)) throw new Error("Safety publication is held or stale");
  const eligible = new Map(eligibleSocialAssets(assets, base.capturedAt).filter((asset) => getCirculatingRaw(asset) >= 10_000_000).map((asset) => [asset.id, asset]));
  const cards = data.cards.filter((card) => eligible.has(card.id) && card.score != null && card.grade !== "NR")
    .sort((a, b) => b.score! - a.score! || a.id.localeCompare(b.id)).slice(0, 5);
  return finish({ ...base, asOf: Math.min(base.asOf, data.asOfSec) }, { topic: "safety", title: "The current Safety Score board", subtitle: `Highest current scores · $10M+ market cap · methodology ${data.methodology.version}`, unit: "score",
    rows: cards.map((card) => ({ id: card.id, name: eligible.get(card.id)!.name, symbol: eligible.get(card.id)!.symbol, value: card.score!, context: `Grade ${card.grade}${card.weakestPillar ? ` · weakest pillar: ${card.weakestPillar.pillar}` : ""}` })),
    methodology: "Current published scores, not weekly movers or guarantees. Sparse grade-change history cannot prove exact seven-day score deltas. Rated tracked assets with $10M+ market cap only; ties broken by asset ID.", source: "Pharos · Safety Score V9" });
}

export async function captureDailySocial(topic: DailySocialTopic, edition: DailySocialEdition, nowSec: number, fetcher: typeof fetch = fetch): Promise<DailySocialSnapshot> {
  const get = async (path: string, maxAge = 7200, historical = false): Promise<{ data: unknown; asOf: number }> => {
    const request = buildMaintenanceApiRequest(path, process.env.PHAROS_API_KEY);
    const response = await fetcher(request.url, { headers: request.headers, signal: AbortSignal.timeout(30_000) });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(`Pharos ${path.split("?")[0]} HTTP ${response.status}`);
    const meta = z.object({ _meta: z.object({ updatedAt: z.number(), status: z.string() }).optional(), updatedAt: z.number().optional(), asOfSec: z.number().optional() }).passthrough().safeParse(data);
    const ageHeader = response.headers.get("x-data-age");
    const age = ageHeader !== null && /^\d+$/.test(ageHeader) ? Number(ageHeader) : null;
    const edgeAgeHeader = response.headers.get("age");
    const edgeAge = edgeAgeHeader !== null && /^\d+$/.test(edgeAgeHeader) ? Number(edgeAgeHeader) : 0;
    const candidates = [...(meta.success ? [meta.data.asOfSec, meta.data._meta?.updatedAt, meta.data.updatedAt] : []), ...(age !== null ? [nowSec - age - edgeAge] : [])].filter((value): value is number => value !== undefined);
    const asOf = candidates.length ? Math.min(...candidates) : 0;
    const warning = response.headers.get("warning") ?? "";
    if (!historical && (!fresh(asOf, nowSec, maxAge) || candidates.some((timestamp) => timestamp > nowSec + 60) || isFreshnessWarningHeader(warning) || /timestamp.*future/i.test(warning)
      || (meta.success && meta.data._meta && meta.data._meta.status !== "fresh"))) throw new Error(`Stale or undated Pharos data: ${path.split("?")[0]}`);
    return { data, asOf };
  };
  const market = await get("/api/stablecoins");
  const assets = StablecoinListResponseSchema.parse(market.data).peggedAssets;
  const observations = eligibleSocialAssets(assets, nowSec).flatMap((asset) => asset.supplyObservedAt != null ? [asset.supplyObservedAt] : []);
  const base = { ...edition, capturedAt: nowSec, asOf: Math.min(market.asOf, ...observations) };
  if (topic === "market-growth" || topic === "market-share" || topic === "market-overview") return buildMarketSocial(topic, assets, base);
  if (topic === "yield-watch") {
    const result = await get("/api/yield-rankings");
    return buildYieldSocial(YieldRankingsResponseSchema.parse(result.data), assets, { ...base, asOf: Math.min(base.asOf, result.asOf) });
  }
  if (topic === "safety") {
    const result = await get("/api/report-cards/v9");
    return buildSafetySocial(ReportCardsV9ResponseSchema.parse(result.data), assets, base);
  }
  if (topic === "liquidity-growth") {
    const result = await get("/api/dex-liquidity");
    const raw = z.record(z.string(), z.unknown()).parse(result.data);
    const map = DexLiquidityMapSchema.parse(Object.fromEntries(Object.entries(raw).filter(([id]) => !id.startsWith("_"))));
    const eligible = new Set(eligibleSocialAssets(assets, nowSec).map((asset) => asset.id));
    const histories: Record<string, DexLiquidityHistoryPoint[]> = {};
    // Consume every response before opening the next; a bounded source cohort, not a top-N approximation.
    for (const [id, row] of Object.entries(map)) {
      if (!eligible.has(id) || !row.trendworthy || !row.hasMeasuredLiquidityEvidence || row.warning || !fresh(row.updatedAt, nowSec)) continue;
      // Historical arrays have no freshness header. Exact point dates and comparability are validated by the builder.
      const history = await get(`/api/dex-liquidity-history?stablecoin=${encodeURIComponent(id)}&days=10`, 3 * DAY, true);
      histories[id] = DexLiquidityHistoryResponseSchema.parse(history.data);
    }
    return buildLiquiditySocial(map, histories, assets, { ...base, asOf: Math.min(base.asOf, result.asOf) });
  }
  const events: DepegEvent[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await get(`/api/depeg-events?limit=1000&includeTotal=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    base.asOf = Math.min(base.asOf, result.asOf);
    const parsed = DepegEventsResponseSchema.parse(result.data);
    events.push(...parsed.events);
    if (!parsed.nextCursor) {
      if (parsed.totalExact === false || events.length !== parsed.total || new Set(events.map((event) => event.id)).size !== events.length) throw new Error("Incomplete or changing depeg archive");
      return buildStabilitySocial(events, base);
    }
    if (cursors.has(parsed.nextCursor)) throw new Error("Repeated depeg cursor");
    cursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  throw new Error("Depeg archive exceeds capture bound");
}
