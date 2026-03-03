import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureStatusBadge } from "@/components/feature-status-badge";
import { PSI_METHODOLOGY_VERSION_LABEL } from "@/lib/stability-index-version";

const StabilityIndexClient = dynamic(
  () => import("./client").then((m) => ({ default: m.StabilityIndexClient })),
  { loading: () => <div className="space-y-6"><Skeleton className="h-48 w-full rounded-xl" /><Skeleton className="h-[350px] w-full rounded-xl" /><Skeleton className="h-[350px] w-full rounded-xl" /></div> },
);

const description = "Historical Pharos Stability Index scores, component breakdowns, and condition band analysis for the stablecoin market.";

export const metadata: Metadata = {
  title: "Stability Index: Pharos Stablecoin Market Health",
  description,
  alternates: { canonical: "/stability-index/" },
  openGraph: {
    title: "Stability Index: Pharos Stablecoin Market Health",
    description,
    url: "/stability-index/",
    images: [{ url: "https://pharos.watch/og-stability-index.png", width: 1200, height: 630 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-stability-index.png", width: 1200, height: 630 }],
  },
};

export default function StabilityIndexPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Stability Index" path="/stability-index/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Stability Index</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">
          Pharos Stability Index
          <FeatureStatusBadge status="mature" version={PSI_METHODOLOGY_VERSION_LABEL} />
        </h1>
        <p className="text-sm text-muted-foreground">
          Historical stablecoin market health scores, component breakdowns, and condition band analysis.
        </p>
        <p className="text-sm text-muted-foreground">
          The Pharos Stability Index (PSI) is a composite 0–100 score that combines peg deviation severity,
          depeg breadth, DEWS stress breadth, and 7-day market-cap trend into a single market health reading.
          Scores fall into six condition bands, from BEDROCK (90+) to MELTDOWN (below 20), so you can gauge market
          stress at a glance.
        </p>
      </div>
      <StabilityIndexClient />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Frequently Asked Questions</h2>
        <details className="group border border-border/50 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            What is the Pharos Stability Index?
          </summary>
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            The Pharos Stability Index (PSI) is a composite 0–100 score that measures the overall health of the
            stablecoin market. It combines four signals: peg deviation severity (how far coins are from their target
            price), depeg breadth (what fraction of coins are actively depegged), DEWS stress breadth (coins under
            elevated stress before full depegs), and 7-day market-cap trend. A higher score means calmer markets.
          </p>
        </details>
        <details className="group border border-border/50 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            What do the condition bands mean?
          </summary>
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            PSI scores map to six condition bands: BEDROCK (90–100), STEADY (75–89), TREMOR (60–74),
            FRACTURE (40–59), CRISIS (20–39), and MELTDOWN (0–19). Each lower band reflects broader and deeper
            stablecoin stress.
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
                name: "What is the Pharos Stability Index?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The Pharos Stability Index (PSI) is a composite 0–100 score that measures stablecoin market health. It combines peg deviation severity, depeg breadth, DEWS stress breadth, and 7-day market-cap trend. A higher score means calmer markets.",
                },
              },
              {
                "@type": "Question",
                name: "What do the condition bands mean?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "PSI scores map to six condition bands: BEDROCK (90–100), STEADY (75–89), TREMOR (60–74), FRACTURE (40–59), CRISIS (20–39), and MELTDOWN (0–19). Lower bands indicate broader and deeper market instability.",
                },
              },
            ],
          }),
        }}
      />
    </div>
  );
}
