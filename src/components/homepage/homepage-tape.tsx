"use client";

import Link from "next/link";
import { Fragment, useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { useHomepageSnapshot, usePegSummary } from "@/hooks/api-hooks";
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
import { SEVERITY_RANK } from "@shared/types/tape-event-constants";
import type { TapeEvent } from "@shared/types/tape-event";

function durationFromCount(count: number): string {
  // ~4.5 seconds per item; slow news ticker pace.
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
  /** Cloned marquee half stays out of keyboard tab order and assistive tech. */
  isClone?: boolean;
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

function isStressAlertEntry(entry: CollapsedTapeEntry): boolean {
  const cls = eventClassSlug(entry.event.type);
  return cls === "dews" || cls === "depeg" || SEVERITY_RANK[entry.event.severity] >= SEVERITY_RANK.warning;
}

const EMPTY_EVENTS: ReadonlyArray<TapeEvent> = [];
type HomepageTapePlacement = "inline" | "top";

// The "top" chrome strip leads with the live active-depeg count, or with these
// registry counts (replacing the retired masthead) while that lane has no data,
// then the live events ticker flows to the right. Each count names its universe
// in a hover tooltip so the bare numbers are not read as one census.
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

// `min-h-10` keeps the strip's box identical across loading and populated states.
const TAPE_SHELL_CLASS: Record<HomepageTapePlacement, string> = {
  inline: "pharos-tape-shell relative -mx-3 min-h-10 overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4",
  top: "pharos-tape-shell relative min-h-10 w-full overflow-hidden border-b border-border/70 bg-card dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))]",
};

// Apply edge fade only to the scrolling track so the static loading text never fades at the left edge.
const TAPE_VIEWPORT_SCROLL_CLASS =
  "relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.5rem),transparent)] motion-reduce:overflow-x-auto motion-reduce:[mask-image:none]";
const TAPE_VIEWPORT_LOADING_CLASS = "relative min-w-0 flex-1 overflow-hidden";

function resolveEventLogoId(event: TapeEvent, logos: Record<string, string>): string | null {
  if (event.coinId) return event.coinId;
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

function TapeItem({ entry, logoSrc, logoName, logos, nowMs, isClone = false }: TapeItemProps) {
  const { event, count, coinIds } = entry;
  const consolidated = coinIds && coinIds.length > 1;
  const title = consolidated ? (consolidatedDewsTitle(event) ?? formatTapeEventTitle(event)) : formatTapeEventTitle(event);
  const stressAlert = isStressAlertEntry(entry);

  return (
    <Link
      prefetch={false}
      href={resolveEventHref(event)}
      tabIndex={isClone ? -1 : undefined}
      aria-hidden={isClone ? true : undefined}
      className={
        stressAlert
          ? "pharos-focus-ring group inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/45 px-2 py-1 whitespace-nowrap text-xs font-medium text-foreground hover:border-border hover:bg-muted/70"
          : "pharos-focus-ring group inline-flex items-center gap-1.5 rounded-md px-2 py-1 whitespace-nowrap text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      }
    >
      {/* Severity is a channel on every cell, beside the logo, never instead of it. */}
      <span
        role={isClone ? undefined : "img"}
        aria-label={isClone ? undefined : SEVERITY_LABEL[event.severity]}
        aria-hidden={isClone ? true : undefined}
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
      />
      {consolidated ? (
        <StackedCoinLogos coinIds={coinIds} logos={logos} />
      ) : logoName ? (
        <span aria-hidden={isClone ? true : undefined}>
          <StablecoinLogo src={logoSrc} name={logoName} size={18} />
        </span>
      ) : null}
      <span className={stressAlert ? "text-foreground" : "text-foreground/80 group-hover:text-foreground"}>{title}</span>
      {consolidated ? <span className="text-foreground/85">{namedCoins(coinIds)}</span> : null}
      {!consolidated && count > 1 ? (
        <span
          aria-label={isClone ? undefined : `${count} similar events`}
          className="rounded-sm border border-border/60 px-1 text-3xs font-medium tabular-nums text-muted-foreground"
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

function TapeSequence({
  entries,
  logos,
  nowMs,
  isClone = false,
}: {
  entries: ReadonlyArray<CollapsedTapeEntry>;
  logos: Record<string, string>;
  nowMs: number;
  isClone?: boolean;
}) {
  return (
    <div
      aria-hidden={isClone ? true : undefined}
      className={
        isClone
          ? "inline-flex shrink-0 items-center gap-2 pr-2 motion-reduce:hidden"
          : "inline-flex shrink-0 items-center gap-2 pr-2"
      }
    >
      {entries.map((entry, idx) => {
        const logoId = resolveEventLogoId(entry.event, logos);
        const prevEntry = idx > 0 ? entries[idx - 1] : null;
        const showAlertBoundary = prevEntry !== null && isStressAlertEntry(prevEntry) && !isStressAlertEntry(entry);
        return (
          <Fragment key={`${entry.key}-${isClone ? "clone" : "primary"}-${idx}`}>
            {showAlertBoundary ? (
              <span aria-hidden="true" className="mx-1 h-3.5 w-px shrink-0 bg-border/80" />
            ) : null}
            <TapeItem
              entry={entry}
              logoSrc={logoId ? getLogoSrc(logos, logoId) : undefined}
              logoName={logoId}
              logos={logos}
              nowMs={nowMs}
              isClone={isClone}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

function PinnedAllEventsLink({ placement }: { placement: HomepageTapePlacement }) {
  return (
    <div
      className={
        placement === "top"
          ? "z-10 flex shrink-0 items-center border-l border-border/60 bg-card px-2.5 py-1.5 dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))]"
          : "z-10 flex shrink-0 items-center border-l border-border/60 bg-card/90 px-2.5 py-1.5"
      }
    >
      <Link
        prefetch={false}
        href="/timeline/"
        aria-label="View all events"
        className="pharos-focus-ring inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 py-0.5 whitespace-nowrap text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <span>All events</span>
        <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" />
      </Link>
    </div>
  );
}

export function HomepageTape({ placement = "inline" }: { placement?: HomepageTapePlacement }) {
  const { data, isLoading, error } = useLatestEvents({ limit: 100, severityFloor: "notice" });
  const snapshotActiveDepegCount = useHomepageSnapshot().data?.incidents.data?.activeDepegCount ?? null;
  // Passive cache fallback: if another mounted surface already fetched peg-summary, reuse its count.
  const pegFallbackCount = usePegSummary({ enabled: false }).data?.summary?.activeDepegCount ?? null;
  const activeDepegCount = snapshotActiveDepegCount ?? pegFallbackCount;
  const nowSec = useMinuteClockSec();
  const nowMs = nowSec * 1000;
  const logos = logosById;
  const events = data?.events ?? EMPTY_EVENTS;
  const collapsed = useMemo(
    () => collapseForHomepageStrip(projectTapeEventsForReader(events).filter((event) => eventClassSlug(event.type) !== "score"), nowMs),
    [events, nowMs],
  );

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
      <div className="relative flex items-stretch">
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
          <div className="pointer-events-none sticky left-0 z-10 hidden shrink-0 items-center gap-2 border-r border-border/60 bg-card px-3 py-2 text-3xs font-semibold uppercase tracking-eyebrow text-muted-foreground sm:flex">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-state-positive-solid motion-safe:animate-pulse"
              aria-hidden="true"
            />
            Events
          </div>
        )}
        <div className={isLoading ? TAPE_VIEWPORT_LOADING_CLASS : TAPE_VIEWPORT_SCROLL_CLASS}>
          {isLoading ? (
            <div className="flex items-center px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              Loading recent events…
            </div>
          ) : (
            <div
              className={
                placement === "top"
                  ? "pharos-tape-track flex w-max items-center py-1.5 pl-4"
                  : "pharos-tape-track flex w-max items-center py-1.5 pl-3"
              }
              aria-live="off"
            >
              <TapeSequence entries={collapsed} logos={logos} nowMs={nowMs} />
              <TapeSequence entries={collapsed} logos={logos} nowMs={nowMs} isClone />
            </div>
          )}
        </div>
        <PinnedAllEventsLink placement={placement} />
      </div>
    </section>
  );
}
