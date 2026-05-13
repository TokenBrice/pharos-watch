import { noindexTextNotFoundResponse, withNoindex } from "../lib/noindex";
import { rejectIfNotOpsUiOrigin } from "../lib/ops-origin";

interface AdminApiHostGateEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
  OPS_UI_ORIGIN?: string;
}

export const onRequest = async ({ request, env }: { request: Request; env: AdminApiHostGateEnv }) => {
  const rejected = rejectIfNotOpsUiOrigin(request, env, noindexTextNotFoundResponse);
  if (rejected) {
    return rejected;
  }

  return withNoindex(await env.ASSETS.fetch(request));
};
