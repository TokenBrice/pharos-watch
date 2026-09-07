import {
  GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  GOVERNANCE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";
import { createStablecoinTaxonomyRoute } from "../../taxonomy-page";

const route = createStablecoinTaxonomyRoute({
  paramKey: "governance",
  pages: GOVERNANCE_TAXONOMY_PAGES,
  pageBySlug: GOVERNANCE_TAXONOMY_PAGE_BY_SLUG,
  missingTitle: "Governance Type Not Found",
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
