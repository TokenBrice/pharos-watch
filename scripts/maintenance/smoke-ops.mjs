#!/usr/bin/env node

import { assert, isDirectRun, sleep } from "../lib/smoke-runtime.mjs";

const DEFAULT_OPS_UI_URL = process.env.SMOKE_OPS_UI_URL ?? "https://ops.pharos.watch/admin/";
const DEFAULT_OPS_API_BASE = process.env.SMOKE_OPS_API_BASE ?? "https://ops-api.pharos.watch";
const DEFAULT_BLACKLIST_BACKFILL_STABLECOIN = process.env.SMOKE_OPS_BLACKLIST_BACKFILL_STABLECOIN ?? "USDT";
const DEFAULT_BLACKLIST_BACKFILL_CHAIN_ID = process.env.SMOKE_OPS_BLACKLIST_BACKFILL_CHAIN_ID ?? "optimism";
const OPS_UI_PROXY_RETRY_STATUSES = new Set([502, 504]);
const OPS_UI_PROXY_RETRY_COUNT = 2;
const OPS_UI_PROXY_RETRY_DELAY_MS = 2_000;
const DIRECT_OPS_JSON_RETRY_STATUSES = new Set([500, 502, 503, 504]);
const DIRECT_OPS_JSON_RETRY_COUNT = 2;
const DIRECT_OPS_JSON_RETRY_DELAY_MS = 2_000;

function requireEnv(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSmokeOpsScope(input = process.env.SMOKE_OPS_SCOPE ?? "full") {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "full" || normalized === "canary") {
    return normalized;
  }
  throw new Error(`Invalid SMOKE_OPS_SCOPE "${input}". Expected "full" or "canary".`);
}

function buildAccessHeaders() {
  return {
    "CF-Access-Client-Id": requireEnv("OPS_SMOKE_CF_ACCESS_CLIENT_ID"),
    "CF-Access-Client-Secret": requireEnv("OPS_SMOKE_CF_ACCESS_CLIENT_SECRET"),
  };
}

function ensureUrl(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error("Missing ops smoke URL.");
  }
  const url = new URL(trimmed);
  if (url.hostname === "ops.pharos.watch" && (url.pathname === "/status" || url.pathname === "/status/")) {
    url.pathname = "/admin/";
    url.search = "";
  }
  return url.toString();
}

function isCloudflareAccessLocation(location) {
  if (!location) return false;
  try {
    const hostname = new URL(location).hostname;
    return hostname === "cloudflareaccess.com" || hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers, redirect: "manual" });
  const body = await response.text();
  return { response, body };
}

