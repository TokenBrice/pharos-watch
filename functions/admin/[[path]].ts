import { resolveOpsUiOrigin } from "../lib/ops-origin";

interface AdminHostGateEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
  OPS_UI_ORIGIN?: string;
}

export const onRequest = async ({ request, env }: { request: Request; env: AdminHostGateEnv }) => {
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== resolveOpsUiOrigin(env)) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  return env.ASSETS.fetch(request);
};
