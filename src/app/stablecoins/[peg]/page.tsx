import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import { PEG_TAXONOMY_PAGES, PEG_TAXONOMY_PAGE_BY_SLUG } from "@/lib/peg-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { PegLandingClient } from "./client";

const route = createStaticSlugRoute({
  paramKey: "peg",
  pages: PEG_TAXONOMY_PAGES,
  pageBySlug: PEG_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Peg Currency Not Found",
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
      directoryDescription={`Browse all ${page.coins.length} tracked ${page.shortLabel} stablecoins before opening the live table.`}
      definedTermCode={String(page.value)}
      definedTermSetHref="/stablecoins/"
      relatedPages={ALL_STABLECOIN_TAXONOMY_PAGES.slice(0, 6)}
    >
      <PegLandingClient pegCurrency={page.value} />
    </StablecoinTaxonomyShell>
  ),
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
