import Image from "next/image";
import { CHART_PALETTE, CHART_SLATE, CHART_SLATE_STRONG } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { CHAIN_META } from "@shared/lib/chains";
import type { ChainSummary } from "@shared/types/chains";

/** Shared series colors for the dominance breakdown bar — CHART_PALETTE minus
 *  the frost-blue lead slot (idx 0 is reserved for live-data heroes). */
const DOMINANCE_COLORS = CHART_PALETTE.slice(1);
const OTHER_CHAINS_COLOR = CHART_SLATE_STRONG;
const UNATTRIBUTED_COLOR = CHART_SLATE;

interface DominanceBreakdownProps {
  /** Top chains by supply (independent of table sort), already sliced to the legend size. */
  topBySupply: ChainSummary[];
  globalTotalUsd: number;
  chainAttributedTotalUsd: number;
  unattributedTotalUsd: number;
  /** Signed chain-attributed minus global supply; derived from the totals when absent. */
  attributionDiscrepancyUsd?: number;
  /** Bar geometry denominator; `max(global, attributed)` when absent. Never used for labels. */
  dominanceGeometryTotalUsd?: number;
  /** Used only as a fallback total when chainAttributedTotalUsd is not finite. */
  chains: readonly ChainSummary[];
}

const RESIDUAL_LABEL_MIN_SHARE = 0.005;

function formatSharePct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function DominanceBreakdown({
  topBySupply,
  globalTotalUsd,
  chainAttributedTotalUsd,
  unattributedTotalUsd,
  attributionDiscrepancyUsd,
  dominanceGeometryTotalUsd,
  chains,
}: DominanceBreakdownProps) {
  // Labels are shares of the canonical global supply (`dominanceShare`); they are never rescaled.
  const topShare = topBySupply.reduce((s, c) => s + c.dominanceShare, 0);
  const attributedTotalUsd = Number.isFinite(chainAttributedTotalUsd)
    ? chainAttributedTotalUsd
    : chains.reduce((sum, chain) => sum + chain.totalUsd, 0);
  const hasGlobal = globalTotalUsd > 0;
  const chainAttributedShare = hasGlobal ? attributedTotalUsd / globalTotalUsd : 0;
  const unattributedShare =
    hasGlobal && Number.isFinite(unattributedTotalUsd) ? unattributedTotalUsd / globalTotalUsd : 0;
  const otherChainsShare = Math.max(0, chainAttributedShare - topShare);
  const discrepancyUsd = attributionDiscrepancyUsd != null && Number.isFinite(attributionDiscrepancyUsd)
    ? attributionDiscrepancyUsd
    : attributedTotalUsd - globalTotalUsd;
  const overAttributedShare = hasGlobal ? Math.max(0, discrepancyUsd) / globalTotalUsd : 0;
  // Geometry only: when chain rows over-attribute supply the bar normalizes to the larger raw total so
  // every segment fits without clamping; the printed percentages keep the global denominator.
  const geometryTotalUsd = dominanceGeometryTotalUsd != null && Number.isFinite(dominanceGeometryTotalUsd)
    ? dominanceGeometryTotalUsd
    : Math.max(globalTotalUsd, attributedTotalUsd);
  const geometryScale = hasGlobal && geometryTotalUsd > globalTotalUsd ? globalTotalUsd / geometryTotalUsd : 1;
  const showOtherChains = otherChainsShare > RESIDUAL_LABEL_MIN_SHARE;
  const showUnattributed = unattributedShare > RESIDUAL_LABEL_MIN_SHARE;
  const showOverAttribution = overAttributedShare > RESIDUAL_LABEL_MIN_SHARE;
  const ariaLabel = [
    `Supply dominance: ${topBySupply.map((c) => `${c.name} ${formatSharePct(c.dominanceShare)}`).join(", ")}`,
    showOtherChains ? `Other chains ${formatSharePct(otherChainsShare)}` : null,
    showUnattributed ? `Unattributed ${formatSharePct(unattributedShare)}` : null,
    showOverAttribution ? `Chain rows exceed global supply by ${formatSharePct(overAttributedShare)}` : null,
  ].filter((part): part is string => part != null).join(", ");
  return (
    <>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={ariaLabel}
      >
        {topBySupply.map((chain, idx) => (
          <div
            key={chain.id}
            className="h-full transition-all duration-500"
            style={{
              width: `${chain.dominanceShare * geometryScale * 100}%`,
              backgroundColor: DOMINANCE_COLORS[idx],
            }}
          />
        ))}
        {showOtherChains && (
          <div
            className="h-full"
            style={{ width: `${otherChainsShare * geometryScale * 100}%`, backgroundColor: OTHER_CHAINS_COLOR }}
          />
        )}
        {showUnattributed && (
          <div
            className="h-full"
            style={{
              width: `${unattributedShare * geometryScale * 100}%`,
              backgroundColor: UNATTRIBUTED_COLOR,
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 4px, oklch(0.95 0.01 245 / 0.35) 4px 6px)",
            }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {topBySupply.map((chain, idx) => (
          <span key={chain.id} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: DOMINANCE_COLORS[idx] }}
            />
            <Image
              src={chain.logoPath}
              alt=""
              width={14}
              height={14}
              className={cn("rounded-full", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
              style={{ width: 14, height: 14 }}
            />
            <span>{chain.name}</span>
            <span className="pharos-numeric">{formatSharePct(chain.dominanceShare)}</span>
          </span>
        ))}
        {showOtherChains && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: OTHER_CHAINS_COLOR }}
            />
            <span>Other chains</span>
            <span className="pharos-numeric">{formatSharePct(otherChainsShare)}</span>
          </span>
        )}
        {showUnattributed && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: UNATTRIBUTED_COLOR,
                backgroundImage:
                  "repeating-linear-gradient(135deg, transparent 0 3px, oklch(0.95 0.01 245 / 0.45) 3px 4px)",
              }}
            />
            <span>Unattributed</span>
            <span className="pharos-numeric">{formatSharePct(unattributedShare)}</span>
          </span>
        )}
        {showOverAttribution && (
          <span
            className="inline-flex items-center gap-1.5"
            title="Chain rows sum above the canonical global supply. Percentages stay shares of global supply; the bar is scaled to the larger chain-row total."
          >
            <span>Chain rows exceed global supply by</span>
            <span className="pharos-numeric">{formatSharePct(overAttributedShare)}</span>
          </span>
        )}
      </div>
    </>
  );
}
