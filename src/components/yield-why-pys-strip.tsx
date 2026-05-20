import { formatSignedPercent } from "@shared/lib/format";
import { PYS_SUSTAINABILITY_FLOOR } from "@shared/lib/yield-scoring";

interface YieldWhyPysStripProps {
  benchmarkSpread: number | null;
  benchmarkLabel?: string | null;
  stabilityPct: number | null;
  sustainabilityMult: number;
  grade: string | null;
  safetyScore: number | null;
  adjustedRiskPenalty: number;
  sourceRiskPenalty: number;
  sourceRiskDriverLabel: string | null;
}

export function YieldWhyPysStrip({
  benchmarkSpread,
  benchmarkLabel,
  stabilityPct,
  sustainabilityMult,
  grade,
  safetyScore,
  adjustedRiskPenalty,
  sourceRiskPenalty,
  sourceRiskDriverLabel,
}: YieldWhyPysStripProps) {
  const benchSpreadValue = benchmarkSpread !== null ? formatSignedPercent(benchmarkSpread, 1) : "—";
  const benchSubLabel = benchmarkLabel ? `vs ${benchmarkLabel}` : "Benchmark unavailable";
  const stabilityValue = stabilityPct !== null ? `${stabilityPct}%` : "—";
  const stabilitySub = sustainabilityMult === PYS_SUSTAINABILITY_FLOOR ? "(floor)" : "30d APY variance";
  const safetyValue =
    grade && grade !== "NR"
      ? grade
      : safetyScore !== null
        ? `${Math.round(safetyScore)}/100`
        : "—";
  const safetySub = `÷${adjustedRiskPenalty.toFixed(1)}× penalty`;
  const sourceRiskValue = `${sourceRiskPenalty.toFixed(2)}×`;
  const sourceRiskSub = sourceRiskPenalty === 1 ? "Neutral" : sourceRiskDriverLabel ?? "Neutral";

  const cells: Array<{ title: string; value: string; sublabel: string }> = [
    { title: "Bench spread", value: benchSpreadValue, sublabel: benchSubLabel },
    { title: "Stability", value: stabilityValue, sublabel: stabilitySub },
    { title: "Safety", value: safetyValue, sublabel: safetySub },
    { title: "Source risk", value: sourceRiskValue, sublabel: sourceRiskSub },
  ];

  return (
    <div role="group" aria-label="Why this PYS" className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((cell) => (
        <div
          key={cell.title}
          aria-label={`${cell.title}: ${cell.value}, ${cell.sublabel}`}
          className="rounded-lg border border-border/60 bg-background/55 px-3 py-2"
        >
          <p className="text-xs text-muted-foreground">{cell.title}</p>
          <p className="font-mono tabular-nums text-sm text-foreground">{cell.value}</p>
          <p className="truncate text-[10px] text-muted-foreground">{cell.sublabel}</p>
        </div>
      ))}
    </div>
  );
}
