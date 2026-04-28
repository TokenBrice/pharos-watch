import type { Metadata } from "next";
import { StablecoinTaxonomyHub } from "@/components/stablecoin-taxonomy-hub";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  getStablecoinTaxonomyHubBreadcrumbItems,
  getStablecoinTaxonomyHubTotal,
  type StablecoinTaxonomyHubRouteConfig,
} from "@/lib/stablecoin-taxonomy";

export function buildStablecoinTaxonomyHubMetadata(route: StablecoinTaxonomyHubRouteConfig): Metadata {
  const total = getStablecoinTaxonomyHubTotal(route);

  return buildPageMetadata({
    title: route.title,
    description: route.description(total),
    canonical: route.path,
  });
}

export function createStablecoinTaxonomyHubPage(route: StablecoinTaxonomyHubRouteConfig) {
  return function StablecoinTaxonomyHubPage() {
    return (
      <StablecoinTaxonomyHub
        breadcrumbName={route.breadcrumbName}
        path={route.path}
        breadcrumbItems={getStablecoinTaxonomyHubBreadcrumbItems(route)}
        title={route.title}
        leadParagraphs={route.leadParagraphs}
        itemListName={route.itemListName}
        pages={route.pages}
      />
    );
  };
}
