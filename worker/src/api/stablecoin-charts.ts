import { createCacheHandler } from "../lib/api-utils";

export const handleStablecoinCharts = createCacheHandler("stablecoin-charts", "stablecoin-charts", "public, s-maxage=300, max-age=60", 600);
