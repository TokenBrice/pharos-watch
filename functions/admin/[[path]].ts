import { rejectIfNotOpsUiOrigin } from "../lib/ops-origin";

interface AdminHostGateEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
  OPS_UI_ORIGIN?: string;
}

function withNoindex(response: Response): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("X-Robots-Tag", "noindex, nofollow");
  return wrapped;
}

export const onRequest = async ({ request, env }: { request: Request; env: AdminHostGateEnv }) => {
  const rejected = rejectIfNotOpsUiOrigin(request, env, () => new Response("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow",
      },
    }));
  if (rejected) {
    return rejected;
  }

  return withNoindex(await env.ASSETS.fetch(request));
};
