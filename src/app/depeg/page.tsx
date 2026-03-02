import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const DepegClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DepegClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const depegDescription = `Live peg monitoring for ${TRACKED_STABLECOINS.length} stablecoins. Track peg scores, DEWS early warning signals, real-time deviation heatmaps, and a full history of depeg events — all in one place.`;

export const metadata: Metadata = {
  title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
  description: depegDescription,
  alternates: {
    canonical: "/depeg/",
  },
  openGraph: {
    title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
    description: depegDescription,
    url: "/depeg/",
    images: [{ url: "https://pharos.watch/og-depeg.png", width: 1200, height: 630 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-depeg.png", width: 1200, height: 630 }],
  },
};

export default function DepegPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Depeg Tracker" path="/depeg/" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
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
          }),
        }}
      />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Depeg Tracker</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Depeg Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Real-time peg monitoring across {TRACKED_STABLECOINS.length} stablecoins.
          Peg scores, DEWS early warning signals, live deviation heatmaps, and a
          full history of depeg events — all in one place.
        </p>
      </div>
      <DepegClient />
    </div>
  );
}
