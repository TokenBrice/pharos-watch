"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";

const BAND_COLORS: Record<string, string> = {
  BEDROCK: "text-green-500",
  STEADY: "text-teal-500",
  TREMOR: "text-yellow-500",
  FRACTURE: "text-orange-500",
  CRISIS: "text-red-500",
  MELTDOWN: "text-red-800",
};

const SPARKLINE_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

export function StabilityIndex() {
  const { data, isLoading } = useStabilityIndex();

  if (!isLoading && (!data || !data.current)) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-4 py-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  const { score, band, computedAt } = data!.current!;
  const history = data!.history;

  // Delta from yesterday (first history point)
  const yesterday = history.length > 0 ? history[0] : null;
  const delta = yesterday ? Math.round((score - yesterday.score) * 10) / 10 : null;

  const colorClass = BAND_COLORS[band] ?? "text-foreground";
  const sparkColor = SPARKLINE_COLORS[band] ?? "#888";

  // Build sparkline points from history (oldest to newest) + current
  const sparkData = [...history].reverse().concat({ date: computedAt, score, band });

  return (
    <div className="flex items-center gap-4 animate-in fade-in duration-300">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Stability Index
        </span>
        <span className={`text-2xl font-bold tabular-nums ${colorClass}`}>
          {score.toFixed(1)}
        </span>
        <span className={`text-sm font-bold uppercase tracking-wide ${colorClass}`}>
          {band}
        </span>
      </div>
      {delta !== null && (
        <span className={`text-sm font-medium tabular-nums ${delta >= 0 ? "text-green-500" : "text-red-500"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}
        </span>
      )}
      {sparkData.length > 1 && (
        <Sparkline data={sparkData} color={sparkColor} />
      )}
    </div>
  );
}

function Sparkline({ data, color }: { data: { score: number; band: string }[]; color: string }) {
  const scores = data.map((d) => d.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const padding = 2;

  const points = scores
    .map((s, i) => {
      const x = padding + (i / (scores.length - 1)) * (w - 2 * padding);
      const y = h - padding - ((s - min) / range) * (h - 2 * padding);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} className="shrink-0" aria-label="30-day stability index trend">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
