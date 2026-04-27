import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CemeteryClient } from "@/components/cemetery-client";
import { CemeteryCharts } from "@/components/cemetery-charts";
import { FaqSection } from "@/components/faq-section";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { CEMETERY_ENTRIES as DEAD_STABLECOINS } from "@shared/lib/cemetery-merged";
import type { FaqItem } from "@/lib/faq";
import { sortCemeteryCoins } from "@/lib/cemetery";

const cemeteryDescription = `A memorial to ${DEAD_STABLECOINS.length} fallen stablecoins. From TerraUSD to HUSD: what went wrong, when, and why.`;

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Cemetery: Failed & Defunct Stablecoins",
  description: cemeteryDescription,
  canonical: "/cemetery/",
  ogImage: `${SITE_URL}/og-cemetery.png`,
});

const FAQ_ITEMS = [
  {
    question: "What causes stablecoins to fail?",
    answer:
      "Stablecoins fail for several recurring reasons: algorithmic designs that rely on reflexive token mechanics (like TerraUSD), custodial failures where the issuer loses or mismanages reserves, liquidity drains where redemptions outpace available collateral, regulatory shutdowns that freeze operations, and simple abandonment when the team stops maintaining the peg. Most failures share a common pattern: loss of market confidence triggers a bank-run dynamic that the stabilization mechanism cannot absorb.",
  },
] as const satisfies readonly FaqItem[];

export default function CemeteryPage() {
  const schemaCoins = sortCemeteryCoins(DEAD_STABLECOINS, "newest");

  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Stablecoin Cemetery", url: "/cemetery/" },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd([
            {
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/cemetery/#collection`,
              name: "Stablecoin Cemetery",
              description: `${DEAD_STABLECOINS.length} defunct stablecoins documented.`,
              url: `${SITE_URL}/cemetery/`,
              mainEntity: { "@id": `${SITE_URL}/cemetery/#itemlist` },
              isPartOf: { "@id": `${SITE_URL}#website` },
            },
            {
              "@context": "https://schema.org",
              "@type": "ItemList",
              "@id": `${SITE_URL}/cemetery/#itemlist`,
              name: "Stablecoin Cemetery",
              description: `${DEAD_STABLECOINS.length} defunct, depegged, and discontinued stablecoins documented with cause of death and obituaries.`,
              numberOfItems: DEAD_STABLECOINS.length,
              itemListElement: schemaCoins.map((coin, i) => ({
                "@type": "ListItem",
                position: i + 1,
                item: {
                  "@type": "Thing",
                  name: `${coin.name} (${coin.symbol})`,
                  description: coin.obituary,
                },
              })),
            },
          ]),
        }}
      />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="pharos-focus-ring hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Stablecoin Cemetery</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Stablecoin Cemetery</h1>
        <p className="text-sm text-muted-foreground">
          Defunct, depegged, and discontinued. Newest graves surface first, and the biggest collapses stand tallest.{" "}
          <span className="hidden md:inline">Press F on hover to pay respects.</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Download the citation-ready dataset as{" "}
          <a className="pharos-focus-ring text-foreground underline-offset-4 hover:underline" href="/datasets/stablecoin-cemetery.json">
            JSON
          </a>{" "}
          or{" "}
          <a className="pharos-focus-ring text-foreground underline-offset-4 hover:underline" href="/datasets/stablecoin-cemetery.csv">
            CSV
          </a>
          .
        </p>
      </div>

      <CemeteryCharts />
      <CemeteryClient />

      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </div>
  );
}
