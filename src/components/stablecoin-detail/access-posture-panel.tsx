"use client";

import { LockKeyhole } from "lucide-react";
import type { StablecoinSafetyScoreV9AccessRow } from "@/lib/stablecoin-safety-score-v9-presentation";

/**
 * The four scored access-posture enums. Lives in the summary rail at `xl+` and
 * inside the Safety Score card below `xl`, the same split `#price` uses, so the
 * rail's absence on narrow viewports does not lose the rows.
 *
 * Every rated asset publishes at least two of the four (253 of 336 publish all
 * four), so this is always-present content rather than an occasional block.
 */
export function AccessPosturePanel({
  rows,
  compact = false,
}: {
  rows: readonly StablecoinSafetyScoreV9AccessRow[];
  compact?: boolean;
}) {
  if (rows.length === 0) return null;

  const list = (
    <dl className="space-y-1">
      {rows.map((row) => (
        <div key={row.key} className="flex items-baseline justify-between gap-3 text-xs">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="text-right font-mono text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );

  if (compact) {
    return (
      <section className="pharos-card-shell overflow-hidden" aria-label="Access posture">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <h2 className="text-sm font-medium text-muted-foreground">Access posture</h2>
          <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="px-4 pb-4">{list}</div>
      </section>
    );
  }

  return (
    <section className="border-b border-border/40 pb-3 xl:hidden" aria-label="Access posture">
      <div className="flex items-center gap-2">
        <LockKeyhole className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Access posture</h3>
      </div>
      <div className="mt-1">{list}</div>
    </section>
  );
}
