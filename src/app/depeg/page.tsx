import dynamic from "next/dynamic";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";

const DepegClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DepegClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const depegDescription = `Live peg monitoring for ${TRACKED_STABLECOINS.length} stablecoins. Track peg scores, DEWS early warning signals, real-time deviation heatmaps, and a full history of depeg events — all in one place.`;

export const metadata = buildPageMetadata({
  title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
  description: depegDescription,
  canonical: "/depeg/",
  ogImage: "https://pharos.watch/og-depeg.png",
});

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is the DEWS score?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "DEWS (Depeg Early Warning System) is a per-coin forward-looking stress score from 0 to 100, computed every 15 minutes from 8 sub-signals: supply velocity, pool balance drift, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, and yield anomaly. It is designed to detect systemic stress before a depeg occurs, with scores amplified by up to 30% during periods of broader ecosystem instability (low PSI).",
      },
    },
    {
      "@type": "Question",
      name: "How is the peg score calculated?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The peg score (0–100) combines two equally weighted components: peg percentage (the share of tracked history spent at peg) and severity score (100 minus per-event penalties based on peak deviation magnitude, duration, and recency). An active depeg penalty of up to 50 points and a spread penalty of up to 15 points are subtracted. The score returns null for coins with fewer than 30 days of tracking history.",
      },
    },
    {
      "@type": "Question",
      name: "What counts as a depeg event on Pharos?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "A depeg event is triggered when a stablecoin's price deviates from its peg by more than 1% (100 bps) for USD-pegged coins, or 1.5% (150 bps) for non-USD pegs. Large-cap coins (supply above $1 billion) go through a two-stage confirmation process: the deviation must persist for at least 15 minutes and be independently confirmed by a second price source (CoinGecko or DEX data) before a depeg event is recorded.",
      },
    },
  ],
};

export default function DepegPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Depeg Tracker"
      path="/depeg/"
      title="Depeg Tracker"
      statusBadge={{ status: "mature", version: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL }}
      methodology={{
        version: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
        changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      }}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      }
      leadParagraphs={[
        `Real-time peg monitoring across ${TRACKED_STABLECOINS.length} stablecoins. Peg scores, DEWS early warning signals, live deviation heatmaps, and a full history of depeg events — all in one place.`,
      ]}
    >
      <DepegClient />
    </FeaturePageShell>
  );
}
