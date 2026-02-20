import { createCacheHandler } from "../lib/api-utils";

export const handleStablecoins = createCacheHandler("stablecoins", "stablecoins", "public, s-maxage=60, max-age=10", 600);
