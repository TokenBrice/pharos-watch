import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { YieldContentLoadingState } from "@/app/yield/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import type { FaqItem } from "@/lib/faq";

const desc =
  "Compare stablecoin yields by APY, safety grade, source risk, and benchmark spread. The Pharos Yield Score asks one question: is this APY paying enough for the risk you take?";

const FAQ_ITEMS = [
  {
    question: "What is the Pharos Yield Score (PYS)?",
    answer:
      "The Pharos Yield Score (PYS) answers one question: is this APY paying enough for the risk you take? It is yield per unit of risk on a 0-100 scale, not a recommendation and not a safety verdict. It starts from 30-day average APY, adds 25% of the row's benchmark spread, swaps the row's local benchmark hurdle for the USD risk-free rate so a high-rate peg's policy-rate compensation is not scored as yield, divides that effective yield by source-risk and safety-derived penalties, then applies a sustainability multiplier based on APY volatility over the same period. A D-grade stablecoin can post a high PYS because it pays a lot for a lot of risk; read PYS next to the Safety grade and the row's zone (Sweet Spot, Danger Zone, Play It Safe, Why Bother?) before acting on it.",
  },
  {
    question: "How are stablecoin yields sourced?",
    answer:
      "Yields are resolved through deterministic on-chain reads, curated DeFiLlama sources, price-derived or rate-derived fallbacks, and curated lending opportunities. Rankings refresh after each Safety Score V9 publication window, with slower supplemental-source families merged in from a separate four-hour lane, and preserve source-specific history so trailing APY metrics stay tied to the active source.",
  },
  {
    question: "What does 'risk-adjusted' mean for stablecoin yield?",
    answer:
      "Risk-adjusted yield accounts for the safety of the stablecoin issuing the yield, not just the raw APY. A stablecoin with a high safety grade (A or A+) receives a much lighter adjusted penalty in the PYS formula, so even a moderate APY can score well. Conversely, a risky stablecoin must offer meaningfully higher raw yield to achieve the same PYS, reflecting the extra risk borne by the holder. Risk-adjusted does not mean safe: a top PYS on a low-grade coin says the yield compensates the risk well, not that the risk is small.",
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
    question: "Is PYS a guarantee, a recommendation, or an additive score breakdown?",
    answer:
      "None of these. PYS is a comparative score built from historical APY, benchmark context, source-risk penalties, stablecoin safety penalties, and yield stability. It ranks how well each row pays for its risk; it does not endorse a row, and the leaderboard sorted by PYS is not a list of recommended coins. Component explanations show why a row moved, but they are not guarantees and should not be read as independently additive promises of future return.",
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

const route = createClientFeaturePage({
  path: "/yield/",
  metadata: {
    title: "Stablecoin Yield Intelligence",
    description: desc,
    ogImage: `${SITE_URL}/og-yield.png`,
  },
  loadClient: () => import("@/components/yield/yield-client").then((m) => ({ default: m.YieldClient })),
  loading: <YieldContentLoadingState />,
  shell: {
    breadcrumbName: "Yield Intelligence",
    title: "Yield Intelligence",
    methodology: {
      version: YIELD_METHODOLOGY_VERSION_LABEL,
      changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    },
    leadParagraphs: [
      "Stablecoin yield rankings that weigh every APY against safety and real-world benchmarks.",
      "Two readings per row: Safety says how likely you are to lose money; PYS says how well the yield pays you for that chance. A high PYS on a D-grade coin is well-paid risk, not a safe pick. The page opens on the Opportunistic band (C+ safety, warnings hidden); widen the Risk tolerance slider to see everything.",
    ],
    leadFullWidth: true,
  },
  afterClient: (
    <>
      {YIELD_PICKER_NOTE}
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});

export const metadata = route.metadata;
export default route.Page;
