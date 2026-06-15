import Link from "next/link";
import { CalloutBanner } from "@/components/callout-banner";
import { FaqSection } from "@/components/faq-section";
import { LiquidityLoadingState } from "@/app/liquidity/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import type { FaqItem } from "@/lib/faq";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";

const liquidityDescription = `DEX liquidity scores, pool depth analysis, and protocol breakdowns for ${ACTIVE_STABLECOIN_COUNT} stablecoins, refreshed from the Pharos DEX liquidity lane across Curve, Uniswap, Fluid, and more.`;
export const metadata = buildPageMetadata({
  title: "DEX Liquidity: Stablecoin Pool Depth & Volume",
  description: liquidityDescription,
  canonical: "/liquidity/",
  ogImage: `${SITE_URL}/og-liquidity.png`,
});

const LIQUIDITY_FAQ_ITEMS = [
  {
    question: "What does the DEX Liquidity Score measure?",
    answer:
      "The DEX Liquidity Score measures stablecoin exit capacity across on-chain venues. It combines pool depth, 24-hour volume, venue diversity, concentration risk, and redemption-backstop quality so a coin with one deep pool does not look as resilient as a coin with several durable exits.",
  },
  {
    question: "Why can a large stablecoin have a weak liquidity score?",
    answer:
      "Market cap and exit depth are different. A large supply can still be hard to sell on-chain if liquidity is concentrated in one venue, routed through thin pools, or dependent on a fragile redemption path. The score is designed to expose that mismatch.",
  },
  {
    question: "How should I use liquidity data during stress?",
    answer:
      "Start with the score and pool breakdown, then check peg history, redemption backstops, and dependency risk. Liquidity can disappear quickly during a depeg, so use the page as an exit-capacity screen rather than a guarantee of executable size.",
  },
] as const satisfies readonly FaqItem[];

const LIQUIDITY_STATIC_SECTION = (
  <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
      <p className="pharos-kicker">How To Read Liquidity</p>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <p>
          A high score means a stablecoin has deeper, more distributed on-chain exit routes. A low score means the token
          may still hold its peg in quiet markets but can be difficult to unwind when everyone tries to exit at once.
        </p>
        <p>
          Pair this page with{" "}
          <Link
            href="/depeg/"
            className="pharos-prose-link"
          >
            Depeg Tracker
          </Link>
          ,{" "}
          <Link
            href="/safety-scores/"
            className="pharos-prose-link"
          >
            Safety Scores
          </Link>
          , and{" "}
          <Link
            href="/coverage/"
            className="pharos-prose-link"
          >
            Coverage Matrix
          </Link>{" "}
          before relying on a venue for production routing.
        </p>
      </div>
    </div>
    <div className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
      <p className="pharos-kicker">Best Questions</p>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <li>Is liquidity spread across several protocols or concentrated in one pool?</li>
        <li>Does the coin have a redemption path outside DEX liquidity?</li>
        <li>Are pools deep enough relative to supply, recent growth, and known dependency risk?</li>
      </ul>
    </div>
  </section>
);

const LIQUIDITY_CTA = (
  <CalloutBanner>
    Planning an exit route? Pair this liquidity screen with{" "}
    <Link
      href="/compare/"
      className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
    >
      Compare
    </Link>{" "}
    to inspect peg, safety, and liquidity side by side.
  </CalloutBanner>
);

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
  beforeClient: (
    <>
      {LIQUIDITY_STATIC_SECTION}
      {LIQUIDITY_CTA}
    </>
  ),
  afterClient: <FaqSection items={LIQUIDITY_FAQ_ITEMS} includeJsonLd />,
});
