import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CemeteryAnalysis } from "@/components/cemetery/cemetery-analysis";
import { CemeteryCauses } from "@/components/cemetery/cemetery-causes";
import { buildCemeteryCaseStudyLinks, CemeteryContext } from "@/components/cemetery/cemetery-context";
import { CemeteryDataset } from "@/components/cemetery/cemetery-dataset";
import { CemeteryHero } from "@/components/cemetery/cemetery-hero";
import { CemeteryKeyFacts } from "@/components/cemetery/cemetery-key-facts";
import { CemeteryRegister } from "@/components/cemetery/cemetery-register";
import { CemeterySelectionProvider } from "@/components/cemetery/cemetery-selection-context";
import { getPortraitAspectRatio } from "@/components/cemetery/plot-map-portrait-aspect";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { CEMETERY_DATASET_META } from "@/lib/cemetery-dataset-meta";
import { getObituaryLead } from "@/lib/cemetery-editorial";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";
import atlasManifest from "@/lib/cemetery-logo-atlas.generated.json";
import { toPlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import { buildCemeteryRegisterRows, buildRegisterFilterOptions } from "@/lib/cemetery-register";
import { buildCemeteryFaq, buildCemeteryStats } from "@/lib/cemetery-stats";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const PAGE_URL = `${SITE_URL}/cemetery/`;

const cemeteryMetadataDescription = `${CEMETERY_ENTRIES.length} failed or discontinued stablecoins documented by Pharos: end dates, causes of death, obituaries, sources, and archived data, from TerraUSD to Binance USD.`;

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Cemetery: Failed & Defunct Stablecoins",
  description: cemeteryMetadataDescription,
  canonical: "/cemetery/",
  ogImage: `${SITE_URL}/og-cemetery.png`,
  ogHeight: 630,
});

export default function CemeteryPage() {
  const stats = buildCemeteryStats(CEMETERY_ENTRIES);
  // One array for the hero and the register: React Flight serialises a shared reference once.
  const rows = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
  const asOf = stats.asOf.date;
  const schemaCoins = sortCemeteryCoins(CEMETERY_ENTRIES, "newest");

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
            url: PAGE_URL,
            name: "Stablecoin Cemetery",
            description: `${CEMETERY_ENTRIES.length} defunct stablecoins documented.`,
            itemListDescription: `${CEMETERY_ENTRIES.length} defunct, depegged, and discontinued stablecoins documented with cause of death and obituaries.`,
            numberOfItems: CEMETERY_ENTRIES.length,
            entries: schemaCoins.map((coin) => ({
              item: {
                "@type": "Thing",
                name: `${coin.name} (${coin.symbol})`,
                // The lead sentence, not the whole obituary: the full text already ships in the register and this
                // script is serialised twice (HTML and RSC flight) ahead of the streamed body reveal.
                description: getObituaryLead(coin.obituary),
                url: `${PAGE_URL}#${coin.id}`,
              },
            })),
          }),
          buildCemeteryDatasetJsonLd(),
        ])}
      />
      <CemeterySelectionProvider knownIds={rows.map((row) => row.id)}>
        <CemeteryHero
          rows={rows}
          stats={stats}
          asOf={asOf}
          atlas={toPlotLogoAtlas(atlasManifest)}
          portraitAspectRatio={getPortraitAspectRatio(rows, asOf)}
        />
        <CemeteryKeyFacts stats={stats} datasetMeta={CEMETERY_DATASET_META} />
        <CemeteryCauses stats={stats} />
        <CemeteryRegister rows={rows} filterOptions={buildRegisterFilterOptions(stats, rows)} />
        <CemeteryAnalysis stats={stats} />
        <CemeteryContext stats={stats} caseStudies={buildCemeteryCaseStudyLinks(CEMETERY_ENTRIES)} />
        <CemeteryDataset />
      </CemeterySelectionProvider>
      <div id="faq" className="scroll-mt-24">
        <FaqSection items={buildCemeteryFaq(stats)} includeJsonLd />
      </div>
    </div>
  );
}
