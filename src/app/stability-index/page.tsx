import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

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
        <h1 className="text-4xl font-extrabold tracking-tighter">Pharos Stability Index</h1>
        <p className="text-sm text-muted-foreground">
          Historical stablecoin market health scores, component breakdowns, and condition band analysis.
        </p>
        <p className="text-sm text-muted-foreground">
          The Pharos Stability Index (PSI) is a composite 0–100 score that combines peg deviation severity,
          depeg breadth, and supply-weighted volatility into a single market health reading. Scores fall into
          five condition bands, from Calm (80+) to Crisis (below 20), so you can gauge stablecoin market
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
            stablecoin market. It combines three signals: peg deviation severity (how far coins are from their target
            price), depeg breadth (what fraction of coins are actively depegged), and supply-weighted volatility
            (how much the largest stablecoins are fluctuating). A higher score means calmer markets.
          </p>
        </details>
        <details className="group border border-border/50 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            What do the condition bands mean?
          </summary>
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            PSI scores map to five condition bands: Calm (80–100) means almost all stablecoins are holding their peg
            with minimal volatility. Elevated (60–79) indicates some minor deviations. Stressed (40–59) means several
            coins are significantly off-peg. Distressed (20–39) signals widespread depegging across the market. Crisis
            (0–19) represents extreme market-wide peg failure.
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
                  text: "The Pharos Stability Index (PSI) is a composite 0–100 score that measures the overall health of the stablecoin market. It combines three signals: peg deviation severity (how far coins are from their target price), depeg breadth (what fraction of coins are actively depegged), and supply-weighted volatility (how much the largest stablecoins are fluctuating). A higher score means calmer markets.",
                },
              },
              {
                "@type": "Question",
                name: "What do the condition bands mean?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "PSI scores map to five condition bands: Calm (80–100) means almost all stablecoins are holding their peg with minimal volatility. Elevated (60–79) indicates some minor deviations. Stressed (40–59) means several coins are significantly off-peg. Distressed (20–39) signals widespread depegging across the market. Crisis (0–19) represents extreme market-wide peg failure.",
                },
              },
            ],
          }),
        }}
      />
    </div>
  );
}
