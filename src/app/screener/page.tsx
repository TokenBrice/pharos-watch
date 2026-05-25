import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { Skeleton } from "@/components/ui/skeleton";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import type { FaqItem } from "@/lib/faq";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";

const screenerDescription = `Filter ${TRACKED_STABLECOIN_COUNT} stablecoins by DEWS, Safety Grade, Safety Score dimensions, supply, type, mechanism, peg, mint authority, and lifecycle.`;

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
      "The Screener filters the tracked stablecoin universe by DEWS, Safety Grade, Safety Score dimensions, supply, type, mechanism, peg, mint authority, and lifecycle. Share the URL to share the exact filter state.",
  },
  {
    question: "How is filter state shared?",
    answer:
      "Each filter is encoded as a URL parameter, for example `?dewsMin=40&mechanisms=cdp,fiat-cash`. Copying the URL preserves the same view on another device.",
  },
  {
    question: "Why are some scores empty?",
    answer:
      "Pharos rates roughly 50–70% of tracked stablecoins on each score. Coins with insufficient history, no DEX coverage, or recent listings show a dash. Active score thresholds exclude coins missing that score.",
  },
  {
    question: "Why isn't jurisdiction a filter yet?",
    answer:
      "Jurisdiction data lives on the server-side stablecoin registry and isn't included in the slim browser bundle that powers the Screener. Adding it would expand the client payload; we're holding off until there's clear demand.",
  },
] as const satisfies readonly FaqItem[];

const SCREENER_SUPPORT_SECTION = (
  <section className="space-y-4">
    <div className="rounded-xl border border-border/60 bg-card/45 px-4 py-3">
      <p className="text-sm font-semibold text-foreground">How to use this screener</p>
      <div className="mt-3 grid gap-4 text-sm leading-relaxed text-muted-foreground lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="space-y-2">
          <p className="pharos-kicker">Reading the Filters</p>
          <p>
            Numeric thresholds narrow the candidate set on DEWS stress, the five Safety Score sub-dimensions,
            and USD-denominated supply. Multi-select pills filter by Safety Grade, type, mechanism archetype,
            mint-authority bucket, peg, and lifecycle.
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
        <div>
          <p className="pharos-kicker">Useful Starting Points</p>
          <ul className="mt-2 space-y-1.5">
            <li>Which CDP stablecoins still hold an A-grade with Peg Stability &gt; 90?</li>
            <li>What does the active-depeg cohort look like at DEWS &gt; 60?</li>
            <li>Which major stablecoins rely on issuer or multisig mint authority?</li>
            <li>How does EUR-pegged coverage compare to USD by Exit Liquidity?</li>
          </ul>
        </div>
      </div>
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
    leadParagraphs: [
      "Filter the tracked stablecoin universe by Safety Grade, safety dimensions, DEWS, supply, type, mechanism, peg, mint authority, and lifecycle. Every filter lives in the URL, so sharing the link shares the view.",
      "Mint Authority filters are descriptive review buckets for who can create or route durable supply; they do not change Safety Scores.",
    ],
  },
  afterClient: (
    <>
      {SCREENER_SUPPORT_SECTION}
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});
