"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { formatCompactUsd } from "@shared/lib/format";
import { SEVERITY_LABEL, SEVERITY_TEXT_CLASS, type TapeEvent } from "@shared/types/tape-event";

interface TapeForCoinTeaserProps {
  /** Canonical stablecoin id (e.g. `usdt-tether`). */
  coinId: string;
}

// Humanized verb titles for the coin-rail News presentation (Figma coin
// template). The wire-service slug idiom stays on /timeline; here each entry
// leads with a plain-language verb ("Burned", "Deescalated").
const NEWS_TITLE_BY_TYPE: Record<string, string> = {
  "mint_burn.large_burn": "Burned",
  "mint_burn.large_mint": "Minted",
  "mint_burn.large_flow": "Large flow",
  "dews.escalated": "Escalated",
  "dews.deescalated": "Deescalated",
  "psi.shifted_down": "PSI shifted down",
  "psi.shifted_up": "PSI shifted up",
  "psi.band_changed": "PSI band changed",
  "score.upgraded": "Upgraded",
  "score.downgraded": "Downgraded",
  "yield.pys_dropped": "Yield score dropped",
  "yield.warning_emitted": "Yield warning",
  "depeg.opened": "Depeg opened",
  "depeg.peak_worsened": "Depeg worsened",
  "depeg.resolved": "Depeg resolved",
  "freeze.blocked": "Address frozen",
  "freeze.unblocked": "Address unfrozen",
  "freeze.destroyed": "Funds destroyed",
};

const WORSENING_TYPES = new Set([
  "dews.escalated",
  "psi.shifted_down",
  "score.downgraded",
  "yield.pys_dropped",
  "depeg.opened",
  "depeg.peak_worsened",
  "freeze.blocked",
  "freeze.destroyed",
]);

const IMPROVING_TYPES = new Set([
  "dews.deescalated",
  "psi.shifted_up",
  "score.upgraded",
  "depeg.resolved",
  "freeze.unblocked",
]);

function baseType(type: string): string {
  return type.split(":")[0];
}

function newsTitle(event: TapeEvent): string {
  const mapped = NEWS_TITLE_BY_TYPE[baseType(event.type)];
  if (mapped) return mapped;
  const humanized = baseType(event.type).replace(/[._]/g, " ");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

// UTC day diff so labels agree with the tape feed's UTC day grouping.
function newsDateLabel(tsMs: number, nowMs: number): string {
  const utcDay = (ms: number) => Math.floor(ms / 86_400_000);
  const diff = utcDay(nowMs) - utcDay(tsMs);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const date = new Date(tsMs);
  const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${date.getUTCDate()} ${month}`;
}

// Sentence-end punctuation only counts when followed by whitespace/EOL so
// amounts like "$20.0M" don't truncate mid-number.
function firstSentence(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const sentence = match ? match[0] : trimmed;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatSignedScore(value: number): string {
  const formatted = formatScore(Math.abs(value));
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

// Compact mono delta line under the sentence body (Figma: "16 → 6 · -12").
function newsDelta(event: TapeEvent): string | null {
  const p = event.payload;
  const cls = baseType(event.type).split(".")[0];
  switch (cls) {
    case "dews":
    case "psi":
    case "score":
    case "yield": {
      const prev = typeof p?.prevScore === "number" ? p.prevScore : null;
      const next = typeof p?.newScore === "number" ? p.newScore : null;
      if (prev == null || next == null) return null;
      return `${formatScore(prev)} → ${formatScore(next)} · ${formatSignedScore(next - prev)}`;
    }
    case "mint_burn": {
      const amount = p?.amountUsd;
      if (typeof amount !== "number" || amount <= 0) return null;
      const direction = p?.direction;
      const verb = direction === "mint" ? "minted" : direction === "burn" ? "burned" : "moved";
      return `${formatCompactUsd(amount)} ${verb}`;
    }
    case "freeze": {
      const amount = p?.amountUsdAtEvent;
      if (typeof amount !== "number" || amount <= 0) return null;
      return formatCompactUsd(amount);
    }
    case "depeg": {
      const abs = p?.absDeviationBps;
      if (typeof abs !== "number") return null;
      const sign = p?.direction === "below" ? "−" : "+";
      return `${sign}${abs} bps`;
    }
    default:
      return null;
  }
}

function newsDeltaClass(event: TapeEvent): string {
  if (WORSENING_TYPES.has(baseType(event.type))) return "text-red-600 dark:text-red-400";
  if (IMPROVING_TYPES.has(baseType(event.type))) return "text-emerald-600 dark:text-emerald-400";
  return "text-muted-foreground";
}

function NewsEntry({ event, nowMs }: { event: TapeEvent; nowMs: number }) {
  const href = event.sourceUrl ?? `/timeline/?event=${encodeURIComponent(event.id)}`;
  // Coin identity is implicit on the coin's own page; non-coin events (e.g.
  // methodology) carry their descriptive content in `title`, not `summary`.
  const body = event.summary ? firstSentence(event.summary) : !event.coinId ? event.title : "";
  const delta = newsDelta(event);
  return (
    <Link href={href} className="pharos-focus-ring block rounded-sm py-2.5 transition-colors hover:bg-muted/30">
      <div className="flex items-center justify-between gap-2">
        <time dateTime={new Date(event.ts).toISOString()} className="text-[11px] tabular-nums text-muted-foreground">
          {newsDateLabel(event.ts, nowMs)}
        </time>
        <span
          className={`inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_TEXT_CLASS[event.severity]}`}
        >
          {SEVERITY_LABEL[event.severity]}
        </span>
      </div>
      <p className="mt-1 text-sm font-semibold text-foreground">{newsTitle(event)}</p>
      {body ? <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{body}</p> : null}
      {delta ? <p className={`mt-1 font-mono text-[11px] tabular-nums ${newsDeltaClass(event)}`}>{delta}</p> : null}
    </Link>
  );
}

export function TapeForCoinTeaser({ coinId }: TapeForCoinTeaserProps) {
  const { data, isLoading } = useLatestEvents({ coin: coinId, limit: 5 });
  const events = data?.events ?? [];
  // Lazy initializer keeps the render pure (react-hooks/purity); freshness
  // labels only need mount-time "now", matching safety-score-history-section.
  const [nowMs] = useState(() => Date.now());

  if (!isLoading && events.length === 0) {
    return null;
  }

  return (
    <div className="pharos-card-shell space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">News</h2>
        <Link
          href={`/timeline/?coin=${encodeURIComponent(coinId)}`}
          aria-label="View all events on the timeline"
          className="pharos-focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading recent events…</p>
      ) : (
        <div className="divide-y divide-border/40">
          {events.map((event) => (
            <NewsEntry key={event.id} event={event} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}
