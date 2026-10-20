import Image from "next/image";
import { cn } from "@/lib/utils";
import { formatChainShare } from "@/lib/chain-ui";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { CHAIN_META } from "@shared/types/chain-identity";
import type { ChainSummary } from "@shared/types/chains";

/** Neutral ink ramp, largest chain darkest: the Harbor below owns the page's hues (cargo, health flags, beam), so
 *  chain identity here comes from the logo and name, never a categorical colour (as on the OG card). */
const DOMINANCE_INK_PCT = [82, 66, 53, 42, 33, 26];
const ink = (pct: number) => `color-mix(in oklab, var(--foreground) ${pct}%, var(--card))`;
const dominanceColor = (idx: number) => ink(DOMINANCE_INK_PCT[Math.min(idx, DOMINANCE_INK_PCT.length - 1)]!);
const OTHER_CHAINS_COLOR = ink(18);
const UNATTRIBUTED_COLOR = ink(12);
/** The hatch stays legible on the dark card, where a 30% stripe over ink(12) all but vanished. */
const UNATTRIBUTED_HATCH = (from: number, to: number) =>
  `repeating-linear-gradient(135deg, transparent 0 ${from}px, color-mix(in oklab, var(--foreground) 45%, transparent) ${from}px ${to}px)`;

interface DominanceBreakdownProps {
  /** Top chains by supply (independent of table sort), already sliced to the legend size. */
  topBySupply: ChainSummary[];
  globalTotalUsd: number | null;
  chainAttributedTotalUsd: number | null;
  unattributedTotalUsd: number | null;
  /** Signed chain-attributed minus global supply; derived only for legacy omission, never null. */
  attributionDiscrepancyUsd?: number | null;
  /** Bar geometry denominator; observed row geometry stays separate from unavailable global ratios. */
  dominanceGeometryTotalUsd?: number | null;
  /** Observed rows may supply geometry, never a replacement global statistic. */
  chains: readonly ChainSummary[];
  /** The chain whose share the hero beam prints: its legend key names it without repeating the figure. */
  beamChainId?: string;
}

const RESIDUAL_LABEL_MIN_SHARE = 0.005;

