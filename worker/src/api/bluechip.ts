import { createCacheHandler } from "../lib/api-utils";

export const handleBluechipRatings = createCacheHandler("bluechip-ratings", "bluechip-ratings", "public, s-maxage=3600, max-age=300", 43200);
