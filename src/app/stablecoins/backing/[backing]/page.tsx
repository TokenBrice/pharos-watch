import { StablecoinTaxonomyPage } from "@/components/stablecoin-taxonomy-page";
import {
  BACKING_TAXONOMY_PAGE_BY_SLUG,
  BACKING_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { createStaticSlugRoute } from "@/lib/static-slug-page";

const route = createStaticSlugRoute({
  paramKey: "backing",
  pages: BACKING_TAXONOMY_PAGES,
  pageBySlug: BACKING_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Backing Type Not Found",
  render: (page) => <StablecoinTaxonomyPage page={page} />,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
