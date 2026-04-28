import type { Metadata } from "next";
import { STABLECOIN_TAXONOMY_HUB_ROUTES } from "@/lib/stablecoin-taxonomy";
import { buildStablecoinTaxonomyHubMetadata, createStablecoinTaxonomyHubPage } from "../taxonomy-page";

const ROUTE = STABLECOIN_TAXONOMY_HUB_ROUTES.infrastructure;

export const metadata: Metadata = buildStablecoinTaxonomyHubMetadata(ROUTE);

const StablecoinInfrastructureHubPage = createStablecoinTaxonomyHubPage(ROUTE);

export default StablecoinInfrastructureHubPage;
