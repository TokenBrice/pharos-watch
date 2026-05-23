import legacyLlamaRedirects from "@shared/data/stablecoins/legacy-llama-redirects.generated.json";

interface StablecoinRouteEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
}

const LEGACY_LLAMA_REDIRECTS = legacyLlamaRedirects as Record<string, string>;

function resolveLegacyStablecoinRedirect(url: URL): string | null {
  const match = url.pathname.match(/^\/stablecoin\/(\d+)\/?$/);
  if (!match) return null;

  const coinId = LEGACY_LLAMA_REDIRECTS[match[1]];
  if (!coinId) return null;

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
