import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import { TaxonomyHeaderActions } from "@/components/taxonomy-header-actions";
import { PEG_TAXONOMY_PAGES, PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { PegLandingClient } from "./client";
import { PhysicalDeliveryTermsTable } from "@/components/physical-delivery-terms-table";

const route = createStaticSlugRoute({
  paramKey: "peg",
  pages: PEG_TAXONOMY_PAGES,
  pageBySlug: PEG_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Peg Currency Not Found",
  ogImage: "/og-stablecoins.png",
  render: (page) => (
    <StablecoinTaxonomyShell
      title={page.title}
      href={page.href}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: page.title, url: page.href },
      ]}
      description={page.description}
      aboutParagraphs={[page.intro, page.riskSummary]}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse all ${page.coins.length} tracked ${page.shortLabel} stablecoins by profile.`}
      definedTermCode={String(page.value)}
      definedTermSetHref="/stablecoins/"
      relatedPages={ALL_STABLECOIN_TAXONOMY_PAGES.slice(0, 6)}
      headerActions={
        <TaxonomyHeaderActions
          shortLabel={page.shortLabel}
          topCoinIds={page.topCoins.map((coin) => coin.id)}
          bucketNoun="currency bucket"
        />
      }
    >
      <PegLandingClient pegCurrency={page.value} />
      <PhysicalDeliveryTermsTable pegCurrency={page.value} coins={page.coins} />
    </StablecoinTaxonomyShell>
  ),
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
