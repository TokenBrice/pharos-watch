import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

const coverageDescription =
  "Per-coin feature coverage across Pharos. See which stablecoins have depeg tracking, DEX price verification, reserve views, yield intelligence, mint/burn flows, blacklist tracking, and dependency-map visibility.";

const COVERAGE_FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What features does Pharos track for each stablecoin?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Pharos tracks eight core features per stablecoin: depeg monitoring with real-time price deviation alerts, DEX liquidity scoring across Curve, Uniswap, and other venues, proof-of-reserve transparency with attestation links, yield intelligence for yield-bearing designs, Ethereum mint/burn flow monitoring, blacklist event tracking for freeze-capable assets, dependency map visibility for collateral relationships, and safety grade report cards across five risk dimensions.",
      },
    },
    {
      "@type": "Question",
      name: "Why do some stablecoins have incomplete coverage?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Coverage gaps typically stem from three factors: data availability (some newer or smaller stablecoins lack sufficient on-chain history for certain metrics), technical constraints (not all chains support the same level of RPC access for mint/burn tracking), and design differences (algorithmic stablecoins don't have traditional reserves, while non-yield-bearing designs have no yield data to display). Pharos marks these gaps clearly rather than showing misleading placeholders.",
      },
    },
    {
      "@type": "Question",
      name: "How often is coverage data updated?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Most metrics refresh every 15 minutes: prices, peg scores, DEX liquidity, and DEWS stress signals. Mint/burn flows and blacklist events sync on a similar cadence. Yield data updates every 30 minutes. Safety grades and reserve attestations typically update daily. The coverage matrix itself reflects the current availability state and updates as new data sources come online or existing ones expand.",
      },
    },
  ],
};

export const metadata = buildPageMetadata({
  title: "Coverage Matrix: Stablecoin Feature Coverage",
  description: coverageDescription,
  canonical: "/coverage/",
  ogImage: "https://pharos.watch/og-coverage.png",
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.default })),
  loading: <Skeleton className="h-[560px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Coverage",
    path: "/coverage/",
    title: "Coverage",
    statusBadge: { status: "mature" },
    leadParagraphs: [
      `Feature breadth across ${ACTIVE_STABLECOINS.length} tracked stablecoins.`,
      "Start with the feature snapshot to see how wide each Pharos surface reaches by coin count and market-cap share. Then drop into the matrix to inspect what is available on a specific asset.",
    ],
    preface: (
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(COVERAGE_FAQ_JSON_LD) }}
      />
    ),
  },
});
