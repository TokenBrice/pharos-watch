import { resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import {
  SITE_DATA_ALLOWED_METHOD,
  SITE_DATA_PROXY_SECRET_HEADER,
  isSiteDataAllowedMethod,
  resolveSiteDataUpstreamPath,
} from "@shared/lib/site-data-lane";
import {
  jsonError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../lib/proxy-utils";
import { isRequestSourceAttributionDisabled, recordSiteDataRequest } from "../lib/request-attribution";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";
import { resolveSiteApiOrigin, validatePagesSiteDataProxyEnv, type SiteDataProxyEnv } from "../lib/site-api-env";
import {
  createProxyRequest,
  rejectInvalidProxyEnvironment,
  runPagesProxy,
  type PagesProxyContext,
} from "../lib/pages-proxy-harness";
import { resolveSiteDataRequestedPath } from "../lib/proxy-paths";

const FORWARDED_REQUEST_HEADERS = ["Accept", "If-None-Match", "If-Modified-Since"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "Age",
  "Cache-Control",
  "Content-Type",
  "Date",
  "ETag",
  "Last-Modified",
  "Warning",
  "X-Data-Age",
  "X-Content-Type-Options",
  "Strict-Transport-Security",
  "Referrer-Policy",
  "Content-Security-Policy",
  "Vary",
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Expose-Headers",
  "Access-Control-Max-Age",
] as const;

type SiteDataProxyContext = PagesProxyContext<SiteDataProxyEnv>;

function methodNotAllowed(): Response {
  return jsonError(405, "Method not allowed", { Allow: SITE_DATA_ALLOWED_METHOD });
}

function buildUpstreamHeaders(request: Request, env: SiteDataProxyEnv): Headers {
  const secret = env.SITE_API_SHARED_SECRET?.trim() ?? "";
  return buildUpstreamHeadersShared(request, FORWARDED_REQUEST_HEADERS, {
    [SITE_DATA_PROXY_SECRET_HEADER]: secret,
  });
}

function buildProxyResponse(upstreamResponse: Response): Response {
  return buildProxyResponseShared(upstreamResponse, FORWARDED_RESPONSE_HEADERS);
}

async function queueSiteDataTelemetry(
  context: SiteDataProxyContext,
  upstreamPath: string,
  deliveryPath: "pages-upstream-fetch" | "pages-upstream-timeout" | "pages-upstream-error",
  upstreamLane: "" | "site-api" = "",
): Promise<void> {
  if (isRequestSourceAttributionDisabled(context.env)) {
    return;
  }

  const route = resolveApiRequestRouteMetric(upstreamPath);
  if (!context.env.DB) {
    return;
  }

  if (!route) {
    console.warn(`[site-data-proxy] Attribution route unavailable for ${upstreamPath}`);
    return;
  }

  const promise = recordSiteDataRequest(context.env.DB, route, deliveryPath, upstreamLane).catch((error: unknown) => {
    console.warn("[site-data-proxy] Failed to record site-data attribution:", error);
  });
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
    return;
  }

  await promise;
}

export const onRequest = async (context: SiteDataProxyContext): Promise<Response> =>
  runPagesProxy(context, {
    logPrefix: "site-data-proxy",
    rejectRequest: ({ request, env }) => {
      const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
      if (rejected) {
        return rejected;
      }

      return isSiteDataAllowedMethod(request.method) ? null : methodNotAllowed();
    },
    validateEnv: ({ env }) => {
      return rejectInvalidProxyEnvironment({
        issues: validatePagesSiteDataProxyEnv(env),
        fatalCodes: ["site-api-origin-missing", "site-api-origin-invalid", "site-api-secret-missing"],
        logPrefix: "site-data-proxy",
        publicMessage: "Site API proxy is not configured",
      });
    },
    resolveUpstreamPath: ({ params }) => {
      const requestedPath = resolveSiteDataRequestedPath(params);
      return requestedPath ? resolveSiteDataUpstreamPath(requestedPath) : null;
    },
    rejectUpstreamPath: (_context, upstreamPath) => (upstreamPath ? null : jsonError(404, "Not found")),
    buildUpstreamRequest: ({ request, env }, upstreamPath) => {
      const upstreamHeaders = buildUpstreamHeaders(request, env);

      const upstreamOrigin = resolveSiteApiOrigin(env);
      if (!upstreamOrigin) {
        return jsonError(500, "Site API proxy is not configured");
      }

      return createProxyRequest({
        request,
        origin: upstreamOrigin,
        path: upstreamPath,
        search: new URL(request.url).search,
        method: "GET",
        headers: upstreamHeaders,
        label: "Site API",
      });
    },
    onFetchError: async (proxyContext, upstreamPath, errorKind, response) => {
      await queueSiteDataTelemetry(
        proxyContext,
        upstreamPath,
        errorKind === "timeout" ? "pages-upstream-timeout" : "pages-upstream-error",
        "site-api",
      );
      return response;
    },
    buildResponse: async (proxyContext, upstreamPath, upstreamResponse) => {
      const response = buildProxyResponse(upstreamResponse);
      await queueSiteDataTelemetry(proxyContext, upstreamPath, "pages-upstream-fetch", "site-api");
      return response;
    },
  });
