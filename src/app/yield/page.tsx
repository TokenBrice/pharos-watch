import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import { buildStablecoinUrl } from "@/lib/urls";
import type { FaqItem } from "@/lib/faq";

const desc =
  "Risk-adjusted stablecoin yield rankings across native yield, lending venues, rate-derived sources, and curated opportunities. Compare APY, safety grades, freshness, benchmarks, and the Pharos Yield Score.";

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
] as const satisfies readonly FaqItem[];

const YIELD_STATIC_SECTION = (
  <section className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
    <p className="pharos-kicker">Yield Is A Risk Surface</p>
    <div className="mt-3 grid gap-3 text-sm leading-relaxed text-muted-foreground lg:grid-cols-3">
      <p>
        Raw APY is only the first number. A sustainable stablecoin yield should be compared against the stablecoin
        safety grade, the relevant fiat benchmark, source freshness, and historical volatility.
      </p>
      <p>
        Use{" "}
        <Link
          href="/safety-scores/"
          className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
        >
          Safety Scores
        </Link>{" "}
        to understand the issuer and dependency side, then use the yield table to see whether the APY premium pays
        enough for that risk.
      </p>
      <p>
        The page separates native yield, lending opportunities, rate-derived rows, and curated sources so a protocol
        incentive is not confused with reserve-backed income.
      </p>
    </div>
  </section>
);

const YIELD_BEARING_COINS = TRACKED_STABLECOINS.filter((coin) => coin.flags?.yieldBearing).sort((a, b) =>
  a.symbol.localeCompare(b.symbol),
);

const YIELD_COIN_INDEX = (
  <section className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
    <p className="pharos-kicker">Per-coin yield analysis</p>
    <p className="mt-2 text-sm text-muted-foreground">
      Deeper history, source comparison, warning timeline, and source-switch trail for each yield-bearing stablecoin.
    </p>
    <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
      {YIELD_BEARING_COINS.map((coin) => (
        <li key={coin.id}>
          <Link
            href={`${buildStablecoinUrl(coin.id)}yield/`}
            className="pharos-focus-ring rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {coin.symbol}
          </Link>
        </li>
      ))}
    </ul>
  </section>
);

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
    leadParagraphs: [
      "Yield ranked against safety and real-world benchmarks — not just raw APY.",
      "The Pharos Yield Score (PYS) balances 30-day APY against source risk, safety grades, benchmark spread, and sustainability. A 15% APY on a D-grade stablecoin or thin source evidence scores lower than 5% on an A-grade. Benchmarks include USD T-bill, EUR €STR, and CHF SARON rates so you know whether a yield premium is genuine or just risk compensation.",
    ],
  },
  beforeClient: YIELD_STATIC_SECTION,
  afterClient: (
    <>
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
      {YIELD_COIN_INDEX}
    </>
  ),
});
