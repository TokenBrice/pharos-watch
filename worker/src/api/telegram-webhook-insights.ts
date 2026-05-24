import { aggregateChains } from "@shared/lib/chain-aggregator";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReportCard, DimensionKey } from "@shared/types/report-cards";
import type { DigestInputData } from "@shared/types/digest";
import { escapeHtml } from "../lib/telegram";
import { safeJsonParse } from "../lib/api-utils";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache, REPORT_CARD_CACHE_MAX_AGE_MS } from "../lib/report-card-cache";
import { buildReportCardsSnapshot } from "../lib/report-cards-snapshot";
import { suggestClosestToken } from "../lib/telegram-alerts";
import { TOP_VIEW_NAMES } from "../lib/telegram-constants";
import type { StatusForCoin } from "./telegram-webhook-status";

const TOP_LIMIT = 5;
const TOP_VIEWS = TOP_VIEW_NAMES;

function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatAge(ts: number | null | undefined, nowSec = Math.floor(Date.now() / 1000)): string {
  if (ts == null || !Number.isFinite(ts)) return "unknown age";
  const ageSec = Math.max(0, nowSec - ts);
  if (ageSec < 90) return "fresh";
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m old`;
  if (ageSec < 172800) return `${Math.round(ageSec / 3600)}h old`;
  return `${Math.round(ageSec / 86400)}d old`;
}

function truncate(text: string, max = 220): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function topDimensionWeaknesses(card: ReportCard): Array<[DimensionKey, ReportCard["dimensions"][DimensionKey]]> {
  return (Object.entries(card.dimensions) as Array<[DimensionKey, ReportCard["dimensions"][DimensionKey]]>)
    .sort(([, a], [, b]) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY))
    .slice(0, 2);
}

export async function buildBriefMessage(db: D1Database): Promise<string> {
  const row = await db
    .prepare(
      `SELECT digest_title, digest_text, digest_extended, generated_at, input_data
         FROM daily_digest
        WHERE digest_meta IS NULL
           OR json_extract(digest_meta, '$.type') IS NULL
           OR json_extract(digest_meta, '$.type') != 'weekly'
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .first<{
      digest_title: string | null;
      digest_text: string | null;
      digest_extended: string | null;
      generated_at: number;
      input_data: string | null;
    }>();

  if (!row) {
    return "No digest brief is available yet.";
  }

  const input = safeJsonParse<DigestInputData | null>(row.input_data, null);
  const lines = [
    `<b>Pharos Market Brief</b>`,
    row.digest_title ? `<b>${escapeHtml(row.digest_title)}</b>` : null,
    `Updated: ${formatAge(row.generated_at)}`,
  ].filter((line): line is string => Boolean(line));

  if (input?.riskTape?.length) {
    lines.push("");
    lines.push("<b>Risk tape</b>");
    for (const item of input.riskTape.slice(0, 4)) {
      lines.push(`- ${escapeHtml(item.label)}: ${escapeHtml(item.value)}${item.detail ? ` — ${escapeHtml(item.detail)}` : ""}`);
    }
  }

  if (input?.changeSummary) {
    const changes = [
      ...input.changeSummary.newSignals,
      ...input.changeSummary.worsenedSignals,
      ...input.changeSummary.resolvedSignals,
    ].slice(0, 4);
    if (changes.length > 0) {
      lines.push("");
      lines.push("<b>Signal changes</b>");
      for (const change of changes) {
        lines.push(`- ${escapeHtml(change.label)}: ${escapeHtml(change.detail)}`);
      }
    }
  }

  if (input?.nextTriggers?.length) {
    lines.push("");
    lines.push("<b>Next triggers</b>");
    for (const trigger of input.nextTriggers.slice(0, 3)) {
      lines.push(`- ${escapeHtml(trigger.label)}: ${escapeHtml(trigger.thresholdLabel)}`);
    }
  }

  if (lines.length <= 3) {
    lines.push("");
    lines.push(escapeHtml(truncate(row.digest_text ?? row.digest_extended ?? "Digest text unavailable.")));
  }

  lines.push("");
  lines.push(`<a href="https://pharos.watch/digest/">Open digest archive</a>`);
  return lines.join("\n");
}

