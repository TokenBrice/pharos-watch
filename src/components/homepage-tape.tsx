"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { logosById } from "@/lib/logos";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { collapseForHomepageStrip, eventClassSlug, type CollapsedTapeEntry } from "@/lib/tape-collapse";
import { formatRelativeTimeMs } from "@shared/lib/relative-time";
import { CHAIN_META } from "@shared/lib/chains";
import {
  ACTIVE_PEG_CURRENCY_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";
import { SEVERITY_DOT_CLASS, SEVERITY_LABEL } from "@shared/types/tape-event-constants";
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
}

const STACKED_LOGO_LIMIT = 4;

function StackedCoinLogos({ coinIds, logos }: { coinIds: ReadonlyArray<string>; logos: Record<string, string> }) {
  const visible = coinIds.slice(0, STACKED_LOGO_LIMIT);
  const overflow = coinIds.length - visible.length;
  return (
    <span className="inline-flex items-center" aria-label={`${coinIds.length} coins`}>
      {visible.map((coinId, idx) => (
        <span key={coinId} className={idx === 0 ? "" : "-ml-2"}>
          <StablecoinLogo src={logos[coinId]} name={coinId} size={22} />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="-ml-2 inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border border-border/60 bg-background/80 px-1 text-[10px] font-semibold tabular-nums text-foreground/80">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

function consolidatedDewsTitle(event: TapeEvent): string | null {
  const prev = event.payload?.prevBand;
  const next = event.payload?.newBand;
  if (typeof prev !== "string" || typeof next !== "string") return null;
  return `DEWS ${prev} → ${next}`;
}

const EMPTY_EVENTS: ReadonlyArray<TapeEvent> = [];
type HomepageTapePlacement = "inline" | "top";

// The "top" chrome strip leads with the global registry counts (replacing the
// retired masthead), then the live events ticker flows to the right.
const TAPE_STATS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "Core", value: CORE_AGGREGATE_STABLECOIN_COUNT },
  { label: "Variants", value: ACTIVE_VARIANT_STABLECOIN_COUNT },
  { label: "Pegs", value: ACTIVE_PEG_CURRENCY_COUNT },
  { label: "Chains", value: Object.keys(CHAIN_META).length },
];

const STAT_CHIP_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md border border-border/35 bg-background/20 px-2 text-xs text-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/0.025)]";

function TapeStatChip({ label, value }: { label: string; value: number }) {
  return (
    <span className={STAT_CHIP_CLASS}>
      <span>{label}</span>
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-muted-foreground/35" />
      <span className="pharos-numeric font-semibold text-foreground">{value}</span>
    </span>
  );
}

// `min-h-[46px]` keeps the strip's box identical across the loading text state
// and the populated track. Without it, events resolving (~loading→loaded) grows
// the strip ~13px and pushes the whole page — including the hero LCP element —
// down, which Lighthouse attributes as the top homepage layout shift.
const TAPE_SHELL_CLASS: Record<HomepageTapePlacement, string> = {
  inline: "pharos-tape-shell relative -mx-3 min-h-[46px] overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4",
  // Opaque bg: the band is sticky on desktop, and a translucent card without a
  // backdrop blur lets scrolled content ghost through the strip.
  top: "pharos-tape-shell relative z-50 min-h-[46px] w-full overflow-hidden border-b border-border/70 bg-card dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))]",
};

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

function TapeItem({ entry, logoSrc, logoName, logos }: TapeItemProps) {
  const { event, count, coinIds } = entry;
  const consolidated = coinIds && coinIds.length > 1;
  const title = consolidated ? (consolidatedDewsTitle(event) ?? event.title) : event.title;
  const badgeValue = consolidated ? coinIds.length : count;

  return (
    <Link
      prefetch={false}
      href={resolveEventHref(event)}
      className="pharos-focus-ring inline-flex items-center gap-2 rounded-md border border-border/50 bg-card/50 px-2 py-1 whitespace-nowrap text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
    >
      {consolidated ? (
        <StackedCoinLogos coinIds={coinIds} logos={logos} />
      ) : logoName ? (
        <StablecoinLogo src={logoSrc} name={logoName} size={22} />
      ) : (
        <span
          aria-label={SEVERITY_LABEL[event.severity]}
          className={`inline-block h-2 w-2 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
        />
      )}
      <span className="text-foreground">{title}</span>
      {badgeValue > 1 ? (
        <span
          aria-label={consolidated ? `${badgeValue} coins` : `${badgeValue} similar events`}
          className="rounded-sm border border-border/60 px-1 text-[10px] font-medium tabular-nums text-foreground/80"
        >
          ×{badgeValue}
        </span>
      ) : null}
      <span className="text-xs tabular-nums text-muted-foreground">{formatRelativeTimeMs(event.ts)}</span>
    </Link>
  );
}

function TapeTerminator() {
  return (
    <Link
      prefetch={false}
      href="/timeline/"
      className="pharos-focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap text-sm text-muted-foreground hover:text-foreground"
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
  const logos = logosById;
  const events = data?.events ?? EMPTY_EVENTS;
  const collapsed = useMemo(
    () => collapseForHomepageStrip(events.filter((event) => eventClassSlug(event.type) !== "score")),
    [events],
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
          <div className="sticky left-0 z-10 hidden shrink-0 items-center gap-2 border-r border-border/60 bg-card px-3 py-2 whitespace-nowrap dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))] sm:flex">
            {TAPE_STATS.map((stat) => (
              <TapeStatChip key={stat.label} label={stat.label} value={stat.value} />
            ))}
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
        <div className="relative min-w-0 flex-1 overflow-hidden">
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
                    logoSrc={logoId ? logos[logoId] : undefined}
                    logoName={logoId}
                    logos={logos}
                  />
                );
              })}
              <TapeTerminator />
            </div>
          )}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent"
          />
        </div>
        {placement === "top" ? (
          <div className="flex items-center gap-2 overflow-x-auto border-t border-border/60 bg-card px-3 py-2 whitespace-nowrap dark:bg-[color:color-mix(in_oklab,var(--background)_30%,var(--card))] sm:hidden">
            {TAPE_STATS.map((stat) => (
              <TapeStatChip key={stat.label} label={stat.label} value={stat.value} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
