import type { ReactNode } from "react";
import { PublicSignalCard } from "./public-signal-card";
import { SEVERITY_TONE_CLASS, type SeverityTone } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

/**
 * The chrome shared by the two request-attribution cards — "Site vs external
 * demand" and "API Key Load" (WS8.9). Both wrap `PublicSignalCard` with the
 * same window badge, the same headline share pills, and the same
 * error → loading → empty ladder before their own body.
 *
 * The panels keep their own bodies (and their own extra "nothing recorded in
 * this window" branch) — only the surrounding chrome is shared, so neither
 * card's content is constrained by the other's.
 */
export function AttributionWindowBadge({ hours }: { hours: number | null }) {
  if (hours == null) return null;
  return (
    <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {hours}h window
    </span>
  );
}

/** A headline share pill: `Site 62.4%`, `Keyed 18.0%`, or a muted counter. */
export function AttributionBadge({ tone, children }: { tone?: SeverityTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium",
        tone ? SEVERITY_TONE_CLASS[tone].pill : "border-border/60 bg-background/50 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function AttributionPanel({
  title,
  windowHours,
  description,
  badges,
  error,
  isLoading,
  hasData,
  loadingLabel,
  emptyLabel,
  children,
}: {
  title: string;
  windowHours: number | null;
  description: ReactNode;
  badges?: ReactNode;
  error?: string | null;
  isLoading?: boolean;
  /** False once the query settled with nothing to show. */
  hasData: boolean;
  loadingLabel: string;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <PublicSignalCard
      title={title}
      titleBadges={<AttributionWindowBadge hours={windowHours} />}
      description={description}
      badges={badges ? <div className="flex flex-wrap gap-2">{badges}</div> : null}
    >
      {error ? (
        <div className={cn("rounded-xl border px-3 py-2 text-sm", SEVERITY_TONE_CLASS.watch.pill)}>{error}</div>
      ) : isLoading && !hasData ? (
        <div className="text-sm text-muted-foreground">{loadingLabel}</div>
      ) : !hasData ? (
        <div className="text-sm text-muted-foreground">{emptyLabel}</div>
      ) : (
        children
      )}
    </PublicSignalCard>
  );
}
