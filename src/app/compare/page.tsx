import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FaqSection } from "@/components/faq-section";
import { CompareLoadingState } from "@/app/compare/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";

const compareDescription = `Compare ${ACTIVE_STABLECOIN_COUNT} stablecoins side by side across peg stability, liquidity depth, Safety Scores, supply history, mint/burn flows, and structural risk using Pharos live data.`;

const compareHubFaqItems = [
  {
    question: "What can I compare on Pharos?",
    answer:
      "The live compare tool puts two to five tracked stablecoins in one view across peg behavior, market cap history, liquidity depth, mint/burn flow, Safety Scores, backing, governance, and chain deployment context.",
  },
  {
    question: "Why does this page list only selected comparison pairs?",
    answer:
      "The pair directory is intentionally capped to high-intent stablecoin comparisons so readers and crawlers get useful static briefs without generating every possible pair from the tracked registry.",
  },
  {
    question: "Do the static comparison pages replace the live compare tool?",
    answer:
      "No. Static pair pages explain structural differences and link into the matching live comparison. Use the live tool before making decisions because peg, liquidity, flow, reserve, and Safety Score data can change after the static brief is generated.",
  },
] as const;

const PRIORITY_COMPARISON_SLUGS = new Set([
  "usde-ethena-vs-susde-ethena",
  "lusd-liquity-vs-bold-liquity",
  "paxg-paxos-vs-xaut-tether",
  "usdt-tether-vs-tusd-trueusd",
  "usdt-tether-vs-usdd-tron-dao-reserve",
  "usdc-circle-vs-usdg-paxos",
]);

const priorityComparisonPages = STATIC_COMPARISON_PAGES.filter((page) => PRIORITY_COMPARISON_SLUGS.has(page.slug));

export const metadata = buildPageMetadata({
  title: "Compare Stablecoins: Side-by-Side Analysis",
  description: compareDescription,
  canonical: "/compare/",
  ogImage: `${SITE_URL}/og-compare.png`,
});

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.CompareClient })),
  loading: <CompareLoadingState />,
  shell: {
    breadcrumbName: "Compare",
    path: "/compare/",
    title: "Compare Stablecoins",
    leadParagraphs: [
      "Build a live peer set, then read peg behavior, liquidity, safety scores, and structural differences without bouncing between detail pages.",
    ],
    headerSupplement: (
      <p className="pharos-lead hidden sm:block">
        Select two to five tracked assets. Presets are starting angles, not canned answers: the useful work starts once
        the comparison is on screen.
      </p>
    ),
  },
  afterClient: (
    <>
      <ComparePairDirectory />
      <FaqSection items={compareHubFaqItems} title="Compare Stablecoins FAQ" includeJsonLd />
    </>
  ),
});

function ComparePairDirectory() {
  return (
    <section aria-labelledby="compare-pair-directory-title" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="pharos-kicker">Static Pair Directory</p>
          <h2 id="compare-pair-directory-title" className="text-lg font-semibold tracking-tight text-foreground">
            Popular stablecoin comparisons
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Crawlable static briefs for high-intent stablecoin pairs. Each page frames structural differences, then
            links back into the live Pharos compare tool for current market, peg, liquidity, flow, and safety data.
          </p>
        </div>
        <Link
          href={buildLiveCompareUrl(["usdt-tether", "usdc-circle"])}
          className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border/60 bg-background/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:min-h-10"
        >
          Open live USDT vs USDC
          <ArrowRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        </Link>
      </div>

      {priorityComparisonPages.length > 0 ? (
        <section aria-labelledby="priority-comparison-title" className="space-y-3 border-y border-border/60 py-4">
          <div className="space-y-1.5">
            <p className="pharos-kicker">Priority Paths</p>
            <h3 id="priority-comparison-title" className="text-base font-semibold text-foreground">
              High-intent comparison briefs
            </h3>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              These selected pair pages cover high-intent wrapper, gold-token, Liquity, and issuer-substitute searches.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {priorityComparisonPages.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                className="pharos-focus-ring group block rounded-lg border border-border/60 bg-background/55 px-3 py-3 transition-colors hover:bg-accent"
              >
                <p className="font-mono text-xs text-muted-foreground">
                  {page.left.symbol} / {page.right.symbol}
                </p>
                <p className="mt-1 text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                  {page.shortTitle}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{page.description}</p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {STATIC_COMPARISON_PAGES.map((page) => (
          <article key={page.href} className="pharos-card-shell px-4 py-4">
            <div className="flex h-full flex-col gap-3">
              <div className="min-w-0 space-y-2">
                <p className="pharos-kicker">
                  {page.left.symbol} / {page.right.symbol}
                </p>
                <h3 className="text-base font-semibold tracking-tight text-foreground">
                  <Link href={page.href} className="pharos-focus-ring rounded-sm hover:text-frost-blue">
                    {page.shortTitle}
                  </Link>
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{page.description}</p>
              </div>
              <div className="mt-auto flex flex-wrap gap-2 text-sm">
                <Link
                  href={page.href}
                  className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
                >
                  Static brief
                </Link>
                <Link
                  href={buildLiveCompareUrl([page.left.id, page.right.id])}
                  className="pharos-focus-ring inline-flex min-h-10 items-center rounded-full border border-border/60 bg-background/70 px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Live tool
                </Link>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
