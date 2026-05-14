"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useBlacklistEventsPage } from "@/hooks/use-blacklist-events";
import { useInfiniteDepegEvents } from "@/hooks/use-depeg-events";
import type { BlacklistEvent, DepegEvent } from "@shared/types";
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

function formatRelativeTime(tsSec: number): string {
  const ageSec = Math.max(1, Math.floor(Date.now() / 1000) - tsSec);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}

function formatUsdShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function formatSignedBps(event: DepegEvent): string {
  const magnitude = Math.abs(event.peakDeviationBps);
  const sign = event.peakDeviationBps < 0 || event.direction === "below" ? "−" : "+";
  return `${sign}${magnitude} bps`;
}

function depegOpenedSeverity(bps: number): RecentEventSeverity {
  const absBps = Math.abs(bps);
  if (absBps >= 2500) return "critical";
  if (absBps >= 1000) return "severe";
  if (absBps >= 300) return "warning";
  return "notice";
}

function freezeSeverity(eventType: BlacklistEvent["eventType"], amountUsd: number | null): RecentEventSeverity {
  if (eventType === "unblacklist") return "info";
  if (eventType === "destroy") {
    if ((amountUsd ?? 0) >= 100_000_000) return "critical";
    if ((amountUsd ?? 0) >= 10_000_000) return "severe";
    return "warning";
  }
  if ((amountUsd ?? 0) >= 10_000_000) return "severe";
  if ((amountUsd ?? 0) >= 1_000_000) return "warning";
  return "notice";
}

function mapDepegEvent(event: DepegEvent): RecentEvent | null {
  if (event.source !== "live") return null;
  if (event.endedAt == null) {
    return {
      id: `depeg.opened:${event.id}`,
      type: "depeg.opened",
      severity: depegOpenedSeverity(event.peakDeviationBps),
      ts: event.startedAt,
      stablecoinId: event.stablecoinId,
      symbol: event.symbol,
      title: `${event.symbol} depeg opened (${formatSignedBps(event)})`,
      href: `/stablecoin/${encodeURIComponent(event.stablecoinId)}/#peg-history`,
    };
  }

  return {
    id: `depeg.resolved:${event.id}`,
    type: "depeg.resolved",
    severity: "info",
    ts: event.endedAt,
    stablecoinId: event.stablecoinId,
    symbol: event.symbol,
    title: `${event.symbol} depeg resolved (lasted ${formatDuration(event.endedAt - event.startedAt)})`,
    href: `/stablecoin/${encodeURIComponent(event.stablecoinId)}/#peg-history`,
  };
}

function mapFreezeEvent(event: BlacklistEvent): RecentEvent {
  const amount = event.amountUsdAtEvent != null && event.amountUsdAtEvent > 0
    ? formatUsdShort(event.amountUsdAtEvent)
    : null;
  if (event.eventType === "destroy") {
    return {
      id: `freeze.destroyed:${event.id}`,
      type: "freeze.destroyed",
      severity: freezeSeverity("destroy", event.amountUsdAtEvent),
      ts: event.timestamp,
      stablecoinId: null,
      symbol: event.stablecoin,
      title: amount
        ? `${event.stablecoin} ${amount} destroyed · ${event.chainName}`
        : `${event.stablecoin} funds destroyed · ${event.chainName}`,
      href: "/freezewatch/",
    };
  }
  if (event.eventType === "unblacklist") {
    return {
      id: `freeze.unblocked:${event.id}`,
      type: "freeze.unblocked",
      severity: "info",
      ts: event.timestamp,
      stablecoinId: null,
      symbol: event.stablecoin,
      title: `${event.stablecoin} address unfrozen · ${event.chainName}`,
      href: "/freezewatch/",
    };
  }
  return {
    id: `freeze.blocked:${event.id}`,
    type: "freeze.blocked",
    severity: freezeSeverity("blacklist", event.amountUsdAtEvent),
    ts: event.timestamp,
    stablecoinId: null,
    symbol: event.stablecoin,
    title: amount
      ? `${event.stablecoin} freeze ${amount} · ${event.chainName}`
      : `${event.stablecoin} address frozen · ${event.chainName}`,
    href: "/freezewatch/",
  };
}

function durationFromCount(count: number): string {
  // ~4.5 seconds per item — slow news ticker pace
  const seconds = Math.max(45, count * 4.5);
  return `${Math.round(seconds)}s`;
}

interface TapeItemProps {
  event: RecentEvent;
  prefixDivider: boolean;
}

function TapeItem({ event, prefixDivider }: TapeItemProps) {
  return (
    <>
      {prefixDivider && (
        <span aria-hidden="true" className="select-none text-border">|</span>
      )}
      <Link
        href={event.href}
        className="pharos-focus-ring inline-flex items-center gap-2 rounded-sm whitespace-nowrap text-sm hover:text-foreground"
      >
        <span
          aria-label={SEVERITY_LABEL[event.severity]}
          className={`inline-block h-2 w-2 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
        />
        <span className="text-foreground">{event.title}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{formatRelativeTime(event.ts)}</span>
      </Link>
    </>
  );
}

export function HomepageTape() {
  const depegs = useInfiniteDepegEvents({ includePending: false });
  const freezes = useBlacklistEventsPage({ limit: 20, sortBy: "date", sortDirection: "desc" });

  const events = useMemo(() => {
    const depegEvents = depegs.data.events
      .map(mapDepegEvent)
      .filter((event): event is RecentEvent => event != null);
    const freezeEvents = (freezes.data?.events ?? []).map(mapFreezeEvent);
    return [...depegEvents, ...freezeEvents]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20);
  }, [depegs.data.events, freezes.data?.events]);

  const duplicated = useMemo(() => events.concat(events), [events]);
  const isLoading = (depegs.isLoading || freezes.isLoading) && events.length === 0;
  const hasLoaded = !depegs.isLoading && !freezes.isLoading;
  const hasAnySuccess = depegs.isSuccess || freezes.isSuccess;

  if (
    (!isLoading && events.length === 0 && (hasLoaded || hasAnySuccess))
    || (!hasAnySuccess && depegs.error && freezes.error)
  ) {
    return null;
  }

  return (
    <section
      aria-label="Recent events tape"
      className="pharos-tape-shell relative -mx-3 overflow-hidden border-y border-border/60 bg-card/40 sm:-mx-4"
      style={{ ["--pharos-tape-duration" as string]: durationFromCount(events.length) }}
    >
      <div className="relative flex items-stretch">
        <div className="pointer-events-none sticky left-0 z-10 hidden shrink-0 items-center gap-2 border-r border-border/60 bg-card px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:flex">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" aria-hidden="true" />
          Live Tape
        </div>
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex items-center px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              Loading recent events…
            </div>
          ) : (
            <div className="pharos-tape-track flex w-max items-center gap-4 px-3 py-2" aria-live="off">
              {duplicated.map((event, idx) => (
                <TapeItem
                  key={`${event.id}-${idx}`}
                  event={event}
                  prefixDivider={idx > 0}
                />
              ))}
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
