import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CemeteryClient } from "@/components/cemetery-client";
import { CemeteryCharts } from "@/components/cemetery-charts";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";

const cemeteryDescription = `A memorial to ${DEAD_STABLECOINS.length} fallen stablecoins. From TerraUSD to HUSD — what went wrong, when, and why.`;

export const metadata: Metadata = {
  title: "Stablecoin Cemetery — Failed & Defunct Stablecoins",
  description: cemeteryDescription,
  alternates: {
    canonical: "/cemetery/",
  },
  openGraph: {
    title: "Stablecoin Cemetery — Failed & Defunct Stablecoins",
    description: cemeteryDescription,
    url: "/cemetery/",
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
    </div>
  );
}
