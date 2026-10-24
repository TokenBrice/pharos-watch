import { LiquidityContentLoadingState } from "@/app/liquidity/loading-state";
import { ShareButton } from "@/components/share-button";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildLiveRouteOgImageUrl } from "@/lib/page-metadata";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${ACTIVE_STABLECOIN_COUNT} stablecoins, refreshed from the Pharos DEX liquidity lane across Curve, Uniswap, Fluid, and more.`;

const route = createClientFeaturePage({
  path: "/liquidity/",
  metadata: {
    title: "DEX Liquidity: Stablecoin Pool Depth & Volume",
    description: liquidityDescription,
    ogImage: buildLiveRouteOgImageUrl("liquidity"),
  },
  loadClient: () => import("./client").then((m) => ({ default: m.LiquidityClient })),
  loading: <LiquidityContentLoadingState />,
  shell: {
    breadcrumbName: "DEX Liquidity",
    title: "DEX Liquidity",
    methodology: {
      version: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
      changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
      label: "Liquidity Score methodology",
    },
    header: "instrument",
    headerActions: <ShareButton ogPath={API_PATHS.ogPage("liquidity")} />,
    leadParagraphs: [
      "Pool depth across 15+ DEX protocols, your exit route in a panic.",
      "The Liquidity Score weights on-chain depth, 24h volume, venue diversity, and redemption-backstop quality. A coin with deep pools on one protocol scores lower than a coin with durable liquidity across Curve, Uniswap, Fluid, Balancer, and native redemption rails.",
    ],
    leadDisclosureLabel: "How the Liquidity Score works",
  },
});

export const metadata = route.metadata;
export default route.Page;
