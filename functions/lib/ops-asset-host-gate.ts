import { injectHtmlCsp } from "./csp-inject";
import { noindexTextNotFoundResponse, withNoindex } from "./noindex";
import { rejectIfNotOpsUiOrigin } from "./ops-origin";

export interface OpsAssetHostGateEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
  OPS_UI_ORIGIN?: string;
}

export async function serveOpsAssetWithHostGate({
  request,
  env,
}: {
  request: Request;
  env: OpsAssetHostGateEnv;
}): Promise<Response> {
  const rejected = rejectIfNotOpsUiOrigin(request, env, noindexTextNotFoundResponse);
  if (rejected) {
    return rejected;
  }

  return withNoindex(
    await injectHtmlCsp(await env.ASSETS.fetch(request), { method: request.method }),
  );
}
