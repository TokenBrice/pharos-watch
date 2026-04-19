import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";

const yieldBearingCount = YIELD_BEARING_STABLECOINS.length;
const desc = `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins plus curated lending opportunities. Compare APY, safety grades, freshness, the Pharos Yield Score, and peg-scoped yield universes including non-USD markets.`;

export const metadata = buildPageMetadata({
  title: "Yield Intelligence",
  description: desc,
  canonical: "/yield/",
  ogImage: `${SITE_URL}/og-yield.png`,
});

const faqJsonLd = buildFaqJsonLd([
  {
    question: "What is the Pharos Yield Score (PYS)?",
    answer: "The Pharos Yield Score (PYS) is a risk-adjusted yield metric scored 0-100 that balances yield magnitude against safety, benchmark context, and consistency. It starts from 30-day average APY, adds 25% of the row's benchmark spread, divides that effective yield by a safety-derived risk penalty raised to a fixed exponent, then applies a sustainability multiplier based on APY volatility over the same period. Higher-safety stablecoins incur a much lower adjusted penalty, so moderate but durable yield can compete with riskier double-digit offers.",
  },
  {
    question: "How are stablecoin yields sourced?",
    answer: "Yields are resolved through deterministic on-chain reads, curated DeFiLlama sources, price-derived or rate-derived fallbacks, and curated lending opportunities. Rankings refresh hourly, with slower supplemental-source families merged in from a separate four-hour lane, and preserve source-specific history so trailing APY metrics stay tied to the active source.",
  },
  {
    question: "What does 'risk-adjusted' mean for stablecoin yield?",
    answer: "Risk-adjusted yield accounts for the safety of the stablecoin issuing the yield, not just the raw APY. A stablecoin with a high safety grade (A or A+) receives a much lighter adjusted penalty in the PYS formula, so even a moderate APY can score well. Conversely, a risky stablecoin must offer meaningfully higher raw yield to achieve the same PYS, reflecting the extra risk borne by the holder.",
  },
]);

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.YieldClient })),
  loading: <Skeleton className="h-[600px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Yield Intelligence",
    path: "/yield/",
    title: "Yield Intelligence",
    statusBadge: { status: "beta", version: YIELD_METHODOLOGY_VERSION_LABEL },
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
      "Use the peg scope controls to isolate non-USD yield markets as a single view or drill into specific peg targets such as EUR, CHF, SGD, MXN, and gold.",
    ],
  },
});