export async function buildTopMessage(db: D1Database, view: string): Promise<string> {
  const normalized = view.trim().toLowerCase();
  switch (normalized) {
    case "depeg":
    case "depegs": {
      const result = await db
        .prepare(
          `SELECT stablecoin_id, symbol, direction, peak_deviation_bps, COALESCE(peak_price, start_price) AS display_price, peg_reference, started_at
             FROM depeg_events
            WHERE ended_at IS NULL
            ORDER BY ABS(peak_deviation_bps) DESC, started_at DESC
            LIMIT ?`,
        )
        .bind(TOP_LIMIT)
        .all<{
          stablecoin_id: string;
          symbol: string;
          direction: string;
          peak_deviation_bps: number;
          display_price: number;
          peg_reference: number;
          started_at: number;
        }>();
      return formatTopRows("Top active depegs", result.results ?? [], (row, i) =>
        `${i}. ${row.symbol} — ${row.direction} peg ${(row.peak_deviation_bps / 100).toFixed(1)}%, price $${row.display_price.toFixed(4)}, ${formatAge(row.started_at)} old`,
      );
    }
    case "dews": {
      const result = await db
        .prepare(
          `SELECT s.stablecoin_id, s.band, s.score, s.computed_at
             FROM stress_signals s
             JOIN (
               SELECT stablecoin_id, MAX(computed_at) AS computed_at
                 FROM stress_signals
                GROUP BY stablecoin_id
             ) latest ON latest.stablecoin_id = s.stablecoin_id AND latest.computed_at = s.computed_at
            ORDER BY s.score DESC
            LIMIT ?`,
        )
        .bind(TOP_LIMIT)
        .all<{ stablecoin_id: string; band: string; score: number; computed_at: number }>();
      return formatTopRows("Top DEWS scores", result.results ?? [], (row, i) => {
        const symbol = TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.stablecoin_id;
        return `${i}. ${symbol} — ${row.band} (${row.score}), ${formatAge(row.computed_at)}`;
      });
    }
    case "yield":
    case "yields": {
      const result = await db
        .prepare(
          `SELECT stablecoin_id, symbol, current_apy, apy_30d, yield_source, pharos_yield_score, source_tvl_usd
             FROM yield_data
            WHERE is_best = 1
              AND (publication_generation_id IS NULL OR publication_state = 'published')
            ORDER BY pharos_yield_score DESC, apy_30d DESC
            LIMIT ?`,
        )
        .bind(TOP_LIMIT)
        .all<{
          stablecoin_id: string;
          symbol: string;
          current_apy: number;
          apy_30d: number;
          yield_source: string;
          pharos_yield_score: number | null;
          source_tvl_usd: number | null;
        }>();
      return formatTopRows("Top risk-adjusted yields", result.results ?? [], (row, i) =>
        `${i}. ${row.symbol} — ${row.apy_30d.toFixed(2)}% 30d, PYS ${row.pharos_yield_score != null ? Math.round(row.pharos_yield_score) : "NR"}, TVL ${formatUsdCompact(row.source_tvl_usd)} (${row.yield_source})`,
      );
    }
    case "liquidity": {
      const result = await db
        .prepare(
          `SELECT stablecoin_id, symbol, liquidity_score, total_tvl_usd, pool_count
             FROM dex_liquidity
            ORDER BY liquidity_score DESC, total_tvl_usd DESC
            LIMIT ?`,
        )
        .bind(TOP_LIMIT)
        .all<{
          stablecoin_id: string;
          symbol: string;
          liquidity_score: number | null;
          total_tvl_usd: number;
          pool_count: number;
        }>();
      return formatTopRows("Top DEX liquidity", result.results ?? [], (row, i) =>
        `${i}. ${row.symbol} — score ${row.liquidity_score ?? "NR"}, TVL ${formatUsdCompact(row.total_tvl_usd)}, ${row.pool_count} pools`,
      );
    }
    case "chains": {
      const stablecoinsResult = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
      if (stablecoinsResult.kind !== "ok") return "Chain rankings are temporarily unavailable.";
      const reportCardResult = await loadReportCardCache(db, { maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS });
      const safetyScores: Record<string, number> = {};
      if (reportCardResult.kind === "ok") {
        for (const [id, entry] of Object.entries(reportCardResult.payload.scores)) {
          safetyScores[id] = entry.score;
        }
      }
      const { rates: pegRates } = derivePegRates(
        stablecoinsResult.payload.peggedAssets,
        TRACKED_META_BY_ID,
        stablecoinsResult.payload.fxFallbackRates,
      );
      const chains = aggregateChains({
        peggedAssets: stablecoinsResult.payload.peggedAssets,
        safetyScores,
        pegRates,
      }).chains.slice(0, TOP_LIMIT);
      return formatTopRows("Top chains by stablecoin supply", chains, (row, i) =>
        `${i}. ${row.name} — ${formatUsdCompact(row.totalUsd)}, health ${row.healthScore ?? "NR"} (${row.healthBand})`,
      );
    }
    case "safety": {
      const snapshot = await buildReportCardsSnapshot(db);
      const cards = snapshot.cards
        .filter((card) => !card.isDefunct && card.overallScore != null)
        .sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0))
        .slice(0, TOP_LIMIT);
      return formatTopRows("Top Safety Scores", cards, (card, i) =>
        `${i}. ${card.symbol} — ${card.overallGrade} (${card.overallScore ?? "NR"})`,
      );
    }
    default: {
      const usage = "Usage: /top depeg|dews|yield|liquidity|chains|safety";
      if (!normalized) return usage;
      const suggestion = suggestClosestToken(normalized, TOP_VIEWS);
      return suggestion ? `Did you mean /top ${suggestion}?\n${usage}` : usage;
    }
  }
}

