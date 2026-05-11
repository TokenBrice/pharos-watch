import { ENDPOINT_DEFINITIONS } from "@shared/lib/api-endpoints";
import { errorResponse } from "../../lib/api-utils";
import { hmacSha256Hex } from "../../lib/api-key-core";
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

const PUBLIC_ENDPOINT_PATHS = new Set(
  ENDPOINT_DEFINITIONS
    .filter((endpoint) => !endpoint.adminRequired && endpoint.path.startsWith("/api/"))
    .map((endpoint) => endpoint.path),
);
const PUBLIC_ENDPOINT_TEMPLATES = new Set([
  "/api/stablecoin/:id",
]);

function hasConfiguredValue(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function dependencyUnavailable(message = SELF_SERVE_SERVICE_UNAVAILABLE): Response {
  return errorResponse(503, message, { noStore: true, retryAfterSec: 60 });
}

export function requireInitialSelfServeEnv(env: ApiKeySelfServeEnv): RequiredInitialSelfServeEnv | Response {
  if (
    !hasConfiguredValue(env.API_KEY_SELF_SERVE_IP_SALT)
    || !hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER)
    || !hasConfiguredValue(env.API_KEY_SELF_SERVE_REQUEST_PEPPER)
    || !hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_FROM)
    || !hasConfiguredValue(env.API_KEY_SELF_SERVE_EMAIL_REPLY_TO)
    || !hasConfiguredValue(env.API_KEY_SELF_SERVE_PUBLIC_BASE_URL)
    || !hasConfiguredValue(env.RESEND_API_KEY)
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
    GITHUB_PAT: env.GITHUB_PAT?.trim() || undefined,
  };
}

export function requireVerifySelfServeEnv(env: ApiKeySelfServeEnv): RequiredVerifySelfServeEnv | Response {
  if (!hasConfiguredValue(env.API_KEY_SELF_SERVE_IP_SALT) || !hasConfiguredValue(env.API_KEY_SELF_SERVE_REQUEST_PEPPER)) {
    console.error("[api-key-requests] self-serve verification env is incomplete");
    return dependencyUnavailable();
  }
  return {
    API_KEY_SELF_SERVE_IP_SALT: env.API_KEY_SELF_SERVE_IP_SALT.trim(),
    API_KEY_SELF_SERVE_REQUEST_PEPPER: env.API_KEY_SELF_SERVE_REQUEST_PEPPER.trim(),
  };
}

export async function parseSelfServeRequest(request: Request): Promise<ParsedApiKeySelfServeRequest | Response> {
  try {
    const raw = await request.json();
    const result = ApiKeySelfServeRequestSchema.safeParse(raw);
    if (!result.success) {
      return errorResponse(400, result.error.issues[0]?.message ?? "Invalid API key request data", { noStore: true });
    }
    return result.data;
  } catch {
    return errorResponse(400, "Invalid JSON body", { noStore: true });
  }
}

export async function parseSelfServeVerifyRequest(request: Request): Promise<ParsedApiKeySelfServeVerify | Response> {
  try {
    const raw = await request.json();
    const result = ApiKeySelfServeVerifySchema.safeParse(raw);
    if (!result.success) {
      return errorResponse(400, result.error.issues[0]?.message ?? "Invalid verification data", { noStore: true });
    }
    return result.data;
  } catch {
    return errorResponse(400, "Invalid JSON body", { noStore: true });
  }
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

function resolveClientIp(request: Request): string {
  const forwardedFor = request.headers.get("X-Forwarded-For");
  return request.headers.get("CF-Connecting-IP") ?? forwardedFor?.split(",")[0]?.trim() ?? "unknown";
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

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createRequestId(): string {
  return `akr_${bytesToBase64Url(randomBytes(API_KEY_REQUEST_ID_BYTES))}`;
}

export function createVerificationToken(): string {
  return `akv_${bytesToBase64Url(randomBytes(VERIFICATION_TOKEN_BYTES))}`;
}

export function buildVerificationUrl(publicBaseUrl: string, token: string): string {
  const url = new URL(publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`);
  url.hash = `verify=${encodeURIComponent(token)}`;
  return url.toString();
}
