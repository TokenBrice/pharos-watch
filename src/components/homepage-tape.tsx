"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useRecentEvents } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { COMMAND_PALETTE_STABLECOINS } from "@/lib/command-palette-search-data";
import type { RecentEvent, RecentEventSeverity } from "@shared/types/tape";

const SEVERITY_DOT_CLASS: Record<RecentEventSeverity, string> = {
  info: "bg-emerald-500",
  notice: "bg-sky-500",
  warning: "bg-amber-500",
  severe: "bg-orange-500",
  critical: "bg-red-500",
};

const SEVERITY_LABEL: Record<RecentEventSeverity, string> = {
  info: "Info",
  notice: "Notice",
  warning: "Warning",
  severe: "Severe",
  critical: "Critical",
};

// Per-event-type background tint. Hues are picked to be distinct from the
// severity ramp (emerald/sky/amber/orange/red) so type and severity stay
// readable independently. Tailwind classes are static strings as required.
const EVENT_TYPE_BG: Record<RecentEvent["type"], string> = {
  "depeg.opened": "bg-rose-500/10",
  "depeg.resolved": "bg-rose-500/10",
  "freeze.blocked": "bg-cyan-500/10",
  "freeze.unblocked": "bg-cyan-500/10",
  "freeze.destroyed": "bg-cyan-500/10",
  "score.upgraded": "bg-indigo-500/10",
  "score.downgraded": "bg-indigo-500/10",
  "score.regrade.bulk": "bg-violet-500/10",
};

function eventTypeBg(type: RecentEvent["type"]): string {
  return EVENT_TYPE_BG[type] ?? "";
}

function formatRelativeTime(tsSec: number): string {
  const ageSec = Math.max(1, Math.floor(Date.now() / 1000) - tsSec);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}

function durationFromCount(count: number): string {
  // ~4.5 seconds per item — slow news ticker pace
  const seconds = Math.max(45, count * 4.5);
  return `${Math.round(seconds)}s`;
}

interface TapeItemProps {
  event: RecentEvent;
  logoSrc: string | undefined;
}

const EMPTY_EVENTS: ReadonlyArray<RecentEvent> = [];
type HomepageTapePlacement = "inline" | "top";

const TAPE_SHELL_CLASS: Record<HomepageTapePlacement, string> = {
  inline: "pharos-tape-shell relative -mx-3 overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4",
  top: "pharos-tape-shell relative z-50 w-full overflow-hidden border-b border-border/70 bg-card/95 shadow-[0_1px_0_oklch(1_0_0_/0.04)] supports-[backdrop-filter]:bg-card/85 md:ml-[var(--pharos-homepage-tape-offset)] md:w-[calc(100%-var(--pharos-homepage-tape-offset))]",
};

function buildUniqueActiveIdBySymbol(): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const ids = new Map<string, string>();

  for (const coin of COMMAND_PALETTE_STABLECOINS) {
    const [id, , rawSymbol] = coin;
    const symbol = rawSymbol.toUpperCase();
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    ids.set(symbol, id);
  }

  return new Map([...ids].filter(([symbol]) => counts.get(symbol) === 1));
}

const UNIQUE_ACTIVE_ID_BY_SYMBOL = buildUniqueActiveIdBySymbol();

function resolveEventLogoId(event: RecentEvent): string | null {
  if (event.stablecoinId) return event.stablecoinId;
  if (!event.symbol) return null;
  return UNIQUE_ACTIVE_ID_BY_SYMBOL.get(event.symbol.toUpperCase()) ?? null;
}

function TapeItem({ event, logoSrc }: TapeItemProps) {
  const logoName = event.symbol ?? event.title;
  const bgClass = eventTypeBg(event.type);

  return (
    <Link
      href={event.href}
      className={`pharos-focus-ring inline-flex items-center gap-2 rounded-md px-2 py-1 whitespace-nowrap text-sm hover:text-foreground ${bgClass}`}
    >
      {event.symbol ? (
        <StablecoinLogo src={logoSrc} name={logoName} size={22} />
      ) : (
        <span
          aria-label={SEVERITY_LABEL[event.severity]}
          className={`inline-block h-2 w-2 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
        />
      )}
      <span className="text-foreground">{event.title}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{formatRelativeTime(event.ts)}</span>
    </Link>
  );
}

function TapeTerminator() {
  return (
    <Link
      href="/tape/"
      className="pharos-focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 whitespace-nowrap text-sm text-muted-foreground hover:text-foreground"
    >
      <span>View all events</span>
      <ChevronRight aria-hidden="true" className="h-3 w-3" />
    </Link>
  );
}

export function HomepageTape({ placement = "inline" }: { placement?: HomepageTapePlacement }) {
  const { data, isLoading, error } = useRecentEvents(20);
  const { data: logos } = useLogos();
  const events = data?.events ?? EMPTY_EVENTS;
  const duplicated = useMemo(() => events.concat(events), [events]);

  if (error || (!isLoading && events.length === 0)) {
    return null;
  }

  return (
    <section
      aria-label="Recent events tape"
      className={TAPE_SHELL_CLASS[placement]}
      style={{ ["--pharos-tape-duration" as string]: durationFromCount(events.length) }}
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
              {duplicated.map((event, idx) => (
                <TapeItem
                  key={`${event.id}-${idx}`}
                  event={event}
                  logoSrc={logos[resolveEventLogoId(event) ?? ""]}
                />
              ))}
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
