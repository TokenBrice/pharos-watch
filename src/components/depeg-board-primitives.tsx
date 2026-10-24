"use client";

import { cn } from "@/lib/utils";
import { getPegDeviationLevel, PEG_DEVIATION_TONE_CLASSES, QUALITY_TIER_3_CLASSES } from "@shared/lib/classification";
import { clampScore } from "@shared/lib/math";
import { getDeviationBarWidthPercent } from "@/components/depeg-board-model";

export function DeviationBar({ bps }: { bps: number | null }) {
  if (bps === null) {
    return <div className="h-1.5 rounded-full bg-muted" aria-label="Deviation unavailable" />;
  }
  const abs = Math.abs(bps);
  const width = clampScore(getDeviationBarWidthPercent(abs));
  const barClass = PEG_DEVIATION_TONE_CLASSES[getPegDeviationLevel(abs)].bar;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-label={`Deviation ${bps > 0 ? "+" : ""}${bps} basis points`}>
      <div className={cn("h-full rounded-full", barClass)} style={{ width: `${Math.max(3, width)}%` }} />
    </div>
  );
}

export function LinearGauge({
  value,
  max = 100,
  tone = QUALITY_TIER_3_CLASSES.good.bar,
  ariaLabel,
}: {
  value: number | null | undefined;
  max?: number;
  tone?: string;
  ariaLabel: string;
}) {
  const pct = value == null ? 0 : clampScore((Math.abs(value) / max) * 100);
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-label={ariaLabel}>
      <div className={cn("h-full rounded-full", tone)} style={{ width: value == null ? "0%" : `${Math.max(3, pct)}%` }} />
    </div>
  );
}

export function EventLoadMeter({ count, symbol }: { count: number; symbol: string }) {
  const filled = count <= 0 ? 0 : Math.max(1, Math.min(5, Math.ceil(Math.log10(count + 1))));
  return (
    <div className="flex gap-1" aria-label={`Historical depeg event load for ${symbol}: ${count}`}>
      {Array.from({ length: 5 }).map((_, index) => (
        <span
          key={index}
          className={cn(
            "h-1.5 flex-1 rounded-[2px] border border-border/50",
            index < filled ? "border-state-warn-solid/40 bg-state-warn-solid" : "bg-muted/35",
          )}
        />
      ))}
    </div>
  );
}
