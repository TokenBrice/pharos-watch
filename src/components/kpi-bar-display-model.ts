import {
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
  getNetColor,
} from "@shared/lib/format";
import { PSI_BAND_CLASSES, type ConditionBand } from "@shared/lib/psi-colors";
import { trendTextClass } from "@/components/kpi-bar-parts";

const EMPTY = "—";
const MUTED = "text-muted-foreground";

export function resolvePsiColorClass(psiBand: string): string {
  return psiBand && psiBand in PSI_BAND_CLASSES ? PSI_BAND_CLASSES[psiBand as ConditionBand] : "";
}

export function formatPsiDeltaValue(delta: number | null): string | null {
  return delta !== null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}` : null;
}

export function buildMcapDisplay(
  snapshot: { mcapChange24hPct: number; mcapChange7dPct: number; usdtUsdcSharePct: number },
  hasStablecoinsData: boolean,
) {
  return {
    change24Display: hasStablecoinsData ? formatSignedPercent(snapshot.mcapChange24hPct, 2) : EMPTY,
    change7Display: hasStablecoinsData ? formatSignedPercent(snapshot.mcapChange7dPct, 2) : EMPTY,
    colorClass: hasStablecoinsData ? trendTextClass(snapshot.mcapChange24hPct) : MUTED,
    color7Class: hasStablecoinsData ? trendTextClass(snapshot.mcapChange7dPct) : MUTED,
    usdtShareDisplay: hasStablecoinsData ? `${snapshot.usdtUsdcSharePct.toFixed(1)}%` : EMPTY,
  };
}

export function buildPegStatusDisplay(
  summary: { coinsAtPeg: number; totalTracked: number } | undefined,
): string {
  return summary ? `${summary.coinsAtPeg}/${summary.totalTracked}` : EMPTY;
}

export function buildDexDisplay(
  snapshot: { totalVol24h: number; volVs7dAvgPct: number; turnoverPct: number },
  hasDexData: boolean,
  hasStablecoinsData: boolean,
  totalMcap: number,
) {
  return {
    volDisplay: hasDexData ? formatCurrency(snapshot.totalVol24h, 1) : EMPTY,
    deltaDisplay: hasDexData ? formatSignedPercent(snapshot.volVs7dAvgPct, 1) : EMPTY,
    deltaColorClass: hasDexData ? trendTextClass(snapshot.volVs7dAvgPct) : MUTED,
    turnoverDisplay:
      hasStablecoinsData && hasDexData && totalMcap > 0 ? `${snapshot.turnoverPct.toFixed(2)}%` : EMPTY,
  };
}

export function buildFlowDisplay(
  snapshot: { netFlow24h: number; netFlow7d: number },
  hasFlowData: boolean,
) {
  const tone: "neutral" | "positive" | "negative" = !hasFlowData
    ? "neutral"
    : snapshot.netFlow7d > 0
      ? "positive"
      : snapshot.netFlow7d < 0
        ? "negative"
        : "neutral";
  return {
    netFlow24Display: hasFlowData ? formatSignedCurrency(snapshot.netFlow24h, 1) : EMPTY,
    netFlow7Display: hasFlowData ? formatSignedCurrency(snapshot.netFlow7d, 1) : EMPTY,
    netFlow24Class: hasFlowData ? getNetColor(snapshot.netFlow24h) : MUTED,
    netFlow7Class: hasFlowData ? getNetColor(snapshot.netFlow7d) : MUTED,
    netFlow7Tone: tone,
  };
}

export function buildDewsDisplay(
  dewsBandCounts: { danger: number; alert: number; warning: number } | null,
) {
  const elevatedCount = dewsBandCounts
    ? dewsBandCounts.danger + dewsBandCounts.warning + dewsBandCounts.alert
    : 0;
  const allCalm = !!dewsBandCounts && elevatedCount === 0;
  // Uses the project's mandated text-*-700 dark:text-*-400 pairing per
  // docs/design-tokens.md so the pill passes AA contrast in both themes.
  const severityClass = !dewsBandCounts
    ? MUTED
    : dewsBandCounts.danger > 0
      ? "text-red-700 dark:text-red-400"
      : dewsBandCounts.warning > 0
        ? "text-orange-700 dark:text-orange-400"
        : dewsBandCounts.alert > 0
          ? "text-yellow-700 dark:text-yellow-400"
          : MUTED;
  return { elevatedCount, allCalm, severityClass };
}
