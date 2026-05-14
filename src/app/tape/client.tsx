"use client";

import Link from "next/link";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecentEvents } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
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

// Per-event-type background tint. Mirrors the homepage tape palette so that
// type recognition stays consistent across surfaces. Static class strings.
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
  return EVENT_TYPE_BG[type] ?? "bg-card/40";
}

function formatRelativeTime(tsSec: number): string {
  const ageSec = Math.max(1, Math.floor(Date.now() / 1000) - tsSec);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}

interface TapeEventRowProps {
  event: RecentEvent;
  logoSrc: string | undefined;
}

function TapeEventRow({ event, logoSrc }: TapeEventRowProps) {
  const bgClass = eventTypeBg(event.type);
  return (
    <Link
      href={event.href}
      className={`pharos-focus-ring group flex items-center gap-3 rounded-md border border-border/60 px-4 py-3 transition-colors hover:brightness-110 ${bgClass}`}
    >
      {event.symbol ? (
        <StablecoinLogo src={logoSrc} name={event.symbol} size={28} />
      ) : (
        <span
          aria-label={SEVERITY_LABEL[event.severity]}
          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_DOT_CLASS[event.severity]}`}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground group-hover:text-foreground">
        {event.title}
      </span>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatRelativeTime(event.ts)}</span>
    </Link>
  );
}

function TapeSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-md" />
      ))}
    </div>
  );
}

export function TapeClient() {
  const { data, isLoading, error } = useRecentEvents(50);
  const { data: logos } = useLogos();

  if (isLoading) return <TapeSkeleton />;
  if (error) return <QueryErrorNotice error={error} />;

  const events = data?.events ?? [];
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
        No events in the last 24h.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <TapeEventRow
          key={event.id}
          event={event}
          logoSrc={event.stablecoinId ? logos[event.stablecoinId] : undefined}
        />
      ))}
    </div>
  );
}
