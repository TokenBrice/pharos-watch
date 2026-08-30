import { buildProxyResponse, buildUpstreamHeaders, jsonError } from "./lib/proxy-utils";
import { hashClientIp } from "./lib/client-ip-hash";
import { rejectIfNotSiteDataUiOrigin } from "./lib/site-data-origin";
import {
  createProxyRequest,
  rejectInvalidProxyEnvironment,
  runPagesProxy,
  type PagesProxyContext,
} from "./lib/pages-proxy-harness";
import { resolveSiteApiOrigin, validatePagesSiteDataProxyEnv, type SiteDataProxyEnv } from "./lib/site-api-env";

const TELEGRAM_ADOPTION_API_PATH = "/api/telegram-adoption";
const TELEGRAM_ADOPTION_CLIENT_HASH_HEADER = "X-Pharos-Telegram-Adoption-Client-Hash";
const FORWARDED_REQUEST_HEADERS = ["Content-Type", "Origin", "Referer"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "Cache-Control",
  "Content-Type",
  "X-Analytics-Quality",
  "X-Content-Type-Options",
] as const;

interface TelegramAdoptionPagesEnv extends SiteDataProxyEnv {
  TELEGRAM_ADOPTION_IP_HASH_SECRET?: string;
}

interface TelegramAdoptionPagesContext {
  request: Request;
  env: TelegramAdoptionPagesEnv;
}

type TelegramAdoptionProxyContext = PagesProxyContext<TelegramAdoptionPagesEnv, Record<string, never>>;

function response(status: number, body: string | null = null, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function getClientIpHash(request: Request, env: TelegramAdoptionPagesEnv): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  const secret = env.TELEGRAM_ADOPTION_IP_HASH_SECRET?.trim();
  if (!ip || !secret) return null;
  return hashClientIp(ip, secret);
}

export const onRequest = async (context: TelegramAdoptionPagesContext): Promise<Response> => {
  // Deploy the Worker route before this Pages shim; the Pages release removes
  // the old direct D1 write only after the additive Worker endpoint is live.
  let clientIpHash: string | null = null;
  const proxyContext: TelegramAdoptionProxyContext = { ...context, params: {} };

  return runPagesProxy(proxyContext, {
    logPrefix: "telegram-adoption-proxy",
    rejectRequest: ({ request, env }) => {
      if (request.method !== "POST") return response(405, null, { Allow: "POST" });
      return rejectIfNotSiteDataUiOrigin(request, env, () => response(404));
    },
    validateEnv: ({ env }) => {
      const issues = validatePagesSiteDataProxyEnv(env);
      return rejectInvalidProxyEnvironment({
        issues: issues.filter((issue) => issue.code !== "site-data-db-missing"),
        fatalCodes: ["site-api-origin-missing", "site-api-origin-invalid", "site-api-secret-missing"],
        logPrefix: "telegram-adoption-proxy",
        publicMessage: "Site API proxy is not configured",
      });
    },
    resolveUpstreamPath: () => TELEGRAM_ADOPTION_API_PATH,
    beforeFetch: async ({ request, env }) => {
      clientIpHash = await getClientIpHash(request, env);
      return clientIpHash ? null : response(503);
    },
    buildUpstreamRequest: ({ request, env }, upstreamPath) => {
      const upstreamOrigin = resolveSiteApiOrigin(env);
      const secret = env.SITE_API_SHARED_SECRET?.trim() ?? "";
      if (!upstreamOrigin || !secret || !clientIpHash) {
        return jsonError(500, "Site API proxy is not configured");
      }

      const headers = buildUpstreamHeaders(request, FORWARDED_REQUEST_HEADERS, {
        "X-Pharos-Site-Proxy-Secret": secret,
        [TELEGRAM_ADOPTION_CLIENT_HASH_HEADER]: clientIpHash,
      });
      return createProxyRequest({
        request,
        origin: upstreamOrigin,
        path: upstreamPath,
        method: "POST",
        headers,
        body: request.body,
        label: "Telegram adoption",
      });
    },
    buildResponse: (_proxyContext, _upstreamPath, upstreamResponse) =>
      buildProxyResponse(upstreamResponse, FORWARDED_RESPONSE_HEADERS),
  });
};
