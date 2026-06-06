import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  GOVERNANCE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";

const route = createStaticSlugRoute({
  paramKey: "governance",
  pages: GOVERNANCE_TAXONOMY_PAGES,
  pageBySlug: GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Governance Type Not Found",
  ogImage: "/og-stablecoins.png",
  render: (page) => <StablecoinTaxonomyPage page={page} />,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
