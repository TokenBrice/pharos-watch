import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${ACTIVE_STABLECOINS.length} stablecoins across Curve, Uniswap, Fluid, and more.`;
export const metadata = buildPageMetadata({
  title: "DEX Liquidity: Stablecoin Pool Depth & Volume",
  description: liquidityDescription,
  canonical: "/liquidity/",
  ogImage: `${SITE_URL}/og-liquidity.png`,
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.LiquidityClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "DEX Liquidity",
    path: "/liquidity/",
    title: "DEX Liquidity",
    statusBadge: { status: "mature", version: LIQUIDITY_METHODOLOGY_VERSION_LABEL },
    methodology: {
      version: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
      changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    },
    leadParagraphs: [
      `Liquidity scores, pool depth, and protocol breakdowns for ${ACTIVE_STABLECOINS.length} stablecoins across decentralized exchanges.`,
      "The liquidity score is a 0–100 composite that measures on-chain pool depth, 24h trading volume, and protocol diversity across DEXes like Curve, Uniswap, and Fluid. Higher scores mean a stablecoin can absorb larger trades with less slippage, critical for both everyday swaps and stress scenarios.",
    ],
  },
});
