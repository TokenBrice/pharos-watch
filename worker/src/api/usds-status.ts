import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleUsdsStatus = createCacheHandler("usds-status", "usds-status", CACHE_PROFILES.standard, 86400);
