import { resolveSiteDataProxyPath } from "@shared/lib/site-data-lane";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { PUBLIC_API_ACCEPT } from "@/lib/api-request-policy";
import { getSiteDataBootstrapPolicy } from "@/lib/api-url";
import { startDataBootstrap, type DataBootstrapConfig } from "@/lib/data-bootstrap";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/lib/request-lifecycle";

/** Build-only manifest; no validators or descriptor modules go into the inline script. */
export function getHomepageDataBootstrapScript(): string {
  return getDataBootstrapScript("/", [
    FRONTEND_API_QUERY_DESCRIPTORS.homepageSnapshot,
    FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndex,
  ]);
}

/** Called only for the live-enabled, registry-resolved detail route. */
export function getStablecoinDetailDataBootstrapScript(id: string): string {
  return getDataBootstrapScript(buildStablecoinUrl(id), [
    FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(id),
  ]);
}

function getDataBootstrapScript(route: string, descriptors: { path: string; queryKey: readonly unknown[] }[]): string {
  const config: DataBootstrapConfig = {
    route,
    requests: descriptors.flatMap((descriptor) => {
      const url = resolveSiteDataProxyPath(descriptor.path, "GET");
      return url ? [{ key: JSON.stringify(descriptor.queryKey), url }] : [];
    }),
    accept: PUBLIC_API_ACCEPT,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    handoffMs: DEFAULT_REQUEST_TIMEOUT_MS * 2,
    policy: getSiteDataBootstrapPolicy(),
  };
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `(${startDataBootstrap.toString()})(${serialized});`;
}
