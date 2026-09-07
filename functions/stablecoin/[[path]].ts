import legacyRouteRedirects from "@shared/data/stablecoins/legacy-llama-redirects.generated.json";
import canonicalOrder from "@shared/data/stablecoins/canonical-order.json";
import { isCanonicalStablecoinId } from "@shared/lib/stablecoin-id";
import { setYieldWorkbenchFallbackParam } from "@shared/lib/yield-workbench-fallback";

interface StablecoinRouteEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
}

const KNOWN_STABLECOIN_IDS = new Set<string>(canonicalOrder);

function isRedirectDestination(value: string): boolean {
  const targetId = value.match(/^\/stablecoin\/([^/]+)\/$/)?.[1];
  return targetId != null
    ? KNOWN_STABLECOIN_IDS.has(targetId)
    : value === "/coverage/" || value === "/cemetery/";
}

export function resolveLegacyStablecoinRedirect(
  url: URL,
  redirects: Readonly<Record<string, string>> = legacyRouteRedirects,
): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "stablecoin" || !isCanonicalStablecoinId(parts[1])) return null;

  const destination = Object.hasOwn(redirects, parts[1]) ? redirects[parts[1]] : null;
  if (!destination || !isRedirectDestination(destination)) return null;

  const target = new URL(destination, url);
  target.search = url.search;
  return target.toString();
}

export function resolveMissingYieldWorkbenchRedirect(
  url: URL,
  assetStatus: number,
  knownStablecoinIds: ReadonlySet<string> = KNOWN_STABLECOIN_IDS,
): string | null {
  if (assetStatus !== 404) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 3
    || parts[0] !== "stablecoin"
    || parts[2] !== "yield"
    || !knownStablecoinIds.has(parts[1])
  ) {
    return null;
  }

  const target = new URL("/yield/", url);
  target.search = url.search;
  if (!target.searchParams.has("compare")) target.searchParams.set("compare", parts[1]);
  if (!target.searchParams.has("from")) target.searchParams.set("from", "detail-fallback");
  if (!setYieldWorkbenchFallbackParam(target.searchParams, parts[1])) return null;
  return target.toString();
}

export const onRequest = async ({ request, env }: { request: Request; env: StablecoinRouteEnv }) => {
  const url = new URL(request.url);

  if (request.method === "GET" || request.method === "HEAD") {
    const redirectTarget = resolveLegacyStablecoinRedirect(url);
    if (redirectTarget) {
      return Response.redirect(redirectTarget, 301);
    }
  }

  const assetResponse = await env.ASSETS.fetch(request);
  if (request.method === "GET" || request.method === "HEAD") {
    const redirectTarget = resolveMissingYieldWorkbenchRedirect(url, assetResponse.status);
    if (redirectTarget) {
      await assetResponse.body?.cancel();
      return Response.redirect(redirectTarget, 302);
    }
  }
  return assetResponse;
};
