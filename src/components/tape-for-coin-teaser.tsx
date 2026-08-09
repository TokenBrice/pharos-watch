"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { baseEventType, describeEventDelta, firstSentence } from "@/lib/tape-derive";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { SEVERITY_LABEL, SEVERITY_TEXT_CLASS, type TapeEvent } from "@shared/types/tape-event";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

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

function newsTitle(event: TapeEvent): string {
  const mapped = NEWS_TITLE_BY_TYPE[baseEventType(event.type)];
  if (mapped) return mapped;
  const humanized = baseEventType(event.type).replace(/[._]/g, " ");
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

function newsDeltaClass(event: TapeEvent): string {
  if (WORSENING_TYPES.has(baseEventType(event.type))) return SEVERITY_TONE_CLASS.alert.text;
  if (IMPROVING_TYPES.has(baseEventType(event.type))) return SEVERITY_TONE_CLASS.ok.text;
  return SEVERITY_TONE_CLASS.neutral.text;
}

function NewsEntry({ event, nowMs }: { event: TapeEvent; nowMs: number }) {
  const href = event.sourceUrl ?? `/timeline/?event=${encodeURIComponent(event.id)}`;
  // Coin identity is implicit on the coin's own page; non-coin events (e.g.
  // methodology) carry their descriptive content in `title`, not `summary`.
  const body = event.summary ? firstSentence(event.summary) : !event.coinId ? event.title : "";
  const delta = describeEventDelta(event);
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
  const { data, dataUpdatedAt, isLoading } = useLatestEvents({ coin: coinId, limit: 5 });
  const events = data?.events ?? [];
  // Lazy initializer keeps the render pure (react-hooks/purity). TanStack Query
  // refreshes dataUpdatedAt after successful polling refetches, so keep labels
  // tied to the latest event payload instead of freezing at mount time.
  const [nowMs] = useState(() => Date.now());
  const labelNowMs = dataUpdatedAt > 0 ? dataUpdatedAt : nowMs;

  if (!isLoading && events.length === 0) {
    return null;
  }

  return (
    <div className="pharos-card-shell space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>News</h2>
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
            <NewsEntry key={event.id} event={event} nowMs={labelNowMs} />
          ))}
        </div>
      )}
    </div>
  );
}
