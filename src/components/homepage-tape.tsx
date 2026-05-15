"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useLatestEvents } from "@/hooks/use-events";
import { useLogos } from "@/hooks/use-logos";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  collapseByCoinClass,
  eventClassSlug,
  type CollapsedTapeEntry,
} from "@/lib/tape-collapse";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";

const SEVERITY_DOT_CLASS: Record<TapeEventSeverity, string> = {
  info: "bg-emerald-500",
  notice: "bg-sky-500",
  warning: "bg-amber-500",
  severe: "bg-orange-500",
  critical: "bg-red-500",
};

const SEVERITY_LABEL: Record<TapeEventSeverity, string> = {
  info: "Info",
  notice: "Notice",
  warning: "Warning",
  severe: "Severe",
  critical: "Critical",
};

// Per-class background tint. Hues are picked to be distinct from the severity
// ramp (emerald/sky/amber/orange/red) so type and severity stay readable
// independently. Tailwind classes are static strings as required.
const CLASS_BG: Record<string, string> = {
  depeg: "bg-rose-500/10",
  freeze: "bg-cyan-500/10",
  score: "bg-indigo-500/10",
  dews: "bg-fuchsia-500/10",
  psi: "bg-sky-500/10",
  mint_burn: "bg-orange-500/10",
  reserve: "bg-emerald-500/10",
  redemption: "bg-teal-500/10",
  yield: "bg-lime-500/10",
  liquidity: "bg-blue-500/10",
  methodology: "bg-violet-500/10",
  lifecycle: "bg-amber-500/10",
  cemetery: "bg-zinc-500/10",
};

function eventTypeClass(type: string): string {
  return CLASS_BG[eventClassSlug(type)] ?? "";
}

function formatRelativeTime(tsMs: number): string {
  const ageSec = Math.max(1, Math.floor((Date.now() - tsMs) / 1000));
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
  entry: CollapsedTapeEntry;
  logoSrc: string | undefined;
}

const EMPTY_EVENTS: ReadonlyArray<TapeEvent> = [];
type HomepageTapePlacement = "inline" | "top";

const TAPE_SHELL_CLASS: Record<HomepageTapePlacement, string> = {
  inline: "pharos-tape-shell relative -mx-3 overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4",
  top: "pharos-tape-shell relative z-50 w-full overflow-hidden border-b border-border/70 bg-card/95 shadow-[0_1px_0_oklch(1_0_0_/0.04)] supports-[backdrop-filter]:bg-card/85 md:ml-[var(--pharos-homepage-tape-offset)] md:w-[calc(100%-var(--pharos-homepage-tape-offset))]",
};

function resolveEventLogoId(event: TapeEvent): string | null {
  // Wire schema exposes a canonical `coinId`; symbol-only fallback is no
  // longer needed.
  return event.coinId ?? null;
}

function resolveEventHref(event: TapeEvent): string {
  return event.sourceUrl ?? `/tape/?event=${encodeURIComponent(event.id)}`;
}

function TapeItem({ entry, logoSrc }: TapeItemProps) {
  const { event, count } = entry;
  const bgClass = eventTypeClass(event.type);
  const logoName = event.coinId ?? event.title;

  return (
    <Link
      href={resolveEventHref(event)}
      className={`pharos-focus-ring inline-flex items-center gap-2 rounded-md px-2 py-1 whitespace-nowrap text-sm hover:text-foreground ${bgClass}`}
    >
      {event.coinId ? (
        <StablecoinLogo src={logoSrc} name={logoName} size={22} />
      ) : (
        <span
          aria-label={SEVERITY_LABEL[event.severity]}
          className={`inline-block h-2 w-2 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
        />
      )}
      <span className="text-foreground">{event.title}</span>
      {count > 1 ? (
        <span
          aria-label={`${count} similar events`}
          className="rounded-sm border border-border/60 px-1 text-[10px] font-medium tabular-nums text-foreground/80"
        >
          ×{count}
        </span>
      ) : null}
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
  // `severityFloor: "notice"` drops routine info-tier bookkeeping (issuer
  // freeze.unblocked actions) so the strip stays signal-rich. The collapse
  // pass below then merges flapping coins (e.g. USDXL repeating depeg cycles)
  // into a single cell with a count badge.
  const { data, isLoading, error } = useLatestEvents({ limit: 20, severityFloor: "notice" });
  const { data: logos } = useLogos();
  const events = data?.events ?? EMPTY_EVENTS;
  const collapsed = useMemo(() => collapseByCoinClass(events), [events]);
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
              {duplicated.map((entry, idx) => (
                <TapeItem
                  key={`${entry.key}-${idx}`}
                  entry={entry}
                  logoSrc={logos[resolveEventLogoId(entry.event) ?? ""]}
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