function getCspDirective(csp, directiveName) {
  return (csp ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${directiveName} `)) ?? "";
}

function getInlineScriptTags(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/gi)].map((match) => match[0]);
}

function getScriptTagNonce(scriptTag) {
  const match = scriptTag.match(/\bnonce=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

export function assertNonceProtectedHtml(response, body, label) {
  const inlineScripts = getInlineScriptTags(body);
  if (inlineScripts.length === 0) {
    return;
  }

  const scriptSrc = getCspDirective(response.headers.get("Content-Security-Policy"), "script-src");
  const nonceMatch = scriptSrc.match(/(?:^|\s)'nonce-([^']+)'(?:\s|$)/);
  const cspNonce = nonceMatch?.[1] ?? "";
  assert(cspNonce, `${label} CSP script-src is missing a nonce`);
  assert(!scriptSrc.includes("'unsafe-inline'"), `${label} CSP script-src still permits unsafe inline scripts`);

  const missingNonceCount = inlineScripts.filter((scriptTag) => getScriptTagNonce(scriptTag) !== cspNonce).length;
  assert(
    missingNonceCount === 0,
    `${label} has ${missingNonceCount} inline script(s) without the CSP nonce`,
  );
}

export async function fetchJson(url, headers, fetchImpl = fetch, requestInit = {}) {
  const response = await fetchImpl(url, { ...requestInit, headers, redirect: "manual" });
  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  return { response, body, bodyText };
}

export function shouldRetryDirectOpsJson(response) {
  return DIRECT_OPS_JSON_RETRY_STATUSES.has(response.status);
}

export async function fetchJsonWithRetry(url, headers, options = {}) {
  const {
    fetchImpl = fetch,
    requestInit = {},
    retryCount = DIRECT_OPS_JSON_RETRY_COUNT,
    retryDelayMs = DIRECT_OPS_JSON_RETRY_DELAY_MS,
    sleepImpl = sleep,
    onRetry = null,
  } = options;

  let result = await fetchJson(url, headers, fetchImpl, requestInit);
  for (let retryIndex = 0; retryIndex < retryCount; retryIndex++) {
    if (!shouldRetryDirectOpsJson(result.response)) {
      return result;
    }
    if (typeof onRetry === "function") {
      onRetry({
        attemptNumber: retryIndex + 1,
        retryCount,
        retryDelayMs,
        status: result.response.status,
      });
    }
    await sleepImpl(retryDelayMs);
    result = await fetchJson(url, headers, fetchImpl, requestInit);
  }
  return result;
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }

  const cookies = [];
  let current = "";
  let inExpires = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const lowerRemainder = value.slice(index).toLowerCase();
    if (lowerRemainder.startsWith("expires=")) {
      inExpires = true;
    }
    if (char === "," && !inExpires) {
      const trimmed = current.trim();
      if (trimmed) {
        cookies.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
    if (inExpires && char === ";") {
      inExpires = false;
    }
  }

  const trimmed = current.trim();
  if (trimmed) {
    cookies.push(trimmed);
  }
  return cookies;
}

export function extractCookiePairs(response) {
  const getSetCookie =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie.bind(response.headers) : null;
  const rawSetCookies = getSetCookie ? getSetCookie() : [response.headers.get("set-cookie")];
  const setCookies = rawSetCookies.flatMap((cookie) => splitSetCookieHeader(cookie));
  return setCookies.map((cookie) => cookie.split(";", 1)[0]?.trim() ?? "").filter(Boolean);
}

export function mergeCookieHeader(...cookieGroups) {
  const cookieMap = new Map();
  for (const group of cookieGroups) {
    const cookies = Array.isArray(group) ? group : [group];
    for (const cookie of cookies) {
      const trimmed = (cookie ?? "").trim();
      if (!trimmed) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;
      cookieMap.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
    }
  }
  return [...cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function hasOpsUiAccessSessionCookie(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .some((cookie) => cookie.startsWith("CF_Authorization="));
}

export async function fetchOpsUiProxyStatus(url, accessHeaders, options = {}) {
  const { fetchImpl = fetch, initialCookieHeader = "" } = options;

  let cookieHeader = initialCookieHeader;
  let proxiedStatus = await fetchJson(url, accessHeaders, fetchImpl);
  if (proxiedStatus.response.status === 200) {
    return { proxiedStatus, retriedWithCookie: false, cookieHeader };
  }

  cookieHeader = mergeCookieHeader(cookieHeader, extractCookiePairs(proxiedStatus.response));
  if (proxiedStatus.response.status === 401 && hasOpsUiAccessSessionCookie(cookieHeader)) {
    proxiedStatus = await fetchJson(
      url,
      {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
      fetchImpl,
    );
    return { proxiedStatus, retriedWithCookie: true, cookieHeader };
  }

  return { proxiedStatus, retriedWithCookie: false, cookieHeader };
}

export function shouldRetryOpsUiProxyStatus(response) {
  return OPS_UI_PROXY_RETRY_STATUSES.has(response.status);
}

export async function fetchOpsUiProxyStatusWithRetry(url, accessHeaders, options = {}) {
  const {
    fetchImpl = fetch,
    initialCookieHeader = "",
    retryCount = OPS_UI_PROXY_RETRY_COUNT,
    retryDelayMs = OPS_UI_PROXY_RETRY_DELAY_MS,
    sleepImpl = sleep,
    onRetry = null,
  } = options;

  let cookieHeader = initialCookieHeader;
  let attempt = await fetchOpsUiProxyStatus(url, accessHeaders, {
    fetchImpl,
    initialCookieHeader: cookieHeader,
  });
  cookieHeader = attempt.cookieHeader;

  for (let retryIndex = 0; retryIndex < retryCount; retryIndex++) {
    if (!shouldRetryOpsUiProxyStatus(attempt.proxiedStatus.response)) {
      return attempt;
    }
    if (typeof onRetry === "function") {
      onRetry({
        attemptNumber: retryIndex + 1,
        retryCount,
        retryDelayMs,
        status: attempt.proxiedStatus.response.status,
      });
    }
    await sleepImpl(retryDelayMs);
    attempt = await fetchOpsUiProxyStatus(url, accessHeaders, {
      fetchImpl,
      initialCookieHeader: cookieHeader,
    });
    cookieHeader = attempt.cookieHeader;
  }

  return attempt;
}

export function shouldSkipOpsUiProxyAssertion(response, cookieHeader) {
  const location = response.headers.get("Location") ?? "";
  return (
    response.status === 401 ||
    (response.status === 302 &&
      isCloudflareAccessLocation(location) &&
      !hasOpsUiAccessSessionCookie(cookieHeader ?? ""))
  );
}

export function shouldSkipCanaryOpsUiProxyAssertion(response, cookieHeader, scope) {
  return (
    shouldSkipOpsUiProxyAssertion(response, cookieHeader) ||
    (scope === "canary" && shouldRetryOpsUiProxyStatus(response))
  );
}

export async function run() {
  const scope = getSmokeOpsScope();
  const headers = buildAccessHeaders();
  const opsUiUrl = ensureUrl(DEFAULT_OPS_UI_URL);
  const opsApiBase = ensureUrl(DEFAULT_OPS_API_BASE);
  const opsUiOrigin = new URL(opsUiUrl).origin;
  const adminApiUrl = new URL("/admin-api/", opsUiOrigin).toString();
  const blacklistBackfillUrl = new URL("/api/backfill-blacklist-current-balances", opsApiBase);
  blacklistBackfillUrl.searchParams.set("dryRun", "true");
  blacklistBackfillUrl.searchParams.set("stablecoin", DEFAULT_BLACKLIST_BACKFILL_STABLECOIN);
  blacklistBackfillUrl.searchParams.set("chainId", DEFAULT_BLACKLIST_BACKFILL_CHAIN_ID);
  blacklistBackfillUrl.searchParams.set("limit", "1");

  console.log(`[smoke-ops] Running ${scope} checks against ${opsUiUrl} and ${opsApiBase}`);

  const uiPromise = fetchText(opsUiUrl, headers);
  const adminApiPromise = fetchText(adminApiUrl, headers);
  const statusPromise = fetchJson(new URL("/api/status", opsApiBase).toString(), headers);
  const directOpsDetailsPromise =
    scope === "full"
      ? Promise.all([
          fetchJson(new URL("/api/status-history?limit=5", opsApiBase).toString(), headers),
          fetchJson(new URL("/api/api-key-requests-admin?limit=1", opsApiBase).toString(), headers),
          fetchJson(new URL("/api/audit-depeg-history?dry-run=true&limit=1", opsApiBase).toString(), headers),
          fetchJsonWithRetry(
            blacklistBackfillUrl.toString(),
            {
              ...headers,
              "Content-Type": "application/json",
              "X-Pharos-Admin": "1",
            },
            {
              requestInit: { method: "POST", body: "{}" },
              onRetry: ({ attemptNumber, retryCount, retryDelayMs, status }) => {
                console.warn(
                  `[smoke-ops] blacklist balance dry-run returned ${status}; retrying ${attemptNumber}/${retryCount} after ${retryDelayMs}ms to absorb post-deploy backend warmup`,
                );
              },
            },
          ),
        ]).then(
          (value) => ({ error: null, value }),
          (error) => ({ error, value: null }),
        )
      : null;

  const ui = await uiPromise;
  if (ui.response.status === 200) {
    assert(ui.body.includes("Operator Admin"), "Ops UI did not render the Operator Admin shell");
    assert(
      !ui.body.includes("Operator tooling is no longer available on the public host."),
      "Ops UI returned the public-host fallback shell",
    );
    assertNonceProtectedHtml(ui.response, ui.body, "Ops UI");
    console.log("[smoke-ops] OK ops UI via service token");
  } else {
    const location = ui.response.headers.get("Location") ?? "";
    assert(ui.response.status === 302, `Expected ops UI 200 or 302, got ${ui.response.status}`);
    assert(isCloudflareAccessLocation(location), "Ops UI redirect did not point to Cloudflare Access");
    console.log("[smoke-ops] OK ops UI access gate");
  }
  const uiCookieHeader = mergeCookieHeader(extractCookiePairs(ui.response));
  const proxiedUrl = new URL("/api/admin/status", opsUiOrigin).toString();
  const proxiedAttemptPromise = fetchOpsUiProxyStatusWithRetry(proxiedUrl, headers, {
    initialCookieHeader: uiCookieHeader,
    onRetry: ({ attemptNumber, retryCount, retryDelayMs, status }) => {
      console.warn(
        `[smoke-ops] /api/admin/status returned ${status}; retrying ${attemptNumber}/${retryCount} after ${retryDelayMs}ms to absorb post-deploy warmup`,
      );
    },
  }).then(
    (value) => ({ error: null, value }),
    (error) => ({ error, value: null }),
  );

  const adminApi = await adminApiPromise;
  if (adminApi.response.status === 200) {
    assert(adminApi.body.includes("API Management"), "Admin API UI did not render the API Management shell");
    assert(
      !adminApi.body.includes("API management is not available on the public host."),
      "Admin API UI returned the public-host fallback shell",
    );
    assertNonceProtectedHtml(adminApi.response, adminApi.body, "Admin API UI");
    console.log("[smoke-ops] OK /admin-api/ via service token");
  } else {
    const location = adminApi.response.headers.get("Location") ?? "";
    assert(adminApi.response.status === 302, `Expected /admin-api/ 200 or 302, got ${adminApi.response.status}`);
    assert(isCloudflareAccessLocation(location), "/admin-api/ redirect did not point to Cloudflare Access");
    console.log("[smoke-ops] OK /admin-api/ access gate");
  }

  const status = await statusPromise;
  if (status.response.status !== 200) {
    console.error(
      `[smoke-ops] /api/status returned ${status.response.status}, body: ${status.bodyText?.slice(0, 500)}`,
    );
    console.error(`[smoke-ops] Response headers:`, Object.fromEntries(status.response.headers.entries()));
  }
  assert(status.response.status === 200, `Expected ops API /api/status 200, got ${status.response.status}`);
  assert(status.body && typeof status.body === "object", "Ops API /api/status did not return JSON");
  assert(typeof status.body.overallStatus === "string", "Ops API /api/status missing overallStatus");
  console.log(`[smoke-ops] OK ops API /api/status (${status.body.overallStatus})`);

  const proxiedAttemptResult = await proxiedAttemptPromise;
  if (proxiedAttemptResult.error) {
    throw proxiedAttemptResult.error;
  }
  const proxiedAttempt = proxiedAttemptResult.value;
  const proxiedStatus = proxiedAttempt.proxiedStatus;
  if (shouldSkipCanaryOpsUiProxyAssertion(proxiedStatus.response, proxiedAttempt.cookieHeader, scope)) {
    console.log(
      shouldRetryOpsUiProxyStatus(proxiedStatus.response)
        ? `[smoke-ops] SKIP ops UI /api/admin/status (Pages proxy returned transient ${proxiedStatus.response.status} after retries; direct ops-api smoke already passed)`
        : "[smoke-ops] SKIP ops UI /api/admin/status (Pages proxy still unauthorized under CI Access flow; direct ops-api smoke already passed)",
    );
  } else {
    if (proxiedStatus.response.status !== 200) {
      console.error(
        `[smoke-ops] /api/admin/status returned ${proxiedStatus.response.status}, body: ${proxiedStatus.bodyText?.slice(0, 500)}`,
      );
      console.error(`[smoke-ops] Response headers:`, Object.fromEntries(proxiedStatus.response.headers.entries()));
    }
    assert(
      proxiedStatus.response.status === 200,
      `Expected ops UI /api/admin/status 200, got ${proxiedStatus.response.status}`,
    );
    assert(
      proxiedStatus.body && typeof proxiedStatus.body === "object",
      "Ops UI /api/admin/status did not return JSON",
    );
    assert(typeof proxiedStatus.body.overallStatus === "string", "Ops UI /api/admin/status missing overallStatus");
    console.log(
      proxiedAttempt.retriedWithCookie
        ? `[smoke-ops] OK ops UI /api/admin/status (${proxiedStatus.body.overallStatus}) via Access session cookie`
        : `[smoke-ops] OK ops UI /api/admin/status (${proxiedStatus.body.overallStatus})`,
    );
  }

  if (scope === "canary") {
    console.log("[smoke-ops] Canary checks passed.");
    return;
  }

  const directOpsDetails = await directOpsDetailsPromise;
  if (directOpsDetails.error) {
    throw directOpsDetails.error;
  }
  const [history, apiKeyRequestsAdmin, audit, blacklistBackfill] = directOpsDetails.value;

  assert(
    apiKeyRequestsAdmin.response.status === 200,
    `Expected ops API /api/api-key-requests-admin 200, got ${apiKeyRequestsAdmin.response.status}`,
  );
  assert(
    apiKeyRequestsAdmin.body && Array.isArray(apiKeyRequestsAdmin.body.requests),
    "Ops API /api/api-key-requests-admin missing requests array",
  );
  console.log(
    `[smoke-ops] OK ops API /api/api-key-requests-admin (${apiKeyRequestsAdmin.body.requests.length} row sample)`,
  );

  const proxiedAdminUrl = new URL("/api/admin/api-key-requests-admin?limit=1", opsUiOrigin).toString();
  const proxiedAdminAttempt = await fetchOpsUiProxyStatusWithRetry(proxiedAdminUrl, headers, {
    initialCookieHeader: proxiedAttempt.cookieHeader,
    onRetry: ({ attemptNumber, retryCount, retryDelayMs, status }) => {
      console.warn(
        `[smoke-ops] /api/admin/api-key-requests-admin returned ${status}; retrying ${attemptNumber}/${retryCount} after ${retryDelayMs}ms to absorb post-deploy warmup`,
      );
    },
  });
  const proxiedAdmin = proxiedAdminAttempt.proxiedStatus;
  if (shouldSkipOpsUiProxyAssertion(proxiedAdmin.response, proxiedAdminAttempt.cookieHeader)) {
    console.log(
      "[smoke-ops] SKIP ops UI /api/admin/api-key-requests-admin (Pages proxy still unauthorized under CI Access flow; direct ops-api smoke already passed)",
    );
  } else {
    if (proxiedAdmin.response.status !== 200) {
      console.error(
        `[smoke-ops] /api/admin/api-key-requests-admin returned ${proxiedAdmin.response.status}, body: ${proxiedAdmin.bodyText?.slice(0, 500)}`,
      );
      console.error(`[smoke-ops] Response headers:`, Object.fromEntries(proxiedAdmin.response.headers.entries()));
    }
    assert(
      proxiedAdmin.response.status === 200,
      `Expected ops UI /api/admin/api-key-requests-admin 200, got ${proxiedAdmin.response.status}`,
    );
    assert(
      proxiedAdmin.body && Array.isArray(proxiedAdmin.body.requests),
      "Ops UI /api/admin/api-key-requests-admin missing requests array",
    );
    console.log(
      proxiedAdminAttempt.retriedWithCookie
        ? `[smoke-ops] OK ops UI /api/admin/api-key-requests-admin (${proxiedAdmin.body.requests.length} row sample) via Access session cookie`
        : `[smoke-ops] OK ops UI /api/admin/api-key-requests-admin (${proxiedAdmin.body.requests.length} row sample)`,
    );
  }

  assert(history.response.status === 200, `Expected ops API /api/status-history 200, got ${history.response.status}`);
  assert(
    history.body && Array.isArray(history.body.transitions),
    "Ops API /api/status-history missing transitions array",
  );
  console.log(`[smoke-ops] OK ops API /api/status-history (${history.body.transitions.length} transitions)`);

  assert(audit.response.status === 200, `Expected dry-run audit 200, got ${audit.response.status}`);
  assert(audit.body && audit.body.dryRun === true, "Dry-run audit response missing dryRun=true");
  console.log("[smoke-ops] OK ops API dry-run action");

  if (blacklistBackfill.response.status !== 200) {
    console.error(
      `[smoke-ops] blacklist balance dry-run returned ${blacklistBackfill.response.status}, body: ${blacklistBackfill.bodyText?.slice(0, 500)}`,
    );
    console.error(`[smoke-ops] Response headers:`, Object.fromEntries(blacklistBackfill.response.headers.entries()));
  }
  assert(
    blacklistBackfill.response.status === 200,
    `Expected blacklist balance dry-run 200, got ${blacklistBackfill.response.status}`,
  );
  assert(
    blacklistBackfill.body && blacklistBackfill.body.dryRun === true,
    "Blacklist balance dry-run response missing dryRun=true",
  );
  assert(
    blacklistBackfill.body.totals && typeof blacklistBackfill.body.totals.candidates === "number",
    "Blacklist balance dry-run response missing totals.candidates",
  );
  console.log("[smoke-ops] OK ops API blacklist balance dry-run");

  console.log("[smoke-ops] All checks passed.");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  run().catch((error) => {
    console.error(`[smoke-ops] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
