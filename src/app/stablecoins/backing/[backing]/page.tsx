import {
  BACKING_TAXONOMY_PAGE_BY_SLUG,
  BACKING_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { createStablecoinTaxonomyRoute } from "../../taxonomy-page";

const route = createStablecoinTaxonomyRoute({
  paramKey: "backing",
  pages: BACKING_TAXONOMY_PAGES,
  pageBySlug: BACKING_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Backing Type Not Found",
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
