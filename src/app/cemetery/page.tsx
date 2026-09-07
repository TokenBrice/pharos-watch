import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CemeteryClient } from "@/components/cemetery-client";
import { CemeteryCharts } from "@/components/cemetery-charts";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { CEMETERY_ENTRIES as DEAD_STABLECOINS } from "@shared/lib/cemetery-merged";
import type { FaqItem } from "@/lib/faq";
import { sortCemeteryCoins } from "@/lib/cemetery";

const cemeteryMetadataDescription = `${DEAD_STABLECOINS.length} failed and defunct stablecoins documented by Pharos, with collapse dates, causes, obituaries, archived data, and lessons from TerraUSD to HUSD.`;

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Cemetery: Failed & Defunct Stablecoins",
  description: cemeteryMetadataDescription,
  canonical: "/cemetery/",
  ogImage: `${SITE_URL}/og-editorial-cemetery.png`,
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
      <JsonLdScript
        json={safeJsonLd([
            ...buildCollectionItemListJsonLd({
              url: `${SITE_URL}/cemetery/`,
              name: "Stablecoin Cemetery",
              description: `${DEAD_STABLECOINS.length} defunct stablecoins documented.`,
              itemListDescription: `${DEAD_STABLECOINS.length} defunct, depegged, and discontinued stablecoins documented with cause of death and obituaries.`,
              numberOfItems: DEAD_STABLECOINS.length,
              entries: schemaCoins.map((coin) => ({
                item: {
                  "@type": "Thing",
                  name: `${coin.name} (${coin.symbol})`,
                  description: coin.obituary,
                },
              })),
            }),
            buildCemeteryDatasetJsonLd(),
          ])}
      />
      <div className="space-y-2">
        <h1 className="pharos-page-title">Stablecoin Cemetery</h1>
        <p className="pharos-page-lead max-w-4xl">
          Defunct, depegged, and discontinued. Logos mark each grave, biggest collapses stand tallest, and hover plaques surface the autopsy context.{" "}
          <span className="hidden md:inline">Press F on hover to pay respects.</span>
        </p>
        <p className="text-sm text-muted-foreground">
          Read the explainer:{" "}
          <Link
            href="/learn/mechanisms/algorithmic/"
            className="pharos-focus-ring text-foreground underline-offset-4 hover:underline"
          >
            how algorithmic stablecoin designs fail &rarr;
          </Link>
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

      <CemeteryClient entries={DEAD_STABLECOINS} />
      <CemeteryCharts entries={DEAD_STABLECOINS} />

      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </div>
  );
}
