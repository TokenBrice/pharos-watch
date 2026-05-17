import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import type { FaqItem } from "@/lib/faq";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";

const screenerDescription = `Filter ${TRACKED_STABLECOIN_COUNT} stablecoins by DEWS, Safety Grade, Safety Score dimensions, supply, type, mechanism, peg, and lifecycle. Permalinks share the exact view.`;

export const metadata = buildPageMetadata({
  title: "Pharos Screener: Filter Stablecoins by Score & Mechanism",
  description: screenerDescription,
  canonical: "/screener/",
  ogImage: `${SITE_URL}/og-default.png`,
});

const FAQ_ITEMS = [
  {
    question: "What does the Pharos Screener do?",
    answer:
      "The Screener is a client-side filter over the same DEWS, Safety Grade, Safety Score dimensions, supply, type, mechanism, peg, and lifecycle data that powers the rest of Pharos. Set score thresholds, narrow by type, mechanism, or peg, and share the URL — the filter state is encoded directly in the query string.",
  },
  {
    question: "How is filter state shared?",
    answer:
      "Every filter is a flat URL parameter (for example `?dewsMin=40&mechanisms=cdp,fiat-cash`). Copying the URL preserves the exact view; opening it on another device reproduces the same filter and result set.",
  },
  {
    question: "Why are some scores empty?",
    answer:
      "Pharos rates roughly 50–70% of tracked stablecoins on each score. Coins with insufficient history, no DEX coverage, or recent listings show a dash. Active score-range filters automatically exclude coins missing that score so you don't get false negatives.",
  },
  {
    question: "Why isn't jurisdiction a filter yet?",
    answer:
      "Jurisdiction data lives on the server-side stablecoin registry and isn't included in the slim browser bundle that powers the Screener. Adding it would expand the client payload; we're holding off until there's clear demand.",
  },
] as const satisfies readonly FaqItem[];

const SCREENER_STATIC_SECTION = (
  <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
      <p className="pharos-kicker">How To Read The Screener</p>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <p>
          Numeric thresholds narrow the candidate set on DEWS stress, the five Safety Score sub-dimensions,
          and USD-denominated supply. Multi-select pills filter by Safety Grade, type, mechanism archetype, peg, and
          lifecycle.
        </p>
        <p>
          Cross-reference results against the{" "}
          <Link
            href="/safety-scores/"
            className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
          >
            Safety Scores
          </Link>
          ,{" "}
          <Link
            href="/depeg/"
            className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
          >
            Depeg Tracker
          </Link>
          , and{" "}
          <Link
            href="/liquidity/"
            className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
          >
            DEX Liquidity
          </Link>{" "}
          before relying on a coin in production.
        </p>
      </div>
    </div>
    <div className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
      <p className="pharos-kicker">Good Questions To Ask</p>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <li>Which CDP stablecoins still hold an A-grade with PegScore above 90?</li>
        <li>What does the active-depeg cohort look like at DEWS &gt; 60?</li>
        <li>How does EUR-pegged coverage compare to USD by Liquidity Score?</li>
      </ul>
    </div>
  </section>
);

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.ScreenerClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Screener",
    path: "/screener/",
    title: "Pharos Screener",
    statusBadge: { status: "beta" },
    leadParagraphs: [
      "Filter the tracked stablecoin universe by score, Safety Grade, Safety Score dimensions, supply, type, mechanism, peg, and lifecycle.",
      "Every filter lives in the URL — share the link to share the view. Numeric ranges respect missing scores so a partially rated coin is never wrongly excluded.",
    ],
  },
  beforeClient: SCREENER_STATIC_SECTION,
  afterClient: <FaqSection items={FAQ_ITEMS} includeJsonLd />,
});
