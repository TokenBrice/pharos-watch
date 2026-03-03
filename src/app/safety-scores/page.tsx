import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureStatusBadge } from "@/components/feature-status-badge";
import { SAFETY_SCORE_VERSION_LABEL } from "@/lib/safety-score-version";

const ReportCardsClient = dynamic(
  () => import("./client").then((m) => ({ default: m.ReportCardsClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const reportCardsDescription =
  "Transparent stablecoin safety grades and contagion simulation. Five dimensions combined into a single letter grade, plus simulate what happens when a major stablecoin fails.";

export const metadata: Metadata = {
  title: "Safety Scores: Stablecoin Safety Grades",
  description: reportCardsDescription,
  alternates: {
    canonical: "/safety-scores/",
  },
  openGraph: {
    title: "Safety Scores: Stablecoin Safety Grades",
    description: reportCardsDescription,
    url: "/safety-scores/",
    images: [{ url: "https://pharos.watch/og-safety-scores.png", width: 1200, height: 630 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-safety-scores.png", width: 1200, height: 630 }],
  },
};

export default function ReportCardsPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Safety Scores" path="/safety-scores/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Safety Scores</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Safety Scores <FeatureStatusBadge status="mature" version={SAFETY_SCORE_VERSION_LABEL} /></h1>
        <p className="text-sm text-muted-foreground">
          Safety grades and contagion simulation for every tracked stablecoin.
        </p>
        <p className="text-sm text-muted-foreground">
          Each stablecoin receives a letter grade from A+ to F based on five dimensions: peg stability,
          liquidity depth, transparency, resilience, and regulatory standing. The contagion simulator
          lets you model what happens to the broader market when a major stablecoin fails, revealing
          hidden dependency chains and systemic risk.
        </p>
      </div>
      <ReportCardsClient />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Frequently Asked Questions</h2>
        <details className="group border border-border/50 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            How are stablecoin safety grades calculated?
          </summary>
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            Each stablecoin is scored across five dimensions: peg stability (historical deviation and depeg events),
            liquidity depth (DEX pool size, volume, and protocol diversity), resilience (collateral quality,
            custody model, and blacklist capability), decentralization (governance type and chain infrastructure), and
            dependency risk (exposure to upstream stablecoins). Dimension scores are weighted and combined into a
            composite 0–100 score, then mapped to a letter grade from A+ to F.
          </p>
        </details>
        <details className="group border border-border/50 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            What does the contagion simulation show?
          </summary>
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            The contagion simulator models cascading failures in the stablecoin ecosystem. You select a stablecoin to
            &quot;fail&quot; and the simulation traces dependency chains: if stablecoin A uses stablecoin B as
            collateral, and B fails, A&apos;s grade degrades proportionally to its exposure. This reveals hidden
            systemic risk: which coins look safe in isolation but are fragile under stress.
          </p>
        </details>
      </section>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "How are stablecoin safety grades calculated?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Each stablecoin is scored across five dimensions: peg stability (historical deviation and depeg events), liquidity depth (DEX pool size, volume, and protocol diversity), resilience (collateral quality, custody model, and blacklist capability), decentralization (governance type and chain infrastructure), and dependency risk (exposure to upstream stablecoins). Dimension scores are weighted and combined into a composite 0–100 score, then mapped to a letter grade from A+ to F.",
                },
              },
              {
                "@type": "Question",
                name: "What does the contagion simulation show?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The contagion simulator models cascading failures in the stablecoin ecosystem. You select a stablecoin to \"fail\" and the simulation traces dependency chains: if stablecoin A uses stablecoin B as collateral, and B fails, A's grade degrades proportionally to its exposure. This reveals hidden systemic risk: which coins look safe in isolation but are fragile under stress.",
                },
              },
            ],
          }),
        }}
      />
    </div>
  );
}
