import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import { safeJsonLd } from "@/lib/json-ld";

const yieldBearingCount = YIELD_BEARING_STABLECOINS.length;
const desc = `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins plus curated lending opportunities. Compare APY, safety grades, freshness, and the Pharos Yield Score.`;

export const metadata = buildPageMetadata({
  title: "Yield Intelligence",
  description: desc,
  canonical: "/yield/",
  ogImage: "https://pharos.watch/og-yield.png",
});

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is the Pharos Yield Score (PYS)?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The Pharos Yield Score (PYS) is a risk-adjusted yield metric scored 0–100 that balances yield magnitude against safety and consistency. It divides the 30-day average APY by a risk penalty derived from the stablecoin's safety grade, then applies a sustainability multiplier based on APY volatility over the same period. Higher-safety stablecoins incur a lower risk penalty, so their PYS reflects their yield more faithfully.",
      },
    },
    {
      "@type": "Question",
      name: "How are stablecoin yields sourced?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yields are resolved through deterministic on-chain reads, curated DeFiLlama sources, price-derived or rate-derived fallbacks, and curated lending opportunities. Rankings are refreshed every 30 minutes and now preserve source-specific history so trailing APY metrics stay tied to the active source.",
      },
    },
    {
      "@type": "Question",
      name: "What does 'risk-adjusted' mean for stablecoin yield?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Risk-adjusted yield accounts for the safety of the stablecoin issuing the yield, not just the raw APY. A stablecoin with a high safety grade (A or A+) receives a low risk penalty in the PYS formula, so even a moderate APY can score well. Conversely, a risky stablecoin must offer significantly higher raw yield to achieve the same PYS, reflecting the extra risk borne by the holder.",
      },
    },
  ],
};

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.YieldClient })),
  loading: <Skeleton className="h-[600px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Yield Intelligence",
    path: "/yield/",
    title: "Yield Intelligence",
    accent: "border-t-amber-500",
    statusBadge: { status: "mature", version: YIELD_METHODOLOGY_VERSION_LABEL },
    methodology: {
      version: YIELD_METHODOLOGY_VERSION_LABEL,
      changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    },
    preface: (
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
      />
    ),
    leadParagraphs: [
      `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins plus curated lending opportunities. Compare APY, safety grades, freshness, and the Pharos Yield Score (PYS).`,
    ],
  },
});