function formatTopRows<T>(title: string, rows: readonly T[], render: (row: T, index: number) => string): string {
  if (rows.length === 0) return `${title}\nNo rows available right now.`;
  return escapeHtml([title, ...rows.map((row, index) => render(row, index + 1))].join("\n"));
}

export async function buildWhyMessage(db: D1Database, stablecoinId: string): Promise<string> {
  const snapshot = await buildReportCardsSnapshot(db);
  const card = snapshot.cards.find((candidate) => candidate.id === stablecoinId);
  if (!card) return "No Safety Score is available for that coin yet.";

  const lines = [
    `<b>${escapeHtml(card.symbol)} Safety Score</b>`,
    `Overall: ${card.overallGrade}${card.overallScore != null ? ` (${card.overallScore})` : ""}`,
  ];
  const weaknesses = topDimensionWeaknesses(card);
  if (weaknesses.length > 0) {
    lines.push("");
    lines.push("<b>Weakest dimensions</b>");
    for (const [dimension, detail] of weaknesses) {
      lines.push(`- ${escapeHtml(formatDimensionName(dimension))}: ${detail.grade}${detail.score != null ? ` (${detail.score})` : ""} — ${escapeHtml(truncate(detail.detail, 140))}`);
    }
  }

  const inputs = card.rawInputs;
  const riskNotes: string[] = [];
  if (inputs.activeDepeg) riskNotes.push(`active depeg cap${inputs.activeDepegBps != null ? ` (${inputs.activeDepegBps} bps)` : ""}`);
  if (inputs.canBeBlacklisted) riskNotes.push("blacklistable/freeze risk");
  if (inputs.dependencies.length > 0) riskNotes.push(`${inputs.dependencies.length} modeled dependencies`);
  if (inputs.collateralFromLive) riskNotes.push("live reserve data contributes to collateral scoring");
  if (riskNotes.length > 0) {
    lines.push("");
    lines.push(`Watch: ${escapeHtml(riskNotes.join(", "))}.`);
  }

  lines.push("");
  lines.push(`<a href="https://pharos.watch/stablecoin/${stablecoinId}">Open report card</a>`);
  return lines.join("\n");
}

function formatDimensionName(key: DimensionKey): string {
  switch (key) {
    case "pegStability": return "Peg stability";
    case "liquidity": return "Liquidity";
    case "resilience": return "Resilience";
    case "decentralization": return "Decentralization";
    case "dependencyRisk": return "Dependency risk";
  }
}

export function buildCoverageMessage(symbol: string, status: StatusForCoin): string {
  const lines = [
    `<b>${escapeHtml(symbol)} coverage</b>`,
    `Price: ${status.priceUsd != null ? "yes" : "missing"}`,
    `Supply: ${status.supplyUsd != null ? formatUsdCompact(status.supplyUsd) : "missing"}`,
    `DEWS: ${status.dews ? `${status.dews.band} (${formatAge(status.dews.computedAt)})` : "missing"}`,
    `Safety: ${status.safety ? `${status.safety.grade}${status.safety.score != null ? ` (${status.safety.score})` : ""}` : "missing"}`,
    `Active depeg: ${status.depeg.status === "active" ? "yes" : "no"}`,
    `DEX liquidity: ${status.liquidity ? `score ${status.liquidity.score ?? "NR"}, TVL ${formatUsdCompact(status.liquidity.totalTvlUsd)}` : "missing"}`,
    `Yield: ${status.yield ? `${status.yield.apy30d.toFixed(2)}% 30d at ${status.yield.source}` : "missing"}`,
    `<a href="https://pharos.watch/stablecoin/${status.stablecoinId}">Open coin page</a>`,
  ];
  return lines.join("\n");
}
