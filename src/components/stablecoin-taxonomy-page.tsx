import type { BackingType, GovernanceType } from "@shared/types";
import { StablecoinFilteredTable } from "@/components/stablecoin-filtered-table";
import { StablecoinTaxonomyShell } from "@/components/stablecoin-taxonomy-shell";
import type { InfrastructureTaxonomyValue, StablecoinTaxonomyPage as StablecoinTaxonomyPageConfig } from "@/lib/stablecoin-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES } from "@/lib/stablecoin-taxonomy";

interface StablecoinTaxonomyPageProps {
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | InfrastructureTaxonomyValue>;
}

export function StablecoinTaxonomyPage({ page }: StablecoinTaxonomyPageProps) {
  const relatedPages = ALL_STABLECOIN_TAXONOMY_PAGES.filter((candidate) => candidate.href !== page.href).slice(0, 6);
  const parentName =
    page.kind === "backing"
      ? "Backing"
      : page.kind === "governance"
        ? "Governance"
        : "Infrastructure";

  return (
    <StablecoinTaxonomyShell
      title={page.title}
      href={page.href}
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Stablecoins", url: "/stablecoins/" },
        { name: parentName, url: `/stablecoins/${page.kind}/` },
        { name: page.title, url: page.href },
      ]}
      description={page.description}
      intro={page.intro}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse the current ${page.coins.length} tracked stablecoin${page.coins.length !== 1 ? "s" : ""} in this taxonomy before opening the live table.`}
      definedTermCode={String(page.filterTag)}
      definedTermSetHref={`/stablecoins/${page.kind}/`}
      relatedPages={relatedPages}
    >
      <StablecoinFilteredTable activeFilters={[page.filterTag]} />
    </StablecoinTaxonomyShell>
  );
}
