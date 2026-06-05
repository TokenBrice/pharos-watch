import {
  addNonceToInlineScripts,
  buildContentSecurityPolicy,
  createCspNonce,
} from "@shared/lib/site-csp";
import { noindexTextNotFoundResponse, withNoindex } from "./noindex";
import { rejectIfNotOpsUiOrigin } from "./ops-origin";

export interface OpsAssetHostGateEnv {
  ASSETS: {
    fetch: typeof fetch;
  };
  OPS_UI_ORIGIN?: string;
}

function isHtmlResponse(response: Response): boolean {
  return response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
}

async function withOpsHtmlCsp(response: Response, method: string): Promise<Response> {
  if (!isHtmlResponse(response)) return response;

  const nonce = createCspNonce();
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.delete("Content-Length");

  if (method === "HEAD") {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(addNonceToInlineScripts(await response.text(), nonce), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

  return withNoindex(await withOpsHtmlCsp(await env.ASSETS.fetch(request), request.method));
}
