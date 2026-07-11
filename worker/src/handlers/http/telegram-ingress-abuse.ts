import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_HOSTNAME } from "@shared/lib/runtime-origins";
import { jsonResponse } from "../../lib/api-utils";
import { logWorkerEvent } from "../../lib/structured-log";

export type TelegramIngressRoute = "webhook" | "mini_app_session" | "mini_app_mutation";
export type TelegramIngressRejectionStatus = 400 | 401 | 413 | 429 | 503;

type TelegramIngressTelemetryStage = "body_header" | "rate_limit" | "body_stream" | "handler";
type TelegramIngressTelemetryReason =
  | "invalid_content_length"
  | "body_too_large"
  | "body_read_failed"
  | "preauth_rate_limited"
  | "rate_limit_unavailable"
  | "handler_bad_request"
  | "handler_unauthorized"
  | "handler_body_too_large"
  | "handler_rate_limited";

type TelegramIngressRateLimitBinding =
  | "TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT"
  | "TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT"
  | "TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT";

export interface TelegramIngressPolicy {
  route: TelegramIngressRoute;
  method: "POST";
  path: string;
  binding: TelegramIngressRateLimitBinding;
  rateLimit: number;
  periodSec: 60;
  bodyLimitBytes: number;
  rateLimitKey: string;
}

export const TELEGRAM_INGRESS_POLICIES = {
  webhook: {
    route: "webhook",
    method: "POST",
    path: API_PATHS.telegramWebhook(),
    binding: "TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT",
    rateLimit: 2_400,
    periodSec: 60,
    bodyLimitBytes: 128 * 1024,
    rateLimitKey: "telegram-webhook",
  },
  mini_app_session: {
    route: "mini_app_session",
    method: "POST",
    path: API_PATHS.telegramMiniAppSession(),
    binding: "TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT",
    rateLimit: 1_600,
    periodSec: 60,
    bodyLimitBytes: 16 * 1024,
    rateLimitKey: "telegram-mini-app-session",
  },
  mini_app_mutation: {
    route: "mini_app_mutation",
    method: "POST",
    path: API_PATHS.telegramMiniAppMutation(),
    binding: "TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT",
    rateLimit: 9_600,
    periodSec: 60,
    bodyLimitBytes: 16 * 1024,
    rateLimitKey: "telegram-mini-app-mutation",
  },
} as const satisfies Record<TelegramIngressRoute, TelegramIngressPolicy>;

const POLICIES_BY_PATH = new Map<string, TelegramIngressPolicy>(
  Object.values(TELEGRAM_INGRESS_POLICIES).map((policy) => [policy.path, policy]),
);

export interface TelegramIngressGateResult {
  request: Request;
  response: Response | null;
}

export interface TelegramIngressAbuseEnv {
  TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: RateLimit;
  TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: RateLimit;
  TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT: RateLimit;
}

function resolvePolicy(request: Request, url: URL): TelegramIngressPolicy | null {
  if (request.method !== "POST") return null;
  return POLICIES_BY_PATH.get(url.pathname) ?? null;
}

function resolveRateLimitKey(policy: TelegramIngressPolicy, url: URL): string {
  return url.hostname === API_HOSTNAME
    ? policy.rateLimitKey
    : `${policy.rateLimitKey}:noncanonical-host`;
}

function resolveRateLimiter(
  env: TelegramIngressAbuseEnv,
  binding: TelegramIngressRateLimitBinding,
): RateLimit | undefined {
  if (binding === "TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT") {
    return env.TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT;
  }
  if (binding === "TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT") {
    return env.TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT;
  }
  return env.TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT;
}

function logRejection(args: {
  policy: TelegramIngressPolicy;
  stage: TelegramIngressTelemetryStage;
  status: TelegramIngressRejectionStatus;
  reason: TelegramIngressTelemetryReason;
}): void {
  logWorkerEvent({
    scope: "http",
    level: "warn",
    event: "telegram_ingress_rejection",
    route: args.policy.route,
    source: "telegram-ingress",
    status: args.status,
    message: "Telegram ingress request rejected",
    metadata: {
      stage: args.stage,
      reason: args.reason,
    },
  });
}

