import { handleStablecoinDetail } from "./api/stablecoin-detail";
import { handleStablecoinSummary } from "./api/stablecoin-summary";
import { handleStablecoinReserves } from "./api/stablecoin-reserves";
import type { FeedbackEnv } from "./api/feedback";
import {
  getEndpointDefinition,
  validateEndpointMethod,
} from "@shared/lib/api-endpoints";
import type { MintBurnFreshnessConfig } from "./lib/mint-burn-health-config";
import type { TwitterCreds } from "./lib/twitter";
import type { TelegramCreds } from "./lib/telegram";

import { resolveOrReject, errorResponse } from "./lib/api-utils";
import { handleOg } from "./api/og";
import { handleDismissCandidate } from "./api/discovery";
import { withAdmin } from "./lib/auth";
import {
  STATIC_ROUTE_HANDLERS,
} from "./route-registry";

function addAdminGetNoStoreHeader(path: string, request: Request | undefined, response: Response): Response {
  if (request?.method !== "GET") return response;
  const endpoint = getEndpointDefinition(path);
  if (!endpoint?.adminRequired) return response;
  if (response.headers.get("Cache-Control") === "no-store") return response;
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function matchDynamicRoute(
  path: string,
  pattern: RegExp,
  handler: (db: D1Database, canonicalId: string, ctx: ExecutionContext) => Promise<Response>,
  db: D1Database,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const match = path.match(pattern);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return Promise.resolve(errorResponse(400, "Malformed URI"));
  }
  const resolved = resolveOrReject(id);
  if (resolved instanceof Response) {
    return Promise.resolve(resolved);
  }
  return handler(db, resolved.canonicalId, ctx);
}

export function route(
  url: URL,
  db: D1Database,
  ctx: ExecutionContext,
  request?: Request,
  adminKey?: string,
  alchemyApiKey?: string | null,
  mintBurnFreshnessConfig?: MintBurnFreshnessConfig,
  feedbackEnv?: FeedbackEnv,
  anthropicApiKey?: string | null,
  twitterCreds?: TwitterCreds | null,
  telegramCreds?: TelegramCreds | null,
  telegramWebhookSecret?: string,
  telegramBotToken?: string,
  trustedAdmin = false,
): Promise<Response> | null {
  const path = url.pathname;
  const methodValidation = validateEndpointMethod(url, request?.method ?? "GET");
  if (methodValidation) {
    const resp = errorResponse(405, methodValidation.message);
    resp.headers.set("Allow", methodValidation.allowedMethods.join(", "));
    return Promise.resolve(resp);
  }

  const staticHandler = STATIC_ROUTE_HANDLERS.get(path);
  if (staticHandler) {
    return staticHandler({
      url,
      db,
      ctx,
      request,
      adminKey,
      alchemyApiKey,
      mintBurnFreshnessConfig,
      feedbackEnv,
      anthropicApiKey,
      twitterCreds,
      telegramCreds,
      telegramWebhookSecret,
      telegramBotToken,
      trustedAdmin,
    }).then((response) => addAdminGetNoStoreHeader(path, request, response));
  }

  const summaryResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin-summary\/(.+)$/,
    (db, id) => handleStablecoinSummary(db, id),
    db,
    ctx,
  );
  if (summaryResult) return summaryResult;

  const reservesResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin-reserves\/(.+)$/,
    (db, id, _ctx) => handleStablecoinReserves(db, id),
    db,
    ctx,
  );
  if (reservesResult) return reservesResult;

  const detailResult = matchDynamicRoute(
    path,
    /^\/api\/stablecoin\/(.+)$/,
    (db, id, ctx) => handleStablecoinDetail(db, id, ctx),
    db,
    ctx,
  );
  if (detailResult) return detailResult;

  // Discovery candidate dismiss (dynamic :id route with admin auth)
  const dismissMatch = path.match(/^\/api\/discovery-candidates\/(\d+)\/dismiss$/);
  if (dismissMatch && request?.method === "POST") {
    const candidateId = parseInt(dismissMatch[1], 10);
    return withAdmin(request, () => handleDismissCandidate(db, candidateId), trustedAdmin);
  }

  // OG image generation (dynamic paths under /api/og/)
  if (path.startsWith("/api/og/")) {
    return handleOg(db, path).then((r) => r ?? errorResponse(404, "Unknown OG route"));
  }

  return null;
}

export { ROUTER_STATIC_PATHS } from "./route-registry";
