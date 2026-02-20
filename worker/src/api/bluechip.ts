import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleBluechipRatings = createCacheHandler("bluechip-ratings", "bluechip-ratings", CACHE_PROFILES.slow, 43200);