function rejectionResponse(
  status: TelegramIngressRejectionStatus,
  message: string,
  code: string,
  retryAfterSec?: number,
): Response {
  return jsonResponse(
    { error: message, code, ...(retryAfterSec == null ? {} : { retryAfterSec }) },
    {
      status,
      noStore: true,
      ...(retryAfterSec == null ? {} : { retryAfterSec }),
    },
  );
}

function parseDeclaredContentLength(request: Request): number | null | "invalid" {
  const raw = request.headers.get("content-length");
  if (raw == null) return null;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return "invalid";
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The rejection response is authoritative even when the client stream has already failed.
  }
}

async function readBoundedBody(request: Request, policy: TelegramIngressPolicy): Promise<Uint8Array | Response> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > policy.bodyLimitBytes) {
        await cancelReader(reader);
        logRejection({
          policy,
          stage: "body_stream",
          status: 413,
          reason: "body_too_large",
        });
        return rejectionResponse(413, "Request body too large", "body-too-large");
      }
      chunks.push(value);
    }
  } catch {
    await cancelReader(reader);
    logRejection({
      policy,
      stage: "body_stream",
      status: 400,
      reason: "body_read_failed",
    });
    return rejectionResponse(400, "Invalid request body", "validation-error");
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function rebuildBoundedRequest(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.byteLength > 0 ? body : null,
    redirect: request.redirect,
    signal: request.signal,
    cf: request.cf,
  });
}

/**
 * Applies the fleet-backed pre-auth budget and a hard body cap before any
 * Telegram secret/HMAC validation, D1 access, or request attribution runs.
 */
export async function evaluateTelegramIngressAbuseGate(
  request: Request,
  url: URL,
  env: TelegramIngressAbuseEnv,
): Promise<TelegramIngressGateResult> {
  const policy = resolvePolicy(request, url);
  if (!policy) return { request, response: null };

  const declaredLength = parseDeclaredContentLength(request);
  if (declaredLength === "invalid") {
    logRejection({
      policy,
      stage: "body_header",
      status: 400,
      reason: "invalid_content_length",
    });
    return {
      request,
      response: rejectionResponse(400, "Invalid Content-Length", "validation-error"),
    };
  }
  if (declaredLength != null && declaredLength > policy.bodyLimitBytes) {
    logRejection({
      policy,
      stage: "body_header",
      status: 413,
      reason: "body_too_large",
    });
    return {
      request,
      response: rejectionResponse(413, "Request body too large", "body-too-large"),
    };
  }

  const limiter = resolveRateLimiter(env, policy.binding);
  if (!limiter) {
    logRejection({
      policy,
      stage: "rate_limit",
      status: 503,
      reason: "rate_limit_unavailable",
    });
    return {
      request,
      response: rejectionResponse(503, "Telegram ingress temporarily unavailable", "temporarily-unavailable", 1),
    };
  }

  let allowed: boolean;
  try {
    allowed = (await limiter.limit({ key: resolveRateLimitKey(policy, url) })).success;
  } catch {
    logRejection({
      policy,
      stage: "rate_limit",
      status: 503,
      reason: "rate_limit_unavailable",
    });
    return {
      request,
      response: rejectionResponse(503, "Telegram ingress temporarily unavailable", "temporarily-unavailable", 1),
    };
  }
  if (!allowed) {
    logRejection({
      policy,
      stage: "rate_limit",
      status: 429,
      reason: "preauth_rate_limited",
    });
    return {
      request,
      response: rejectionResponse(429, "Telegram ingress rate limited", "rate-limited", policy.periodSec),
    };
  }

  const body = await readBoundedBody(request, policy);
  if (body instanceof Response) return { request, response: body };
  return { request: rebuildBoundedRequest(request, body), response: null };
}

const HANDLER_REJECTIONS = {
  400: "handler_bad_request",
  401: "handler_unauthorized",
  413: "handler_body_too_large",
  429: "handler_rate_limited",
} as const satisfies Partial<Record<TelegramIngressRejectionStatus, TelegramIngressTelemetryReason>>;

export function recordTelegramIngressHandlerResponse(request: Request, url: URL, response: Response): void {
  const policy = resolvePolicy(request, url);
  if (!policy) return;
  const reason = HANDLER_REJECTIONS[response.status as keyof typeof HANDLER_REJECTIONS];
  if (!reason) return;
  logRejection({
    policy,
    stage: "handler",
    status: response.status as 400 | 401 | 413 | 429,
    reason,
  });
}
