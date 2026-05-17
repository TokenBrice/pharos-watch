"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { useLogos } from "@/hooks/use-logos";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  collapseForHomepageStrip,
  eventClassSlug,
  type CollapsedTapeEntry,
} from "@/lib/tape-collapse";
import { tapeClassChipBg } from "@/lib/tape-class-style";
import { formatRelativeTimeMs } from "@shared/lib/format";
import {
  SEVERITY_DOT_CLASS,
  SEVERITY_LABEL,
  type TapeEvent,
} from "@shared/types/tape-event";

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

function StackedCoinLogos({
  coinIds,
  logos,
}: {
  coinIds: ReadonlyArray<string>;
  logos: Record<string, string>;
}) {
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

const TAPE_SHELL_CLASS: Record<HomepageTapePlacement, string> = {
  inline: "pharos-tape-shell relative -mx-3 overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4",
  top: "pharos-tape-shell relative z-50 w-full overflow-hidden border-b border-border/70 bg-card/95 shadow-[0_1px_0_oklch(1_0_0_/0.04)] supports-[backdrop-filter]:bg-card/85 md:ml-[var(--pharos-homepage-tape-offset)] md:w-[calc(100%-var(--pharos-homepage-tape-offset))]",
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
  const bgClass = tapeClassChipBg(event.type);
  const consolidated = coinIds && coinIds.length > 1;
  const title = consolidated ? consolidatedDewsTitle(event) ?? event.title : event.title;
  const badgeValue = consolidated ? coinIds.length : count;

  return (
    <Link
      href={resolveEventHref(event)}
      className={`pharos-focus-ring inline-flex items-center gap-2 rounded-md px-2 py-1 whitespace-nowrap text-sm hover:text-foreground ${bgClass}`}
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
  const { data: logos } = useLogos();
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
      style={{ ["--pharos-tape-duration" as string]: durationFromCount(collapsed.length) }}
    >
      <div className="relative flex items-stretch">
        <div className="pointer-events-none sticky left-0 z-10 hidden shrink-0 items-center gap-2 border-r border-border/60 bg-card px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:flex">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" aria-hidden="true" />
          Events
        </div>
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex items-center px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              Loading recent events…
            </div>
          ) : (
            <div className="pharos-tape-track flex w-max items-center gap-2 px-3 py-1.5" aria-live="off">
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
      </div>
    </section>
  );
}

