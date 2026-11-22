import type { BackingType } from "@shared/types/core";
import type { GovernanceType } from "@shared/types/stablecoin-taxonomy";
import { StablecoinFilteredTable } from "@/components/stablecoin-directory/stablecoin-filtered-table";
import { StablecoinTaxonomyShell } from "@/components/taxonomy/stablecoin-taxonomy-shell";
import { TaxonomyHeaderActions } from "@/components/taxonomy/taxonomy-header-actions";
import type { InfrastructureTaxonomyValue, StablecoinTaxonomyPage as StablecoinTaxonomyPageConfig } from "@/lib/stablecoin-taxonomy";
import { ALL_STABLECOIN_TAXONOMY_PAGES, getTopCohortCoinIds } from "@/lib/stablecoin-taxonomy";

interface StablecoinTaxonomyPageProps {
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | InfrastructureTaxonomyValue>;
}

function buildAxisAwareRelatedPages(
  page: StablecoinTaxonomyPageConfig<BackingType | GovernanceType | InfrastructureTaxonomyValue>,
  limit = 6,
) {
  const siblings = ALL_STABLECOIN_TAXONOMY_PAGES.filter(
    (candidate) => candidate.kind === page.kind && candidate.href !== page.href,
  );
  const otherAxes = (["backing", "governance", "infrastructure"] as const)
    .filter((kind) => kind !== page.kind)
    .map((kind) => ALL_STABLECOIN_TAXONOMY_PAGES.filter((candidate) => candidate.kind === kind));

  const crossAxis: typeof siblings = [];
  const maxDepth = Math.max(0, ...otherAxes.map((group) => group.length));
  for (let index = 0; index < maxDepth; index++) {
    for (const group of otherAxes) {
      if (group[index]) crossAxis.push(group[index]);
    }
  }

  return [...siblings, ...crossAxis].slice(0, limit);
}

export function StablecoinTaxonomyPage({ page }: StablecoinTaxonomyPageProps) {
  const relatedPages = buildAxisAwareRelatedPages(page, 6);
  const parentName =
    page.kind === "backing"
      ? "Backing"
      : page.kind === "governance"
        ? "Governance"
        : "Infrastructure";
  const bucketNoun =
    page.kind === "backing"
      ? "backing model"
      : page.kind === "governance"
        ? "governance model"
        : "infrastructure profile";

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
      aboutParagraphs={[page.intro]}
      shortLabel={page.shortLabel}
      coins={page.coins}
      directoryDescription={`Browse the current ${page.coins.length} tracked stablecoin${page.coins.length !== 1 ? "s" : ""} in this taxonomy by profile.`}
      definedTermCode={String(page.filterTag)}
      definedTermSetHref={`/stablecoins/${page.kind}/`}
      relatedPages={relatedPages}
      headerActions={
        <TaxonomyHeaderActions
          shortLabel={page.shortLabel}
          topCoinIds={getTopCohortCoinIds(page.coins)}
          bucketNoun={bucketNoun}
        />
      }
    >
      <StablecoinFilteredTable activeFilters={[page.filterTag]} />
    </StablecoinTaxonomyShell>
  );
}
