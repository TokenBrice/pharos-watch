import { collapseByCoinClass, eventClassSlug, type CollapsedTapeEntry } from "@/lib/tape-collapse";
import { formatCompactUsd } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { SEVERITY_RANK, type TapeEventSeverity } from "@shared/types/tape-event";
import type { TapeEvent } from "@shared/types/tape-event";
import { tapeClassLabel } from "@/lib/tape-class-style";

const DAY_MS = 86_400_000;
const DIGEST_THRESHOLD = 3;

export interface DigestedClass {
  classSlug: string;
  classLabel: string;
  rawCount: number;
  collapsed: CollapsedTapeEntry[];
  summary: string;
  maxSeverity: TapeEventSeverity;
  /** True when the digest summary line should wrap the rows in a <details>. */
  useDigestWrapper: boolean;
}

export interface DigestedDay {
  dayKey: string;
  isToday: boolean;
  isYesterday: boolean;
  totalCount: number;
  classes: DigestedClass[];
}

function utcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function tickerFor(event: TapeEvent): string {
  if (event.coinId) {
    const symbol = TRACKED_META_BY_ID.get(event.coinId)?.symbol;
    if (symbol) return symbol;
  }
  const payloadSymbol = event.payload?.symbol;
  if (typeof payloadSymbol === "string" && payloadSymbol.length > 0) return payloadSymbol;
  // Freeze events carry the stablecoin ticker on `payload.stablecoin`, not `coinId`.
  const payloadStablecoin = event.payload?.stablecoin;
  if (typeof payloadStablecoin === "string" && payloadStablecoin.length > 0) return payloadStablecoin;
  return event.coinId ?? "—";
}

interface TickerCount {
  ticker: string;
  count: number;
}

function topTickers(events: readonly TapeEvent[], limit = 2): TickerCount[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const t = tickerFor(event);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([ticker, count]) => ({ ticker, count }))
    .sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}

function formatTopTickers(events: readonly TapeEvent[], limit = 2): string {
  const entries = topTickers(events, limit);
  if (entries.length === 0) return "";
  const parts = entries.map((e) => (e.count > 1 ? `${e.ticker} ×${e.count}` : e.ticker));
  const remaining = events.length - entries.reduce((sum, e) => sum + e.count, 0);
  if (remaining > 0) parts.push(`+${remaining} more`);
  return parts.join(" · ");
}

function depegSummary(events: readonly TapeEvent[]): string {
  let worstBps = 0;
  for (const e of events) {
    const abs = e.payload?.absDeviationBps;
    if (typeof abs === "number" && abs > worstBps) worstBps = abs;
  }
  const tickers = formatTopTickers(events);
  const worst = worstBps > 0 ? `worst ${worstBps} bps` : "";
  return [tickers, worst].filter(Boolean).join(" · ");
}

function freezeSummary(events: readonly TapeEvent[]): string {
  let totalUsd = 0;
  for (const e of events) {
    const amount = e.payload?.amountUsdAtEvent;
    if (typeof amount === "number" && amount > 0) totalUsd += amount;
  }
  const tickers = formatTopTickers(events);
  const usd = totalUsd > 0 ? `${formatCompactUsd(totalUsd)} frozen` : "";
  return [tickers, usd].filter(Boolean).join(" · ");
}

function scoreSummary(events: readonly TapeEvent[]): string {
  let upgrades = 0;
  let downgrades = 0;
  for (const e of events) {
    if (e.type === "score.upgraded") upgrades += 1;
    else if (e.type === "score.downgraded") downgrades += 1;
  }
  const parts: string[] = [];
  if (upgrades > 0) parts.push(`${upgrades} upgrade${upgrades === 1 ? "" : "s"}`);
  if (downgrades > 0) parts.push(`${downgrades} downgrade${downgrades === 1 ? "" : "s"}`);
  const tickers = formatTopTickers(events);
  return [parts.join(" · "), tickers].filter(Boolean).join(" · ");
}

function methodologySummary(events: readonly TapeEvent[]): string {
  const domains = new Set<string>();
  for (const e of events) {
    const dot = e.type.indexOf(":");
    if (dot !== -1) domains.add(e.type.slice(dot + 1));
    else if (typeof e.payload?.domain === "string") domains.add(e.payload.domain);
  }
  if (domains.size === 0) return "";
  return Array.from(domains).slice(0, 3).join(" · ");
}

function psiSummary(events: readonly TapeEvent[]): string {
  // PSI is a single global series — recap reads the worst band touched and
  // the latest transition direction.
  let worstBand = "";
  for (const e of events) {
    const newBand = e.payload?.newBand;
    if (typeof newBand === "string" && newBand.length > 0) {
      if (!worstBand || severityForBand(newBand) > severityForBand(worstBand)) {
        worstBand = newBand;
      }
    }
  }
  if (!worstBand) return "";
  return `worst band ${worstBand}`;
}

