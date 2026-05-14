"use client";

import Link from "next/link";
import {
  Activity,
  ArrowLeftRight,
  Award,
  BookOpen,
  Calendar,
  Coins,
  Flame,
  Lock,
  Radar,
  Rocket,
  Skull,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { severityToAccent } from "@/lib/severity-colors";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";

function eventClass(type: string): string {
  const dot = type.indexOf(".");
  return dot === -1 ? type : type.slice(0, dot);
}

interface ClassIconProps {
  type: string;
  className?: string;
}

// Per-class icon. Inline rather than via a registry so React doesn't see a
// component re-created on every render (eslint react-hooks/static-components).
function ClassIcon({ type, className = "h-4 w-4" }: ClassIconProps) {
  switch (eventClass(type)) {
    case "depeg":       return <TrendingDown className={className} aria-hidden="true" />;
    case "freeze":      return <Lock className={className} aria-hidden="true" />;
    case "redemption":  return <ArrowLeftRight className={className} aria-hidden="true" />;
    case "psi":         return <Activity className={className} aria-hidden="true" />;
    case "mint_burn":   return <Flame className={className} aria-hidden="true" />;
    case "reserve":     return <Wallet className={className} aria-hidden="true" />;
    case "methodology": return <BookOpen className={className} aria-hidden="true" />;
    case "cemetery":    return <Skull className={className} aria-hidden="true" />;
    case "score":       return <Award className={className} aria-hidden="true" />;
    case "dews":        return <Radar className={className} aria-hidden="true" />;
    case "liquidity":   return <Coins className={className} aria-hidden="true" />;
    case "lifecycle":   return <Rocket className={className} aria-hidden="true" />;
    default:            return <Calendar className={className} aria-hidden="true" />;
  }
}

const SEVERITY_LABEL: Record<TapeEventSeverity, string> = {
  info: "Info",
  notice: "Notice",
  warning: "Warning",
  severe: "Severe",
  critical: "Critical",
};

const SEVERITY_TEXT: Record<TapeEventSeverity, string> = {
  info: "text-emerald-700 dark:text-emerald-400",
  notice: "text-sky-700 dark:text-sky-400",
  warning: "text-amber-700 dark:text-amber-400",
  severe: "text-orange-700 dark:text-orange-400",
  critical: "text-red-700 dark:text-red-400",
};

const SEVERITY_BORDER: Record<TapeEventSeverity, string> = {
  info: "border-emerald-500/40",
  notice: "border-sky-500/40",
  warning: "border-amber-500/40",
  severe: "border-orange-500/40",
  critical: "border-red-500/40",
};

function formatRelativeTime(tsMs: number): string {
  const ageSec = Math.max(1, Math.floor((Date.now() - tsMs) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}

function formatAbsoluteDate(tsMs: number): string {
  return new Date(tsMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

interface EventCardProps {
  event: TapeEvent;
  /** Optional stablecoin logo lookup for `event.coinId`. */
  logoSrc?: string | undefined;
  /** Renders a focus ring + highlight when truthy. Used by `?event=` permalinks. */
  highlighted?: boolean;
  /** Optional id attribute for scroll-into-view targeting. */
  domId?: string;
}

export function EventCard({ event, logoSrc, highlighted = false, domId }: EventCardProps) {
  const accent = severityToAccent(event.severity);
  const severityLabel = SEVERITY_LABEL[event.severity];
  const severityText = SEVERITY_TEXT[event.severity];
  const severityBorder = SEVERITY_BORDER[event.severity];
  const href = event.sourceUrl ?? `/tape/?event=${encodeURIComponent(event.id)}`;
  const titleId = `tape-event-${event.id}`;

  return (
    <Link
      id={domId}
      href={href}
      aria-labelledby={titleId}
      data-event-id={event.id}
      className={`pharos-focus-ring group relative flex items-start gap-3 rounded-lg border border-border/60 border-l-4 bg-card/40 p-3 transition-colors hover:bg-accent/40 ${accent}${
        highlighted ? " ring-2 ring-primary/60 ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/60 text-muted-foreground">
        {event.coinId ? (
          <StablecoinLogo src={logoSrc} name={event.coinId} size={24} />
        ) : (
          <ClassIcon type={event.type} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span id={titleId} className="truncate text-sm font-medium text-foreground">
            {event.title}
          </span>
          <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${severityBorder} ${severityText}`}>
            {severityLabel}
          </Badge>
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <ClassIcon type={event.type} className="mr-1 h-3 w-3" />
            {event.type}
          </Badge>
          {event.chain ? (
            <span className="text-[11px] text-muted-foreground">{event.chain}</span>
          ) : null}
        </div>
        {event.summary ? (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{event.summary}</p>
        ) : null}
      </div>
      <time
        dateTime={new Date(event.ts).toISOString()}
        title={formatAbsoluteDate(event.ts)}
        className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
      >
        {formatRelativeTime(event.ts)}
      </time>
    </Link>
  );
}