export function DominanceBreakdown({
  topBySupply,
  globalTotalUsd,
  chainAttributedTotalUsd,
  unattributedTotalUsd,
  attributionDiscrepancyUsd,
  dominanceGeometryTotalUsd,
  chains,
  beamChainId,
}: DominanceBreakdownProps) {
  // Labels are shares of the canonical global supply (`dominanceShare`); they are never rescaled.
  const topShare = topBySupply.every((chain) => chain.dominanceShare != null)
    ? topBySupply.reduce((sum, chain) => sum + chain.dominanceShare!, 0)
    : null;
  const observedTotalUsd = chains.reduce((sum, chain) => sum + chain.totalUsd, 0);
  const attributedTotalUsd = chainAttributedTotalUsd != null && Number.isFinite(chainAttributedTotalUsd)
    ? chainAttributedTotalUsd
    : chainAttributedTotalUsd === null ? null : observedTotalUsd;
  const hasGlobal = globalTotalUsd != null && globalTotalUsd > 0;
  const chainAttributedShare = hasGlobal && attributedTotalUsd != null ? attributedTotalUsd / globalTotalUsd : null;
  const unattributedShare = hasGlobal && unattributedTotalUsd != null
    ? unattributedTotalUsd / globalTotalUsd : null;
  const otherChainsShare = chainAttributedShare != null && topShare != null ? Math.max(0, chainAttributedShare - topShare) : null;
  const discrepancyUsd = attributionDiscrepancyUsd === undefined
    ? attributedTotalUsd != null && globalTotalUsd != null ? attributedTotalUsd - globalTotalUsd : null
    : attributionDiscrepancyUsd;
  const overAttributedShare = hasGlobal && discrepancyUsd != null ? Math.max(0, discrepancyUsd) / globalTotalUsd : null;
  // Unknown global ratios do not erase observed chain geometry or turn it into a global claim.
  const geometryTotalUsd = dominanceGeometryTotalUsd != null && Number.isFinite(dominanceGeometryTotalUsd)
    ? dominanceGeometryTotalUsd
    : hasGlobal && attributedTotalUsd != null ? Math.max(globalTotalUsd, attributedTotalUsd) : observedTotalUsd;
  const geometryScale = hasGlobal && geometryTotalUsd > globalTotalUsd ? globalTotalUsd / geometryTotalUsd : 1;
  const showOtherChains = otherChainsShare != null && otherChainsShare > RESIDUAL_LABEL_MIN_SHARE;
  const showUnattributed = unattributedShare != null && unattributedShare > RESIDUAL_LABEL_MIN_SHARE;
  const showOverAttribution = overAttributedShare != null && overAttributedShare > RESIDUAL_LABEL_MIN_SHARE;
  const ariaLabel = [
    `Supply dominance: ${topBySupply.map((c) => `${c.name} ${formatChainShare(c.dominanceShare)}`).join(", ")}`,
    showOtherChains ? `Other chains ${formatChainShare(otherChainsShare)}` : null,
    showUnattributed ? `Unattributed ${formatChainShare(unattributedShare)}` : null,
    showOverAttribution ? `Chain rows exceed global supply by ${formatChainShare(overAttributedShare)}` : null,
  ].filter((part): part is string => part != null).join(", ");
  return (
    <>
      <div
        className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={ariaLabel}
      >
        {topBySupply.map((chain, idx) => (
          <div
            key={chain.id}
            className="h-full transition-all duration-500"
            style={{
              width: `${hasGlobal && chain.dominanceShare != null ? chain.dominanceShare * geometryScale * 100 : geometryTotalUsd > 0 && Number.isFinite(geometryTotalUsd) ? chain.totalUsd / geometryTotalUsd * 100 : 0}%`,
              backgroundColor: dominanceColor(idx),
            }}
          />
        ))}
        {showOtherChains && (
          <div
            className="h-full"
            style={{ width: `${otherChainsShare! * geometryScale * 100}%`, backgroundColor: OTHER_CHAINS_COLOR }}
          />
        )}
        {showUnattributed && (
          <div
            className="h-full"
            style={{
              width: `${unattributedShare! * geometryScale * 100}%`,
              backgroundColor: UNATTRIBUTED_COLOR,
              backgroundImage: UNATTRIBUTED_HATCH(4, 6),
            }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {topBySupply.map((chain, idx) => (
          <span key={chain.id} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: dominanceColor(idx) }}
            />
            <Image
              src={resolveCompactLogoSrc(chain.logoPath, 14)!}
              alt=""
              width={14}
              height={14}
              className={cn("rounded-full", CHAIN_META[chain.id]?.darkInvert ? "dark:invert" : "")}
              style={{ width: 14, height: 14 }}
            />
            <span className={chain.id === beamChainId ? "font-medium text-foreground" : undefined}>{chain.name}</span>
            {chain.id === beamChainId ? null : <span className="pharos-numeric">{formatChainShare(chain.dominanceShare)}</span>}
          </span>
        ))}
        {showOtherChains && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: OTHER_CHAINS_COLOR }}
            />
            <span>Other chains</span>
            <span className="pharos-numeric">{formatChainShare(otherChainsShare)}</span>
          </span>
        )}
        {showUnattributed && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: UNATTRIBUTED_COLOR,
                backgroundImage: UNATTRIBUTED_HATCH(2, 4),
              }}
            />
            <span>Unattributed</span>
            <span className="pharos-numeric">{formatChainShare(unattributedShare)}</span>
          </span>
        )}
        {showOverAttribution && (
          <span
            className="inline-flex items-center gap-1.5"
            title="Chain rows sum above the canonical global supply. Percentages stay shares of global supply; the bar is scaled to the larger chain-row total."
          >
            <span>Chain rows exceed global supply by</span>
            <span className="pharos-numeric">{formatChainShare(overAttributedShare)}</span>
          </span>
        )}
      </div>
    </>
  );
}
