import legacyLlamaRedirects from "@shared/data/stablecoins/legacy-llama-redirects.generated.json";

interface StablecoinRouteEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
}

const LEGACY_ID_RE = /^\d+$/;
const STABLECOIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function buildLegacyLlamaRedirects(raw: unknown): Readonly<Record<string, string>> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn("[stablecoin-redirect] Legacy redirect map is not an object");
    return {};
  }

  const entries: Array<[string, string]> = [];
  for (const [legacyId, coinId] of Object.entries(raw)) {
    if (!LEGACY_ID_RE.test(legacyId) || typeof coinId !== "string" || !STABLECOIN_ID_RE.test(coinId)) {
      console.warn(`[stablecoin-redirect] Ignoring invalid legacy redirect entry for ${legacyId}`);
      continue;
    }
    entries.push([legacyId, coinId]);
  }

  return Object.freeze(Object.fromEntries(entries));
}

const LEGACY_LLAMA_REDIRECTS = buildLegacyLlamaRedirects(legacyLlamaRedirects);

export function resolveLegacyStablecoinRedirect(
  url: URL,
  redirects: Readonly<Record<string, string>> = LEGACY_LLAMA_REDIRECTS,
): string | null {
  const match = url.pathname.match(/^\/stablecoin\/(\d+)\/?$/);
  if (!match) return null;

  const coinId = redirects[match[1]];
  if (!coinId) return null;
  if (!STABLECOIN_ID_RE.test(coinId)) return null;

  const target = new URL(`/stablecoin/${coinId}/`, url);
  target.search = url.search;
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

  return env.ASSETS.fetch(request);
};
