import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStablecoins = createCacheHandler("stablecoins", "stablecoins", CACHE_PROFILES.realtime, 600);
