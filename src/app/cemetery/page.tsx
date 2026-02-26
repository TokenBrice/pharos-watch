import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CemeteryClient } from "@/components/cemetery-client";
import { CemeteryCharts } from "@/components/cemetery-charts";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";

const cemeteryDescription = `A memorial to ${DEAD_STABLECOINS.length} fallen stablecoins. From TerraUSD to HUSD: what went wrong, when, and why.`;

export const metadata: Metadata = {
  title: "Stablecoin Cemetery: Failed & Defunct Stablecoins",
  description: cemeteryDescription,
  alternates: {
    canonical: "/cemetery/",
  },
  openGraph: {
    title: "Stablecoin Cemetery: Failed & Defunct Stablecoins",
    description: cemeteryDescription,
    url: "/cemetery/",
    images: [{ url: "https://pharos.watch/og-cemetery.png", width: 1200, height: 630 }],
  },
};

export default function CemeteryPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Stablecoin Cemetery" path="/cemetery/" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: "Stablecoin Cemetery",
            description: `${DEAD_STABLECOINS.length} defunct, depegged, and discontinued stablecoins documented with cause of death and obituaries.`,
            numberOfItems: DEAD_STABLECOINS.length,
            itemListElement: DEAD_STABLECOINS.map((coin, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: `${coin.name} (${coin.symbol})`,
              description: coin.obituary,
            })),
          }),
        }}
      />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Stablecoin Cemetery</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Stablecoin Cemetery</h1>
        <p className="text-sm text-muted-foreground">
          Defunct, depegged, and discontinued. A memorial to fallen stablecoins.{" "}
          <span className="hidden md:inline">Press F on hover to pay respects.</span>
        </p>
      </div>

      <CemeteryClient />

      <CemeteryCharts />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Frequently Asked Questions</h2>
        <details className="group border border-border/50 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            What causes stablecoins to fail?
          </summary>
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            Stablecoins fail for several recurring reasons: algorithmic designs that rely on reflexive token mechanics
            (like TerraUSD), custodial failures where the issuer loses or mismanages reserves, liquidity drains where
            redemptions outpace available collateral, regulatory shutdowns that freeze operations, and simple
            abandonment when the team stops maintaining the peg. Most failures share a common pattern: loss of market
            confidence triggers a bank-run dynamic that the stabilization mechanism cannot absorb.
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
                name: "What causes stablecoins to fail?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Stablecoins fail for several recurring reasons: algorithmic designs that rely on reflexive token mechanics (like TerraUSD), custodial failures where the issuer loses or mismanages reserves, liquidity drains where redemptions outpace available collateral, regulatory shutdowns that freeze operations, and simple abandonment when the team stops maintaining the peg. Most failures share a common pattern: loss of market confidence triggers a bank-run dynamic that the stabilization mechanism cannot absorb.",
                },
              },
            ],
          }),
        }}
      />
    </div>
  );
}
