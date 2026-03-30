import type { BackingType, GovernanceType } from "@shared/types";
import { StablecoinFilteredTable } from "@/components/stablecoin-filtered-table";
import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import type { ProtocolTaxonomyValue, StablecoinTaxonomyPage as StablecoinTaxonomyPageConfig } from "@/lib/stablecoin-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

interface StablecoinTaxonomyPageProps {
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | ProtocolTaxonomyValue>;
}

export function StablecoinTaxonomyPage({ page }: StablecoinTaxonomyPageProps) {
  const relatedPages = ALL_STABLECOIN_TAXONOMY_PAGES.filter((candidate) => candidate.href !== page.href).slice(0, 6);

  return (
    <StablecoinTaxonomyShell
      title={page.title}
      href={page.href}
      description={page.description}
      intro={page.intro}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse the current ${page.coins.length} tracked stablecoin${page.coins.length !== 1 ? "s" : ""} in this taxonomy before opening the live table.`}
      relatedPages={relatedPages}
    >
      <StablecoinFilteredTable activeFilters={[page.filterTag]} />
    </StablecoinTaxonomyShell>
  );
}
