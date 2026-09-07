import { StablecoinTaxonomyHub } from "@/components/stablecoin-taxonomy-hub";
import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import {
  getStablecoinTaxonomyHubBreadcrumbItems,
  getStablecoinTaxonomyHubTotal,
  type StablecoinTaxonomyHubRouteConfig,
} from "@/lib/stablecoin-taxonomy";

export function createStablecoinTaxonomyHubRoute(route: StablecoinTaxonomyHubRouteConfig) {
  const metadata = buildPageMetadata({
    title: route.title,
    description: route.description(getStablecoinTaxonomyHubTotal(route)),
    canonical: route.path,
  });

  function Page() {
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
  }

  return { metadata, Page };
}

type TaxonomyPage = StablecoinTaxonomyHubRouteConfig["pages"][number];

export function createStablecoinTaxonomyRoute<TParamKey extends string>(config: {
  paramKey: TParamKey;
  pages: ReadonlyArray<TaxonomyPage>;
  pageBySlug: ReadonlyMap<string, TaxonomyPage>;
  missingTitle: string;
}) {
  return createStaticSlugRoute({
    ...config,
    ogImage: "/og-stablecoins.png",
    render: (page) => <StablecoinTaxonomyPage page={page} />,
  });
}
