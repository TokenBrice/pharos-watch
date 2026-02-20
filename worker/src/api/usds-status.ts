import { createCacheHandler } from "../lib/api-utils";

export const handleUsdsStatus = createCacheHandler("usds-status", "usds-status", "public, s-maxage=300, max-age=60", 86400);
