import {
  INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { createStablecoinTaxonomyRoute } from "../../taxonomy-page";

const route = createStablecoinTaxonomyRoute({
  paramKey: "infrastructure",
  pages: INFRASTRUCTURE_TAXONOMY_PAGES,
  pageBySlug: INFRASTRUCTURE_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Infrastructure Cohort Not Found",
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
