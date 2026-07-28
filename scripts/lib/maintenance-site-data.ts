import { PAGES_APP_ORIGIN, SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { toSiteDataPath } from "@shared/lib/site-data-lane";

export const DEFAULT_MAINTENANCE_SITE_DATA_BASE_URL = PAGES_APP_ORIGIN;

export function buildMaintenanceSiteDataRequest(
  apiPath: string,
  baseUrl = DEFAULT_MAINTENANCE_SITE_DATA_BASE_URL,
): { url: string; headers: Record<string, string> } {
  return {
    url: new URL(toSiteDataPath(apiPath), `${baseUrl.replace(/\/+$/, "")}/`).toString(),
    headers: {
      accept: "application/json",
      Origin: SITE_ORIGIN,
    },
  };
}
