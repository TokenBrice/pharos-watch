import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStablecoinCharts = createCacheHandler("stablecoin-charts", "stablecoin-charts", CACHE_PROFILES.standard, 600);
