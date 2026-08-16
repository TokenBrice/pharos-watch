import legacyLlamaRedirects from "@shared/data/stablecoins/legacy-llama-redirects.generated.json";
import canonicalOrder from "@shared/data/stablecoins/canonical-order.json";
import { isCanonicalStablecoinId } from "@shared/lib/stablecoin-id";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { setYieldWorkbenchFallbackParam } from "@shared/lib/yield-workbench-fallback";

interface StablecoinRouteEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
}

function isLegacyLlamaId(value: string): boolean {
  return value.length > 0 && Array.from(value).every((char) => char >= "0" && char <= "9");
}

function buildLegacyLlamaRedirects(raw: unknown): Readonly<Record<string, string>> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn("[stablecoin-redirect] Legacy redirect map is not an object");
    return {};
  }

  const entries: Array<[string, string]> = [];
  for (const [legacyId, coinId] of Object.entries(raw)) {
    if (!isLegacyLlamaId(legacyId) || typeof coinId !== "string" || !isCanonicalStablecoinId(coinId)) {
      console.warn(`[stablecoin-redirect] Ignoring invalid legacy redirect entry for ${legacyId}`);
      continue;
    }
    entries.push([legacyId, coinId]);
  }

  return Object.freeze(Object.fromEntries(entries));
}

const LEGACY_LLAMA_REDIRECTS = buildLegacyLlamaRedirects(legacyLlamaRedirects);
const KNOWN_STABLECOIN_IDS = new Set<string>(canonicalOrder);

export function resolveLegacyStablecoinRedirect(
  url: URL,
  redirects: Readonly<Record<string, string>> = LEGACY_LLAMA_REDIRECTS,
): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "stablecoin" || !isLegacyLlamaId(parts[1])) return null;

  const coinId = redirects[parts[1]];
  if (!coinId) return null;
  if (!isCanonicalStablecoinId(coinId)) return null;

  const target = new URL(buildStablecoinUrl(coinId), url);
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
