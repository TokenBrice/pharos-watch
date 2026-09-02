import { STABLECOIN_TAXONOMY_HUB_ROUTES } from "@/lib/stablecoin-taxonomy";
import { createStablecoinTaxonomyHubRoute } from "../taxonomy-page";

const route = createStablecoinTaxonomyHubRoute(STABLECOIN_TAXONOMY_HUB_ROUTES.backing);

export const metadata = route.metadata;
export default route.Page;
