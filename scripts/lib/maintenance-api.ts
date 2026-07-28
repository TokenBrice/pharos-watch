import { API_ORIGIN } from "@shared/lib/runtime-origins";

export const DEFAULT_MAINTENANCE_API_BASE_URL = API_ORIGIN;

export function buildMaintenanceApiRequest(
  apiPath: string,
  apiKey: string | null | undefined,
  baseUrl = DEFAULT_MAINTENANCE_API_BASE_URL,
): { url: string; headers: Record<string, string> } {
  const credential = apiKey?.trim();
  if (!credential) {
    throw new Error("PHAROS_API_KEY is required for live maintenance API requests");
  }

  return {
    url: new URL(apiPath, `${baseUrl.replace(/\/+$/, "")}/`).toString(),
    headers: {
      accept: "application/json",
      "X-API-Key": credential,
    },
  };
}
