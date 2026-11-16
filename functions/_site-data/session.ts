import { bufferReadableStream } from "@shared/lib/bounded-stream";
import { clientAddressLimiterSubject, hashClientIp } from "@shared/lib/client-ip-hash";
import { SITE_HOSTNAME, OPS_UI_HOSTNAME } from "@shared/lib/runtime-origins";
import {
  buildSiteSessionCookie,
  hasSiteSessionSigningKey,
  mintSiteSessionToken,
  SITE_SESSION_BROWSER_TTL_SEC,
  SITE_SESSION_EXPIRES_HEADER,
} from "@shared/lib/site-session-token";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { readBoundedRequestBody } from "../lib/bounded-request-body";
import { withNoindex } from "../lib/noindex";
import { jsonError } from "../lib/proxy-utils";
import type { SiteDataProxyEnv } from "../lib/site-api-env";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";
import { isSlidingWindowRateLimited } from "../lib/sliding-window-rate-limit";

const sessionRequestTimestampsByNetworkHash = new Map<string, number[]>();

export function resetSiteSessionRateLimitStateForTests(): void {
  sessionRequestTimestampsByNetworkHash.clear();
}

async function issueSession(request: Request, env: SiteDataProxyEnv): Promise<Response> {
  const requestHost = new URL(request.url).host;
  if (requestHost !== SITE_HOSTNAME && requestHost !== OPS_UI_HOSTNAME) return jsonError(404, "Not found");
  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) return rejected;
  if (request.method !== "POST") return jsonError(405, "Method not allowed", { Allow: "POST" });

  const signingKey = env.SITE_SESSION_SIGNING_KEY;
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!hasSiteSessionSigningKey(signingKey) || !turnstileSecret) return jsonError(500, "Site session is not configured");

  const ip = request.headers.get("CF-Connecting-IP");
  const subject = clientAddressLimiterSubject(ip) ?? "unknown";
  const networkHash = await hashClientIp(subject, signingKey);
  if (isSlidingWindowRateLimited(sessionRequestTimestampsByNetworkHash, networkHash, Date.now(), 60_000, 10, 5_000)) {
    return jsonError(429, "Too many requests", { "Retry-After": "60" });
  }

  const body = await readBoundedRequestBody(request, 4_096);
  if (body.status === "too-large") return jsonError(413, "Body too large");
  if (body.status !== "ok") return jsonError(400, "Invalid request body");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return jsonError(400, "Invalid request body");
  }
  if (typeof input !== "object" || input === null || !("token" in input)
    || typeof input.token !== "string" || !input.token.trim()) {
    return jsonError(400, "Missing Turnstile token");
  }

  const timeout = createTimeoutSignal({
    timeoutMs: 10_000,
    timeoutReason: new DOMException("Session verification timed out", "TimeoutError"),
    parentSignal: request.signal,
  });
  let verification: unknown;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: turnstileSecret, response: input.token, remoteip: ip ?? "" }),
      signal: timeout.signal,
      redirect: "manual",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return jsonError(503, "Session verification unavailable", { "Retry-After": "60" });
    }
    const { bytes } = await bufferReadableStream(response.body, { maxBytes: 4_096, signal: timeout.signal });
    verification = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError(503, "Session verification unavailable", { "Retry-After": "60" });
  } finally {
    timeout.dispose();
  }
  if (typeof verification !== "object" || verification === null
    || !("success" in verification) || verification.success !== true
    || !("hostname" in verification) || verification.hostname !== requestHost
    || !("action" in verification) || verification.action !== "site-data") {
    return jsonError(403, "Session verification failed");
  }

  const nowSec = Math.floor(Date.now() / 1_000);
  const token = await mintSiteSessionToken({ key: signingKey, kind: "browser", nowSec });
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": buildSiteSessionCookie(token, SITE_SESSION_BROWSER_TTL_SEC),
      [SITE_SESSION_EXPIRES_HEADER]: String(nowSec + SITE_SESSION_BROWSER_TTL_SEC),
      "Cache-Control": "no-store",
    },
  });
}

export const onRequest = async ({ request, env }: { request: Request; env: SiteDataProxyEnv }): Promise<Response> =>
  withNoindex(await issueSession(request, env));
