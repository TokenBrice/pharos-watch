import { ENDPOINT_DEFINITIONS } from "@shared/lib/api-endpoints";
import { hasConfiguredValue } from "@shared/lib/env-utils";
import { errorResponse, parseRequestJsonWithSchema } from "../../lib/api-utils";
import { hmacSha256Hex, randomBytes } from "../../lib/api-key-core";
import { bytesToBase64Url } from "@shared/lib/base64url";
import {
  ApiKeySelfServeRequestSchema,
  ApiKeySelfServeVerifySchema,
  type ApiKeySelfServeEnv,
  type ParsedApiKeySelfServeRequest,
  type ParsedApiKeySelfServeVerify,
  type RequiredInitialSelfServeEnv,
  type RequiredVerifySelfServeEnv,
} from "./types";

const SELF_SERVE_SERVICE_UNAVAILABLE = "API key self-serve is temporarily unavailable. Please try again.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const API_KEY_REQUEST_ID_BYTES = 18;
const VERIFICATION_TOKEN_BYTES = 32;
const API_KEY_SELF_SERVE_REQUEST_MAX_BYTES = 16 * 1024;
const API_KEY_SELF_SERVE_VERIFY_MAX_BYTES = 1024;

const PUBLIC_ENDPOINT_PATHS = new Set(
  ENDPOINT_DEFINITIONS.filter((endpoint) => !endpoint.adminRequired && endpoint.path.startsWith("/api/")).map(
    (endpoint) => endpoint.path,
  ),
);
const PUBLIC_ENDPOINT_TEMPLATES = new Set(["/api/stablecoin/:id"]);

function dependencyUnavailable(message = SELF_SERVE_SERVICE_UNAVAILABLE): Response {
  return errorResponse(503, message, { noStore: true, retryAfterSec: 60 });
}

export function requireInitialSelfServeEnv(env: ApiKeySelfServeEnv): RequiredInitialSelfServeEnv | Response {
  if (
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_IP_SALT) ||
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER) ||
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_REQUEST_PEPPER) ||
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_FROM) ||
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO) ||
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_PUBLIC_BASE_URL) ||
    !hasConfiguredValue(env.RESEND_API_KEY)
  ) {
    console.error("[api-key-requests] self-serve email verification env is incomplete");
    return dependencyUnavailable();
  }
  return {
    API_KEY_SELF_SERVE_IP_SALT: env.API_KEY_SELF_SERVE_IP_SALT.trim(),
    API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: env.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER.trim(),
    API_KEY_SELF_SERVE_REQUEST_PEPPER: env.API_KEY_SELF_SERVE_REQUEST_PEPPER.trim(),
    API_KEY_SELF_SERVE_EMAIL_FROM: env.API_KEY_SELF_SERVE_EMAIL_FROM.trim(),
    API_KEY_SELF_SERVE_EMAIL_REPLY_TO: env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO.trim(),
    API_KEY_SELF_SERVE_PUBLIC_BASE_URL: env.API_KEY_SELF_SERVE_PUBLIC_BASE_URL.trim().replace(/\/+$/, ""),
    RESEND_API_KEY: env.RESEND_API_KEY.trim(),
  };
}

export function requireVerifySelfServeEnv(env: ApiKeySelfServeEnv): RequiredVerifySelfServeEnv | Response {
  if (
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_IP_SALT) ||
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_REQUEST_PEPPER)
  ) {
    console.error("[api-key-requests] self-serve verification env is incomplete");
    return dependencyUnavailable();
  }
  return {
    API_KEY_SELF_SERVE_IP_SALT: env.API_KEY_SELF_SERVE_IP_SALT.trim(),
    API_KEY_SELF_SERVE_REQUEST_PEPPER: env.API_KEY_SELF_SERVE_REQUEST_PEPPER.trim(),
  };
}

export async function parseSelfServeRequest(request: Request): Promise<ParsedApiKeySelfServeRequest | Response> {
  return parseRequestJsonWithSchema(request, ApiKeySelfServeRequestSchema, {
    maxBytes: API_KEY_SELF_SERVE_REQUEST_MAX_BYTES,
    responseOptions: { noStore: true },
    formatSchemaError: (issues) => issues[0]?.message ?? "Invalid API key request data",
  });
}

export async function parseSelfServeVerifyRequest(request: Request): Promise<ParsedApiKeySelfServeVerify | Response> {
  return parseRequestJsonWithSchema(request, ApiKeySelfServeVerifySchema, {
    maxBytes: API_KEY_SELF_SERVE_VERIFY_MAX_BYTES,
    responseOptions: { noStore: true },
    formatSchemaError: (issues) => issues[0]?.message ?? "Invalid verification data",
  });
}

export function normalizeSelfServeEmail(email: string): string | Response {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    return errorResponse(400, "A valid email address is required", { noStore: true });
  }
  return normalized;
}

export function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function validateIntendedEndpoints(endpoints: string[] | undefined): string[] | Response {
  if (!endpoints) return [];
  const normalized: string[] = [];
  for (const raw of endpoints) {
    const endpoint = raw.trim();
    if (!endpoint) continue;
    if (endpoint === "unknown") {
      normalized.push(endpoint);
      continue;
    }
    if (!endpoint.startsWith("/api/")) {
      return errorResponse(400, "Intended endpoints must be public API paths or unknown", { noStore: true });
    }
    if (endpoint.includes("admin") || endpoint.includes("api-key") || endpoint.includes("backfill")) {
      return errorResponse(400, "Admin API paths cannot be requested for self-serve access", { noStore: true });
    }
    if (!PUBLIC_ENDPOINT_PATHS.has(endpoint) && !PUBLIC_ENDPOINT_TEMPLATES.has(endpoint)) {
      return errorResponse(400, "Unknown intended endpoint", { noStore: true });
    }
    normalized.push(endpoint);
  }
  return Array.from(new Set(normalized));
}

// Exported for unit tests; not part of the public handler surface.
export function resolveClientIp(request: Request): string {
  // CF-Connecting-IP is injected by the Cloudflare edge for every real inbound
  // request and cannot be spoofed by the client. We deliberately do NOT fall
  // back to the client-controlled X-Forwarded-For header — trusting it would let
  // a caller rotate the IP-scoped rate-limit bucket. If CF-Connecting-IP is
  // absent (e.g. off-edge), all such requests collapse into one fixed sentinel
  // bucket rather than attacker-chosen ones.
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export async function hashForLookup(secret: string, input: string): Promise<string> {
  return hmacSha256Hex(secret, input);
}

export async function hashClientIp(secret: string, request: Request): Promise<string> {
  return hashForLookup(secret, resolveClientIp(request));
}

export async function hashUserAgent(secret: string, request: Request): Promise<string | null> {
  const userAgent = request.headers.get("User-Agent")?.trim();
  return userAgent ? hashForLookup(secret, userAgent) : null;
}

export function createRequestId(): string {
  return `akr_${bytesToBase64Url(randomBytes(API_KEY_REQUEST_ID_BYTES))}`;
}

export function createVerificationToken(): string {
  return `akv_${bytesToBase64Url(randomBytes(VERIFICATION_TOKEN_BYTES))}`;
}

export function buildVerificationUrl(publicBaseUrl: string, token: string): string {
  const url = new URL(publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`);
  url.hash = encodeURIComponent(token);
  return url.toString();
}
