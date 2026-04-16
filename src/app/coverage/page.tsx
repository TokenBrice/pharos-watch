import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";
import { ACTIVE_STABLECOINS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";

const coverageDescription =
  "Per-coin feature coverage across Pharos. See which stablecoins have depeg tracking, DEX price verification, reserve views, redemption backstop coverage, yield intelligence, mint/burn flows, blacklist tracking, and dependency-map visibility.";

export const COVERAGE_FAQ_ITEMS = [
  {
    q: "What features does Pharos track for each stablecoin?",
    a: "Pharos tracks nine core features per stablecoin: depeg monitoring with real-time price deviation alerts, DEX liquidity scoring across Curve, Uniswap, and other venues, reserve transparency views, modeled redemption backstop routes, yield intelligence for yield-bearing designs, Ethereum mint/burn flow monitoring, blacklist event tracking for freeze-capable assets, dependency map visibility for collateral relationships, and safety grade report cards across five risk dimensions.",
  },
  {
    q: "Why do some stablecoins have incomplete coverage?",
    a: "Coverage gaps typically stem from three factors: data availability (some newer or smaller stablecoins lack sufficient on-chain history for certain metrics), technical constraints (not all chains support the same level of RPC access for mint/burn tracking), and design differences (some wrapper or protocol-native designs do not expose traditional reserve reporting, while many assets do not expose a direct issuer or protocol redemption path). Pharos marks these gaps clearly rather than showing misleading placeholders.",
  },
  {
    q: "How often is coverage data updated?",
    a: "Prices and peg scores refresh every 15 minutes. DEX liquidity, DEWS stress signals, and PSI refresh every 30 minutes. Yield rankings refresh hourly, with slower supplemental source families updated every four hours. Mint/burn flows refresh every 20 minutes, blacklist events refresh hourly, redemption backstop snapshots refresh hourly, and safety grades plus reserve attestations typically update daily. The coverage matrix itself reflects the current availability state and updates as new data sources come online or existing ones expand.",
  },
] as const;

const COVERAGE_FAQ_JSON_LD = buildFaqJsonLd(
  COVERAGE_FAQ_ITEMS.map((item) => ({ question: item.q, answer: item.a })),
);

export const metadata = buildPageMetadata({
  title: "Coverage Matrix: Stablecoin Feature Coverage",
  description: coverageDescription,
  canonical: "/coverage/",
  ogImage: `${SITE_URL}/og-coverage.png`,
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.default })),
  loading: <Skeleton className="h-[560px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Coverage",
    path: "/coverage/",
    title: "Coverage Matrix",
    statusBadge: { status: "mature" },
    leadParagraphs: [
      `Use this page to answer two questions fast across ${ACTIVE_STABLECOINS.length} active tracked stablecoins: what Pharos can show for a coin right now, and how much of the tracked market each surface actually reaches.`,
      "Start with the feature snapshot for breadth by coin count and market-cap share, then drop into the matrix when you need the asset-level truth.",
      <>
        {PRE_LAUNCH_STABLECOINS.length}{" "}
        <a href="/upcoming" className="underline underline-offset-2 hover:text-foreground transition-colors">
          upcoming stablecoins
        </a>{" "}
        are excluded until they enter active tracking.
      </>,
    ],
    preface: (
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(COVERAGE_FAQ_JSON_LD) }} />
    ),
  },
});
