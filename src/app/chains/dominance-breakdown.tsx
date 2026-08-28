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
  /** Used only as a fallback total when chainAttributedTotalUsd is not finite. */
  chains: readonly ChainSummary[];
}

export function DominanceBreakdown({
  topBySupply,
  globalTotalUsd,
  chainAttributedTotalUsd,
  unattributedTotalUsd,
  chains,
}: DominanceBreakdownProps) {
  const topShare = topBySupply.reduce((s, c) => s + c.dominanceShare, 0);
  const attributedTotalUsd = Number.isFinite(chainAttributedTotalUsd)
    ? chainAttributedTotalUsd
    : chains.reduce((sum, chain) => sum + chain.totalUsd, 0);
  const chainAttributedShare = globalTotalUsd > 0 ? attributedTotalUsd / globalTotalUsd : 0;
  const unattributedShare =
    globalTotalUsd > 0 && Number.isFinite(unattributedTotalUsd) ? unattributedTotalUsd / globalTotalUsd : 0;
  const otherChainsShare = Math.max(0, chainAttributedShare - topShare);
  return (
    <>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`Supply dominance: ${topBySupply.map((c) => `${c.name} ${(c.dominanceShare * 100).toFixed(1)}%`).join(", ")}${otherChainsShare > 0.005 ? `, Other chains ${(otherChainsShare * 100).toFixed(1)}%` : ""}${unattributedShare > 0.005 ? `, Unattributed ${(unattributedShare * 100).toFixed(1)}%` : ""}`}
      >
        {topBySupply.map((chain, idx) => (
          <div
            key={chain.id}
            className="h-full transition-all duration-500"
            style={{
              width: `${chain.dominanceShare * 100}%`,
              backgroundColor: DOMINANCE_COLORS[idx],
            }}
          />
        ))}
        {otherChainsShare > 0.005 && (
          <div
            className="h-full"
            style={{ width: `${otherChainsShare * 100}%`, backgroundColor: OTHER_CHAINS_COLOR }}
          />
        )}
        {unattributedShare > 0.005 && (
          <div
            className="h-full"
            style={{
              width: `${unattributedShare * 100}%`,
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
            <span className="pharos-numeric">{(chain.dominanceShare * 100).toFixed(1)}%</span>
          </span>
        ))}
        {otherChainsShare > 0.005 && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: OTHER_CHAINS_COLOR }}
            />
            <span>Other chains</span>
            <span className="pharos-numeric">{(otherChainsShare * 100).toFixed(1)}%</span>
          </span>
        )}
        {unattributedShare > 0.005 && (
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
            <span className="pharos-numeric">{(unattributedShare * 100).toFixed(1)}%</span>
          </span>
        )}
      </div>
    </>
  );
}
