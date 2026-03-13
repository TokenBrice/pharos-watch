const DEFAULT_OPS_UI_ORIGIN = "https://ops.pharos.watch";

interface StatusHostGateEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
  OPS_UI_ORIGIN?: string;
}

function normalizeOrigin(input: string): string {
  const normalized = input.includes("://") ? input : `https://${input}`;
  return new URL(normalized).origin;
}

function resolveOpsUiOrigin(env: StatusHostGateEnv): string {
  return normalizeOrigin(env.OPS_UI_ORIGIN?.trim() || DEFAULT_OPS_UI_ORIGIN);
}

export const onRequest = async ({ request, env }: { request: Request; env: StatusHostGateEnv }) => {
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
