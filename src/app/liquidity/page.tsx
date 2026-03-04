import dynamic from "next/dynamic";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@/lib/liquidity-score-version";

const LiquidityClient = dynamic(
  () => import("./client").then((m) => ({ default: m.LiquidityClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${TRACKED_STABLECOINS.length} stablecoins across Curve, Uniswap, Fluid, and more.`;

export const metadata = buildPageMetadata({
  title: "DEX Liquidity: Stablecoin Pool Depth & Volume",
  description: liquidityDescription,
  canonical: "/liquidity/",
  ogImage: "https://pharos.watch/og-liquidity.png",
});

export default function LiquidityPage() {
  return (
    <FeaturePageShell
      breadcrumbName="DEX Liquidity"
      path="/liquidity/"
      title="DEX Liquidity"
      statusBadge={{ status: "mature", version: LIQUIDITY_METHODOLOGY_VERSION_LABEL }}
      methodology={{
        version: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
        changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={[
        `Liquidity scores, pool depth, and protocol breakdowns for ${TRACKED_STABLECOINS.length} stablecoins across decentralized exchanges.`,
        "The liquidity score is a 0–100 composite that measures on-chain pool depth, 24h trading volume, and protocol diversity across DEXes like Curve, Uniswap, and Fluid. Higher scores mean a stablecoin can absorb larger trades with less slippage, critical for both everyday swaps and stress scenarios.",
      ]}
    >
      <LiquidityClient />
    </FeaturePageShell>
  );
}
