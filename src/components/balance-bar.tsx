import { ratioQualityColor } from "@/lib/severity-colors";
import { RATIO_QUALITY_COLORS } from "@shared/lib/classification";

export function BalanceBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  const quality = ratio >= 0.8 ? "healthy" : ratio >= 0.5 ? "caution" : "critical";
  const bgColor = RATIO_QUALITY_COLORS[quality];
  const textColor = ratioQualityColor(ratio);
  const level = ratio >= 0.8 ? "good" : ratio >= 0.5 ? "fair" : "poor";
  return (
    <div className="flex items-center gap-1.5" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Pool balance ${pct}%, ${level}`}>
      <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden" aria-hidden="true">
        <div className={`h-full rounded-full ${bgColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`font-mono tabular-nums text-xs ${textColor}`}>{pct}%</span>
    </div>
  );
}