function severityForBand(band: string): number {
  const order = ["BEDROCK", "STEADY", "TREMOR", "FRACTURE", "CRISIS", "MELTDOWN"];
  return order.indexOf(band);
}

function yieldSummary(events: readonly TapeEvent[]): string {
  let warnings = 0;
  let drops = 0;
  let worstDrop = 0;
  for (const e of events) {
    if (e.type === "yield.warning_emitted") warnings += 1;
    else if (e.type === "yield.pys_dropped") {
      drops += 1;
      const delta = e.payload?.delta;
      if (typeof delta === "number" && delta < worstDrop) worstDrop = delta;
    }
  }
  const parts: string[] = [];
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (drops > 0) parts.push(`${drops} PYS drop${drops === 1 ? "" : "s"}`);
  if (worstDrop < 0) parts.push(`worst ${Math.round(worstDrop)} pts`);
  const tickers = formatTopTickers(events);
  return [parts.join(" · "), tickers].filter(Boolean).join(" · ");
}

function mintBurnSummary(events: readonly TapeEvent[]): string {
  let mintUsd = 0;
  let burnUsd = 0;
  let mintCount = 0;
  let burnCount = 0;
  for (const e of events) {
    const amt = e.payload?.amountUsd;
    if (typeof amt !== "number" || amt <= 0) continue;
    if (e.type === "mint_burn.large_mint") {
      mintUsd += amt;
      mintCount += 1;
    } else if (e.type === "mint_burn.large_burn") {
      burnUsd += amt;
      burnCount += 1;
    }
  }
  const parts: string[] = [];
  if (mintCount > 0) parts.push(`${formatCompactUsd(mintUsd)} minted`);
  if (burnCount > 0) parts.push(`${formatCompactUsd(burnUsd)} burned`);
  const tickers = formatTopTickers(events);
  return [parts.join(" · "), tickers].filter(Boolean).join(" · ");
}

function defaultSummary(events: readonly TapeEvent[]): string {
  return formatTopTickers(events);
}

function classSummary(classSlug: string, events: readonly TapeEvent[]): string {
  switch (classSlug) {
    case "depeg": return depegSummary(events);
    case "freeze": return freezeSummary(events);
    case "score": return scoreSummary(events);
    case "methodology": return methodologySummary(events);
    case "psi": return psiSummary(events);
    case "dews": return defaultSummary(events);
    case "mint_burn": return mintBurnSummary(events);
    case "yield": return yieldSummary(events);
    default: return defaultSummary(events);
  }
}

function maxSeverityOf(events: readonly TapeEvent[]): TapeEventSeverity {
  let maxRank = -1;
  let maxSev: TapeEventSeverity = "info";
  for (const e of events) {
    const rank = SEVERITY_RANK[e.severity];
    if (rank > maxRank) {
      maxRank = rank;
      maxSev = e.severity;
    }
  }
  return maxSev;
}

function digestEvents(events: readonly TapeEvent[]): DigestedClass[] {
  const byClass = new Map<string, TapeEvent[]>();
  for (const event of events) {
    const slug = eventClassSlug(event.type);
    const bucket = byClass.get(slug);
    if (bucket) bucket.push(event);
    else byClass.set(slug, [event]);
  }
  const out: DigestedClass[] = [];
  for (const [slug, classEvents] of byClass.entries()) {
    const maxSeverity = maxSeverityOf(classEvents);
    const collapsed = collapseByCoinClass(classEvents);
    const useDigestWrapper = classEvents.length >= DIGEST_THRESHOLD;
    out.push({
      classSlug: slug,
      classLabel: tapeClassLabel(slug),
      rawCount: classEvents.length,
      collapsed,
      summary: classSummary(slug, classEvents),
      maxSeverity,
      useDigestWrapper,
    });
  }
  // Sort: highest severity first, then by raw count desc, then alpha.
  out.sort((a, b) => {
    const sevDelta = SEVERITY_RANK[b.maxSeverity] - SEVERITY_RANK[a.maxSeverity];
    if (sevDelta !== 0) return sevDelta;
    if (b.rawCount !== a.rawCount) return b.rawCount - a.rawCount;
    return a.classSlug.localeCompare(b.classSlug);
  });
  return out;
}

export function digestByDay(events: readonly TapeEvent[], nowMs: number): DigestedDay[] {
  const groups = new Map<string, TapeEvent[]>();
  for (const event of events) {
    const key = utcDayKey(event.ts);
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }
  const todayKey = utcDayKey(nowMs);
  const yesterdayKey = utcDayKey(nowMs - DAY_MS);
  const out: DigestedDay[] = [];
  for (const [dayKey, dayEvents] of groups.entries()) {
    const isToday = dayKey === todayKey;
    const isYesterday = dayKey === yesterdayKey;
    out.push({
      dayKey,
      isToday,
      isYesterday,
      totalCount: dayEvents.length,
      classes: digestEvents(dayEvents),
    });
  }
  // Order days newest first by key (ISO date strings sort lexically).
  out.sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  return out;
}
