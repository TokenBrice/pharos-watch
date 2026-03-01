"use client";

import { GAUGE_BANDS } from "./flow-gauge";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowGaugeMiniProps {
  score: number | null;
  band: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FlowGaugeMini({ score, band }: FlowGaugeMiniProps) {
  if (score === null || band === null) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-sm text-muted-foreground">
        <span className="h-2 w-2 rounded-full bg-muted" />
        &mdash;
      </span>
    );
  }

  const config = GAUGE_BANDS[band];
  const dotClass = config?.bgClass ?? "bg-muted";
  const textClass = config?.textClass ?? "text-muted-foreground";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span className={`font-mono text-sm font-bold tabular-nums ${textClass}`}>
        {Math.round(score)}
      </span>
    </span>
  );
}

export type { FlowGaugeMiniProps };
