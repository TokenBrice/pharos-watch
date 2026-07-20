import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { YieldLoadingState } from "@/app/yield/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import type { FaqItem } from "@/lib/faq";

const desc =
  "Compare risk-adjusted stablecoin yield rankings by APY, safety grade, source freshness, benchmark spread, venue risk, and Pharos Yield Score.";

export const metadata = buildPageMetadata({
  title: "Stablecoin Yield Intelligence",
  description: desc,
  canonical: "/yield/",
  ogImage: `${SITE_URL}/og-yield.png`,
});

const FAQ_ITEMS = [
  {
    question: "What is the Pharos Yield Score (PYS)?",
    answer:
      "The Pharos Yield Score (PYS) is a risk-adjusted yield metric scored 0-100 that balances yield magnitude against safety, benchmark context, source risk, and consistency. It starts from 30-day average APY, adds 25% of the row's benchmark spread, divides that effective yield by source-risk and safety-derived penalties, then applies a sustainability multiplier based on APY volatility over the same period. Higher-safety stablecoins and cleaner yield sources incur lower adjusted penalties, so moderate but durable yield can compete with riskier double-digit offers.",
  },
  {
    question: "How are stablecoin yields sourced?",
    answer:
      "Yields are resolved through deterministic on-chain reads, curated DeFiLlama sources, price-derived or rate-derived fallbacks, and curated lending opportunities. Rankings refresh hourly, with slower supplemental-source families merged in from a separate four-hour lane, and preserve source-specific history so trailing APY metrics stay tied to the active source.",
  },
  {
    question: "What does 'risk-adjusted' mean for stablecoin yield?",
    answer:
      "Risk-adjusted yield accounts for the safety of the stablecoin issuing the yield, not just the raw APY. A stablecoin with a high safety grade (A or A+) receives a much lighter adjusted penalty in the PYS formula, so even a moderate APY can score well. Conversely, a risky stablecoin must offer meaningfully higher raw yield to achieve the same PYS, reflecting the extra risk borne by the holder.",
  },
  {
    question: "How do holder yield and lending opportunities differ?",
    answer:
      "Holder-yield rows describe yield attached to holding the stablecoin itself or a native yield-bearing wrapper. Lending opportunities describe external venues such as money markets, fixed-yield markets, or structured tranches where the underlying stablecoin is deposited into a separate venue. Both can appear in Yield Intelligence, but source posture, venue risk, depth, and warnings help separate durable holder yield from opportunity-specific risk.",
  },
  {
    question: "How is source posture different from the Safety grade?",
    answer:
      "The Safety grade evaluates the stablecoin. Source posture evaluates the yield observation behind the row: source confidence, venue review status, depth, freshness, reward-heavy composition, and source switches. A high-grade stablecoin can still have a watch or speculative yield source if the venue or observation needs scrutiny.",
  },
  {
    question: "Does source depth show executable capacity?",
    answer:
      "No. Depth is an explanatory lens for how much evidence backs the observed yield source, using venue size and related source-risk fields where available. It is not a fill-size estimate, execution quote, or guarantee that capital can enter or exit at the displayed APY.",
  },
  {
    question: "Is PYS a guarantee or an additive score breakdown?",
    answer:
      "No. PYS is a comparative ranking score built from historical APY, benchmark context, source-risk penalties, stablecoin safety penalties, and yield stability. Component explanations show why a row moved, but they are not guarantees and should not be read as independently additive promises of future return.",
  },
] as const satisfies readonly FaqItem[];

const YIELD_PICKER_NOTE = (
  <p className="text-sm text-muted-foreground">
    Building a yield shortlist? Start from the yield profile in{" "}
    <Link
      href="/screener/picker/?p=yield"
      className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
    >
      Stablecoin Picker
    </Link>
    .
  </p>
);

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.YieldClient })),
  loading: <YieldLoadingState />,
  shell: {
    breadcrumbName: "Yield Intelligence",
    path: "/yield/",
    title: "Yield Intelligence",
    methodology: {
      version: YIELD_METHODOLOGY_VERSION_LABEL,
      changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    },
    leadParagraphs: ["Stablecoin yield rankings that weigh every APY against safety and real-world benchmarks."],
  },
  afterClient: (
    <>
      {YIELD_PICKER_NOTE}
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});
