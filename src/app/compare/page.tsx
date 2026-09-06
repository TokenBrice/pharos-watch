import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FaqSection } from "@/components/faq-section";
import { CompareContentLoadingState } from "@/app/compare/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { STATIC_COMPARISON_PAGES } from "@/lib/compare-pages";
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
    question: "Can I compare a pair that is not listed here?",
    answer:
      "Yes. The briefs below cover selected pairs, but the live compare tool lets you choose any two to five tracked stablecoins.",
  },
  {
    question: "How should I use the comparison briefs and live tool together?",
    answer:
      "Start with a brief to understand the structural differences, then open the matching live comparison for current peg, liquidity, flow, reserve, and Safety Score data.",
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

const route = createClientFeaturePage({
  path: "/compare/",
  metadata: {
    title: "Compare Stablecoins: Side-by-Side Analysis",
    description: compareDescription,
    ogImage: `${SITE_URL}/og-compare.png`,
  },
  loadClient: () => import("@/components/compare/compare-client").then((m) => ({ default: m.CompareClient })),
  loading: <CompareContentLoadingState />,
  shell: {
    breadcrumbName: "Compare",
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

export const metadata = route.metadata;
export default route.Page;

function ComparePairDirectory() {
  return (
    <section aria-labelledby="compare-pair-directory-title" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="pharos-kicker">Comparison guides</p>
          <h2 id="compare-pair-directory-title" className="text-lg font-semibold tracking-tight text-foreground">
            Popular stablecoin comparisons
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Understand the structural differences between each pair, then open the matching live comparison for current
            market, peg, liquidity, flow, and safety data.
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
            <p className="pharos-kicker">Start here</p>
            <h3 id="priority-comparison-title" className="text-base font-semibold text-foreground">
              Featured comparisons
            </h3>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Explore yield-bearing wrappers, gold tokens, Liquity designs, and alternatives from different issuers.
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
                  Read comparison
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
