import type { Metadata } from "next";
import { StablecoinTaxonomyHub } from "@/components/stablecoin-taxonomy-hub";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  STABLECOIN_TAXONOMY_HUB_ROUTES,
  getStablecoinTaxonomyHubBreadcrumbItems,
  getStablecoinTaxonomyHubTotal,
} from "@/lib/stablecoin-taxonomy";

const ROUTE = STABLECOIN_TAXONOMY_HUB_ROUTES.governance;
const TOTAL = getStablecoinTaxonomyHubTotal(ROUTE);

export const metadata: Metadata = buildPageMetadata({
  title: ROUTE.title,
  description: ROUTE.description(TOTAL),
  canonical: ROUTE.path,
});

export default function StablecoinGovernanceHubPage() {
  return (
    <StablecoinTaxonomyHub
      breadcrumbName={ROUTE.breadcrumbName}
      path={ROUTE.path}
      breadcrumbItems={getStablecoinTaxonomyHubBreadcrumbItems(ROUTE)}
      title={ROUTE.title}
      leadParagraphs={ROUTE.leadParagraphs}
      itemListName={ROUTE.itemListName}
      pages={ROUTE.pages}
    />
  );
}
