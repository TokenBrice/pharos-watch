import Link from "next/link";
import { Bell } from "lucide-react";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { CalloutBanner } from "@/components/callout-banner";
import { ShareButton } from "@/components/share-button";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildApiOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import { safeJsonLd } from "@/lib/json-ld";
import { buildFaqJsonLd } from "@/lib/faq";

const depegDescription = `Use the Depeg Tracker as the live incident board for peg stress across ${ACTIVE_STABLECOINS.length} stablecoins: active deviations, DEWS early warnings, heatmaps, and depeg history in one surface.`;

export const metadata = buildPageMetadata({
  title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
  description: depegDescription,
  canonical: "/depeg/",
  ogImage: buildApiOgImageUrl("/api/og/depeg"),
});

const faqJsonLd = buildFaqJsonLd([
  {
    question: "What is the DEWS score?",
    answer: "DEWS (Depeg Early Warning System) is a per-coin forward-looking stress score from 0 to 100, computed every 30 minutes from 8 sub-signals: supply velocity, pool balance drift, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, and yield anomaly. It is designed to detect systemic stress before a depeg occurs, with scores amplified by up to 30% during periods of broader ecosystem instability (low PSI), plus a bounded same-peg contagion multiplier from current WARNING/DANGER peers (currently 1.08/1.15, capped at 1.2).",
  },
  {
    question: "How is the peg score calculated?",
    answer: "The peg score (0–100) combines two equally weighted components: peg percentage (the share of tracked history spent at peg) and severity score (100 minus per-event penalties based on peak deviation magnitude, duration, and recency). An active depeg penalty of up to 50 points and a spread penalty of up to 15 points are subtracted. The score returns null for coins with fewer than 7 days of tracking history, and scores based on 7 to 30 days are labeled Early score.",
  },
  {
    question: "What counts as a depeg event on Pharos?",
    answer: "A depeg event is triggered when a stablecoin's price deviates from its peg by more than 1% (100 bps) for USD-pegged coins, or 1.5% (150 bps) for non-USD pegs. Pharos opens events immediately only when the primary price input is trusted. Large-cap coins, low-confidence price inputs, and extreme moves go through a two-stage confirmation process: the deviation must persist for at least 15 minutes and then receive same-direction corroboration from CoinGecko or DefiLlama, Binance, supported native-peg quotes, or trusted DEX and challenger-pool data. Opposite-direction evidence rejects the pending incident instead of confirming it.",
  },
]);

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.DepegClient })),
  loading: <Skeleton className="h-[400px] w-full rounded-xl" />,
  shell: {
    breadcrumbName: "Depeg Tracker",
    path: "/depeg/",
    title: "Depeg Tracker",
    statusBadge: { status: "mature", version: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL },
    methodology: {
      version: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
    },
    headerActions: <ShareButton ogPath="/api/og/depeg" />,
    preface: (
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqJsonLd) }}
      />
    ),
    leadParagraphs: [
      "A forward-looking incident board — not just price deviations, but early warning signals before the depeg happens.",
      `DEWS scans 8 sub-signals every 30 minutes across ${ACTIVE_STABLECOINS.length} stablecoins — supply velocity, pool drift, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, and yield anomaly — to flag stress before it hits the price. When systemic risk rises, the radar sweeps faster.`,
    ],
  },
  beforeClient: (
    <CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
      Tired of monitoring the situation? Let Pharos do it for you: get instant Telegram alerts for depeg events and DEWS threat level changes.{" "}
      <Link
        href="/telegram#bot"
        className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
      >
        Set up alerts&nbsp;&rarr;
      </Link>
    </CalloutBanner>
  ),
});
