import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

interface StablecoinRouteEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
}

const TRACKED_BY_LLAMA_ID = new Map(
  TRACKED_STABLECOINS.flatMap((coin) => (coin.llamaId ? [[coin.llamaId, coin]] : [])),
);

function resolveLegacyStablecoinRedirect(url: URL): string | null {
  const match = url.pathname.match(/^\/stablecoin\/(\d+)\/?$/);
  if (!match) return null;

  const coin = TRACKED_BY_LLAMA_ID.get(match[1]);
  if (!coin) return null;

  const target = new URL(`/stablecoin/${coin.id}/`, url);
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
