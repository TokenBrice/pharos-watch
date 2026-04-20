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

const desc = "Risk-adjusted stablecoin yield rankings across native yield, lending venues, rate-derived sources, and curated opportunities. Compare APY, safety grades, freshness, benchmarks, and the Pharos Yield Score.";

export const metadata = buildPageMetadata({
  title: "Stablecoin Yield Intelligence",
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
      "Yield ranked against safety and real-world benchmarks — not just raw APY.",
      "The Pharos Yield Score (PYS) balances 30-day APY against safety grades, benchmark spread, and sustainability. A 15% APY on a D-grade stablecoin scores lower than 5% on an A-grade. Benchmarks include USD T-bill, EUR €STR, and CHF SARON rates so you know whether a yield premium is genuine or just risk compensation.",
    ],
  },
});
