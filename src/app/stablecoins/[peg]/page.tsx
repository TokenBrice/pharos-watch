import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import { TaxonomyNextCheckCta } from "@/components/taxonomy-next-check-cta";
import { PEG_TAXONOMY_PAGES, PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { PegLandingClient } from "./client";

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
      intro={page.intro}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse all ${page.coins.length} tracked ${page.shortLabel} stablecoins before opening the live table. ${page.contextSummary} ${page.riskSummary}`}
      definedTermCode={String(page.value)}
      definedTermSetHref="/stablecoins/"
      relatedPages={ALL_STABLECOIN_TAXONOMY_PAGES.slice(0, 6)}
    >
      <TaxonomyNextCheckCta
        shortLabel={page.shortLabel}
        topCoinIds={page.topCoins.map((coin) => coin.id)}
        bucketNoun="currency bucket"
      />
      <PegLandingClient pegCurrency={page.value} />
    </StablecoinTaxonomyShell>
  ),
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
