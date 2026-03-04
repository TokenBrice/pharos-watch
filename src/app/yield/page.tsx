import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureStatusBadge } from "@/components/feature-status-badge";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@/lib/yield-methodology-version";

const YieldClient = dynamic(
  () => import("./client").then((m) => ({ default: m.YieldClient })),
  { loading: () => <Skeleton className="h-[600px] w-full rounded-xl" /> },
);

const yieldBearingCount = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing).length;
const desc = `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins. Compare APY, safety grades, and the Pharos Yield Score.`;

export const metadata: Metadata = {
  title: "Yield Intelligence",
  description: desc,
  alternates: { canonical: "/yield/" },
  openGraph: {
    title: "Yield Intelligence",
    description: desc,
    url: "/yield/",
    images: [{ url: "https://pharos.watch/og-yield.png", width: 1200, height: 630 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-yield.png", width: 1200, height: 630 }],
  },
};

export default function YieldPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Yield Intelligence" path="/yield/" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "What is the Pharos Yield Score (PYS)?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The Pharos Yield Score (PYS) is a risk-adjusted yield metric scored 0–100 that balances yield magnitude against safety and consistency. It divides the 30-day average APY by a risk penalty derived from the stablecoin's safety grade, then applies a sustainability multiplier based on APY volatility over the same period. Higher-safety stablecoins incur a lower risk penalty, so their PYS reflects their yield more faithfully.",
                },
              },
              {
                "@type": "Question",
                name: "How are stablecoin yields sourced?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Yields are resolved through a three-tier priority system updated every 30 minutes. Tier 1 reads on-chain vault exchange rates directly via RPC. Tier 2 pulls pool APY from the DeFiLlama Yields API, matched by a static pool map or symbol search. Tier 3 derives APY from 30-day price appreciation for NAV-appreciation tokens. The displayed APY figures are 30-day trailing averages computed from stored history.",
                },
              },
              {
                "@type": "Question",
                name: "What does 'risk-adjusted' mean for stablecoin yield?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Risk-adjusted yield accounts for the safety of the stablecoin issuing the yield, not just the raw APY. A stablecoin with a high safety grade (A or A+) receives a low risk penalty in the PYS formula, so even a moderate APY can score well. Conversely, a risky stablecoin must offer significantly higher raw yield to achieve the same PYS, reflecting the extra risk borne by the holder.",
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
          <span className="text-foreground">Yield Intelligence</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">Yield Intelligence <FeatureStatusBadge status="testing-in-prod" version={YIELD_METHODOLOGY_VERSION_LABEL} /></h1>
        <p className="text-xs text-muted-foreground">
          Methodology {YIELD_METHODOLOGY_VERSION_LABEL}.{" "}
          <Link href={YIELD_METHODOLOGY_CHANGELOG_PATH} className="underline underline-offset-4 hover:text-foreground transition-colors">
            Version history &rarr;
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          Risk-adjusted yield rankings for {yieldBearingCount} yield-bearing stablecoins.
          Compare APY, safety grades, and the Pharos Yield Score (PYS).
        </p>
      </div>
      <YieldClient />
    </div>
  );
}
