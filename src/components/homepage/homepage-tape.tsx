"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useHomepageSnapshot } from "@/hooks/api-hooks";
import { useLatestEvents } from "@/hooks/use-events";
import { useMinuteClockSec } from "@/hooks/use-minute-clock-sec";
import { getLogoSrc, logosById } from "@/lib/logos";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { collapseForHomepageStrip, eventClassSlug, type CollapsedTapeEntry } from "@/lib/tape-collapse";
import { formatTapeEventTitle, projectTapeEventsForReader } from "@/lib/tape-derive";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CHAIN_META } from "@shared/types/chain-identity";
import {
  ACTIVE_PEG_CURRENCY_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";
import { UNIVERSES } from "@/lib/universe-vocabulary";
import { SEVERITY_DOT_CLASS, SEVERITY_LABEL } from "@shared/lib/classification/tape";
import type { TapeEvent } from "@shared/types/tape-event";

function durationFromCount(count: number): string {
  // ~4.5 seconds per item — slow news ticker pace
  const seconds = Math.max(45, count * 4.5);
  return `${Math.round(seconds)}s`;
}

interface TapeItemProps {
  entry: CollapsedTapeEntry;
  logoSrc: string | undefined;
  logoName: string | null;
  logos: Record<string, string>;
  /** Viewer-clock milliseconds; 0 before the mounted clock ticks. */
  nowMs: number;
}

// A consolidated cell names this many coins, then "+N"; its logo stack matches.
const NAMED_COIN_LIMIT = 3;

function StackedCoinLogos({ coinIds, logos }: { coinIds: ReadonlyArray<string>; logos: Record<string, string> }) {
  // Identity only: the cell's text names the coins and the remainder.
  return (
    <span className="inline-flex items-center" aria-hidden="true">
      {coinIds.slice(0, NAMED_COIN_LIMIT).map((coinId, idx) => (
        <span key={coinId} className={idx === 0 ? "" : "-ml-1.5"}>
          <StablecoinLogo src={getLogoSrc(logos, coinId)} name={coinId} size={18} />
        </span>
      ))}
    </span>
  );
}

function namedCoins(coinIds: ReadonlyArray<string>): string {
  const named = coinIds.slice(0, NAMED_COIN_LIMIT).map((id) => CLIENT_TRACKED_META_BY_ID.get(id)?.symbol ?? id);
  const rest = coinIds.length - named.length;
  return rest > 0 ? `${named.join(", ")} +${rest}` : named.join(", ");
}

function consolidatedDewsTitle(event: TapeEvent): string | null {
  const prev = event.payload?.prevBand;
  const next = event.payload?.newBand;
  if (typeof prev !== "string" || typeof next !== "string") return null;
  return `DEWS ${prev} → ${next}`;
}

const EMPTY_EVENTS: ReadonlyArray<TapeEvent> = [];
type HomepageTapePlacement = "inline" | "top";

// The "top" chrome strip leads with the live active-depeg count, or with these
// registry counts (replacing the retired masthead) while that lane has no data,
// then the live events ticker flows to the right. Each count names its universe in a hover tooltip so the bare numbers are not
// read as one census. Coin-set universes take the shared vocabulary; pegs and
// chains are not coin sets, so they define themselves here.
const TAPE_STATS: ReadonlyArray<{ label: string; value: number; definition: string }> = [
  { label: UNIVERSES.core.label, value: CORE_AGGREGATE_STABLECOIN_COUNT, definition: UNIVERSES.core.definition },
  { label: UNIVERSES.variants.label, value: ACTIVE_VARIANT_STABLECOIN_COUNT, definition: UNIVERSES.variants.definition },
  {
    label: "Pegs",
    value: ACTIVE_PEG_CURRENCY_COUNT,
    definition: "Distinct peg currencies across active tracked assets.",
  },
  {
    label: "Chains",
    value: Object.keys(CHAIN_META).length,
    definition: "Chains in the Pharos chain registry.",
  },
];

const STAT_CHIP_CLASS = "inline-flex h-6 cursor-help items-center gap-1 px-1 text-xs text-muted-foreground";

function TapeStatChip({ label, value, definition }: { label: string; value: number; definition: string }) {
  return (
    <span className={STAT_CHIP_CLASS} title={`${label} (${value}): ${definition}`}>
      <span>{label}</span>
      <span className="pharos-numeric font-semibold text-foreground/90">{value}</span>
    </span>
  );
}

// `min-h-10` keeps the strip's box identical across the loading text state
// and the populated track. Without it, events resolving (~loading→loaded) grows
// the strip and pushes the whole page — including the hero LCP element —
// down, which Lighthouse attributes as the top homepage layout shift.
// `CoreTopRail` reserves the same height before hydration.
const TAPE_SHELL_CLASS: Record<HomepageTapePlacement, string> = {
  inline: "pharos-tape-shell relative -mx-3 min-h-10 overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4",
  top: "pharos-tape-shell relative min-h-10 w-full overflow-hidden border-b border-border/70 bg-card dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))]",
};

// Edge fade on the scrolling viewport so items enter and leave softly instead
// of clipping mid-word against a hard edge, whatever the strip background.
const TAPE_VIEWPORT_CLASS =
  "relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-3rem),transparent)] motion-reduce:overflow-x-auto";

function resolveEventLogoId(event: TapeEvent, logos: Record<string, string>): string | null {
  if (event.coinId) return event.coinId;
  // Freeze rows from the blacklist projector ship without `coinId` but carry
  // the symbol in `payload.stablecoin`. Map to the canonical `<ticker>-<issuer>`
  // logo key so the strip still renders the issuer's coin logo.
  const rawSym = event.payload?.stablecoin;
  if (typeof rawSym !== "string" || rawSym.length === 0) return null;
  const target = rawSym.toLowerCase();
  for (const key of Object.keys(logos)) {
    const dashIdx = key.indexOf("-");
    if (dashIdx > 0 && key.slice(0, dashIdx) === target) return key;
  }
  return null;
}

function resolveEventHref(event: TapeEvent): string {
  return event.sourceUrl ?? `/timeline/?event=${encodeURIComponent(event.id)}`;
}

function TapeItem({ entry, logoSrc, logoName, logos, nowMs }: TapeItemProps) {
  const { event, count, coinIds } = entry;
  const consolidated = coinIds && coinIds.length > 1;
  const title = consolidated ? (consolidatedDewsTitle(event) ?? formatTapeEventTitle(event)) : formatTapeEventTitle(event);

  return (
    <Link
      prefetch={false}
      href={resolveEventHref(event)}
      className="pharos-focus-ring group inline-flex items-center gap-1.5 rounded-md px-2 py-1 whitespace-nowrap text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
    >
      {/* Severity is a channel on every cell, beside the logo, never instead of it. */}
      <span
        role="img"
        aria-label={SEVERITY_LABEL[event.severity]}
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
      />
      {consolidated ? (
        <StackedCoinLogos coinIds={coinIds} logos={logos} />
      ) : logoName ? (
        <StablecoinLogo src={logoSrc} name={logoName} size={18} />
      ) : null}
      <span className="text-foreground/80 group-hover:text-foreground">{title}</span>
      {consolidated ? <span className="text-foreground/80">{namedCoins(coinIds)}</span> : null}
      {!consolidated && count > 1 ? (
        <span
          aria-label={`${count} similar events`}
          className="rounded-sm border border-border/60 px-1 text-[10px] font-medium tabular-nums text-muted-foreground"
        >
          ×{count}
        </span>
      ) : null}
      <span className="tabular-nums text-muted-foreground/80">
        {formatRelativeTimeMs(event.ts, { now: nowMs || undefined })}
      </span>
    </Link>
  );
}

function TapeTerminator() {
  return (
    <Link
      prefetch={false}
      href="/timeline/"
      className="pharos-focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap text-xs text-muted-foreground hover:text-foreground"
    >
      <span>View all events</span>
      <ChevronRight aria-hidden="true" className="h-3 w-3" />
    </Link>
  );
}

export function HomepageTape({ placement = "inline" }: { placement?: HomepageTapePlacement }) {
  // `severityFloor: "notice"` drops routine info-tier bookkeeping (issuer
  // freeze.unblocked actions) so the strip stays signal-rich. The collapse
  // pass below then merges flapping coins (e.g. USDXL repeating depeg cycles)
  // into a single cell with a count badge.
  const { data, isLoading, error } = useLatestEvents({ limit: 100, severityFloor: "notice" });
  // Live market state for the pinned slot: the compact snapshot's incidents
  // lane, the /depeg/ census; the static registry counts only while it is unavailable.
  const activeDepegCount = useHomepageSnapshot().data?.incidents.data?.activeDepegCount ?? null;
  // The hourly poll cannot refresh a relative age; a minute clock does.
  const nowSec = useMinuteClockSec();
  const nowMs = nowSec * 1000;
  const logos = logosById;
  const events = data?.events ?? EMPTY_EVENTS;
  const collapsed = useMemo(
    () => collapseForHomepageStrip(projectTapeEventsForReader(events).filter((event) => eventClassSlug(event.type) !== "score"), nowMs),
    [events, nowMs],
  );
  const duplicated = useMemo(() => collapsed.concat(collapsed), [collapsed]);

  if (error || (!isLoading && collapsed.length === 0)) {
    return null;
  }

  return (
    <section
      aria-label="Recent events tape"
      className={TAPE_SHELL_CLASS[placement]}
      style={{
        ["--pharos-tape-duration" as string]: durationFromCount(collapsed.length),
        ["--pharos-tape-delay" as string]: placement === "top" ? "6s" : "0s",
      }}
    >
      <div className="relative flex flex-col items-stretch sm:flex-row">
        {placement === "top" ? (
          // Desktop-only: on phones the counts cost a second chrome row, so the
          // strip stays a single ticker line there.
          <div className="sticky left-0 z-10 hidden shrink-0 items-center gap-1.5 border-r border-border/60 bg-card px-3 py-1.5 whitespace-nowrap dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))] sm:flex">
            {activeDepegCount !== null ? (
              <Link
                prefetch={false}
                href="/depeg/"
                className="pharos-focus-ring inline-flex h-6 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <span className="pharos-numeric font-semibold text-foreground/90">{activeDepegCount}</span>{" "}
                <span>active {activeDepegCount === 1 ? "depeg" : "depegs"}</span>
              </Link>
            ) : (
              TAPE_STATS.map((stat) => <TapeStatChip key={stat.label} {...stat} />)
            )}
          </div>
        ) : (
          <div className="pointer-events-none sticky left-0 z-10 hidden shrink-0 items-center gap-2 border-r border-border/60 bg-card px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:flex">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse"
              aria-hidden="true"
            />
            Events
          </div>
        )}
        <div className={TAPE_VIEWPORT_CLASS}>
          {isLoading ? (
            <div className="flex items-center px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              Loading recent events…
            </div>
          ) : (
            <div
              className={
                placement === "top"
                  ? "pharos-tape-track flex w-max items-center gap-2 py-1.5 pr-3 pl-6"
                  : "pharos-tape-track flex w-max items-center gap-2 px-3 py-1.5"
              }
              aria-live="off"
            >
              {duplicated.map((entry, idx) => {
                const logoId = resolveEventLogoId(entry.event, logos);
                return (
                  <TapeItem
                    key={`${entry.key}-${idx}`}
                    entry={entry}
                    logoSrc={logoId ? getLogoSrc(logos, logoId) : undefined}
                    logoName={logoId}
                    logos={logos}
                    nowMs={nowMs}
                  />
                );
              })}
              <TapeTerminator />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
