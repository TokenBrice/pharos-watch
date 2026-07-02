import { LiquidityLoadingState } from "@/app/liquidity/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${ACTIVE_STABLECOIN_COUNT} stablecoins, refreshed from the Pharos DEX liquidity lane across Curve, Uniswap, Fluid, and more.`;
export const metadata = buildPageMetadata({
  title: "DEX Liquidity: Stablecoin Pool Depth & Volume",
  description: liquidityDescription,
  canonical: "/liquidity/",
  ogImage: `${SITE_URL}/og-liquidity.png`,
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.LiquidityClient })),
  loading: <LiquidityLoadingState />,
  shell: {
    breadcrumbName: "DEX Liquidity",
    path: "/liquidity/",
    title: "DEX Liquidity",
    methodology: {
      version: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
      changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
    },
    leadParagraphs: [
      "Pool depth scored across 15+ DEX protocols — because liquidity is your only exit route in a panic.",
    ],
    headerSupplement: (
      <p className="pharos-lead hidden sm:block">
        The liquidity score weights on-chain depth, 24h volume, venue diversity, and redemption-backstop quality. A
        coin with deep pools on one protocol scores lower than a coin with durable liquidity across Curve, Uniswap,
        Fluid, Balancer, and native redemption rails.
      </p>
    ),
  },
});
