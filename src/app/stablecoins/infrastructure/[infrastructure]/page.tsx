import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";

const route = createStaticSlugRoute({
  paramKey: "infrastructure",
  pages: INFRASTRUCTURE_TAXONOMY_PAGES,
  pageBySlug: INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Infrastructure Cohort Not Found",
  render: (page) => <StablecoinTaxonomyPage page={page} />,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
