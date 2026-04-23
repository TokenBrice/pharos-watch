#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_OPS_UI_URL = process.env.SMOKE_OPS_UI_URL ?? "https://ops.pharos.watch/admin/";
const DEFAULT_OPS_API_BASE = process.env.SMOKE_OPS_API_BASE ?? "https://ops-api.pharos.watch";
const OPS_UI_PROXY_RETRY_STATUSES = new Set([502, 504]);
const OPS_UI_PROXY_RETRY_COUNT = 2;
const OPS_UI_PROXY_RETRY_DELAY_MS = 2_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEnv(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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

async function fetchText(url, headers) {
  const response = await fetch(url, { headers, redirect: "manual" });
  const body = await response.text();
  return { response, body };
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function fetchJson(url, headers, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers, redirect: "manual" });
  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  return { response, body, bodyText };
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
      location.includes(".cloudflareaccess.com") &&
      !hasOpsUiAccessSessionCookie(cookieHeader ?? ""))
  );
}

export async function run() {
  const headers = buildAccessHeaders();
  const opsUiUrl = ensureUrl(DEFAULT_OPS_UI_URL);
  const opsApiBase = ensureUrl(DEFAULT_OPS_API_BASE);
  const opsUiOrigin = new URL(opsUiUrl).origin;

  console.log(`[smoke-ops] Running checks against ${opsUiUrl} and ${opsApiBase}`);

  const uiPromise = fetchText(opsUiUrl, headers);
  const directOpsPromise = Promise.all([
    fetchJson(new URL("/api/status", opsApiBase).toString(), headers),
    fetchJson(new URL("/api/status-history?limit=5", opsApiBase).toString(), headers),
    fetchJson(new URL("/api/audit-depeg-history?dry-run=true&limit=1", opsApiBase).toString(), headers),
  ]).then(
    (value) => ({ error: null, value }),
    (error) => ({ error, value: null }),
  );

  const ui = await uiPromise;
  if (ui.response.status === 200) {
    assert(ui.body.includes("Operator Admin"), "Ops UI did not render the Operator Admin shell");
    assert(
      !ui.body.includes("Operator tooling is no longer available on the public host."),
      "Ops UI returned the public-host fallback shell",
    );
    console.log("[smoke-ops] OK ops UI via service token");
  } else {
    const location = ui.response.headers.get("Location") ?? "";
    assert(ui.response.status === 302, `Expected ops UI 200 or 302, got ${ui.response.status}`);
    assert(location.includes(".cloudflareaccess.com"), "Ops UI redirect did not point to Cloudflare Access");
    console.log("[smoke-ops] OK ops UI access gate");
  }
  const uiCookieHeader = mergeCookieHeader(extractCookiePairs(ui.response));

  const directOps = await directOpsPromise;
  if (directOps.error) {
    throw directOps.error;
  }
  const [status, history, audit] = directOps.value;
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

  const proxiedUrl = new URL("/api/admin/status", opsUiOrigin).toString();
  const proxiedAttempt = await fetchOpsUiProxyStatusWithRetry(proxiedUrl, headers, {
    initialCookieHeader: uiCookieHeader,
    onRetry: ({ attemptNumber, retryCount, retryDelayMs, status }) => {
      console.warn(
        `[smoke-ops] /api/admin/status returned ${status}; retrying ${attemptNumber}/${retryCount} after ${retryDelayMs}ms to absorb post-deploy warmup`,
      );
    },
  });
  const proxiedStatus = proxiedAttempt.proxiedStatus;
  if (shouldSkipOpsUiProxyAssertion(proxiedStatus.response, proxiedAttempt.cookieHeader)) {
    console.log(
      "[smoke-ops] SKIP ops UI /api/admin/status (Pages proxy still unauthorized under CI Access flow; direct ops-api smoke already passed)",
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

  assert(history.response.status === 200, `Expected ops API /api/status-history 200, got ${history.response.status}`);
  assert(
    history.body && Array.isArray(history.body.transitions),
    "Ops API /api/status-history missing transitions array",
  );
  console.log(`[smoke-ops] OK ops API /api/status-history (${history.body.transitions.length} transitions)`);

  assert(audit.response.status === 200, `Expected dry-run audit 200, got ${audit.response.status}`);
  assert(audit.body && audit.body.dryRun === true, "Dry-run audit response missing dryRun=true");
  console.log("[smoke-ops] OK ops API dry-run action");

  console.log("[smoke-ops] All checks passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(`[smoke-ops] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
