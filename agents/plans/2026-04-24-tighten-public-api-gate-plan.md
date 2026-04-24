# Tighten Public API Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/_site-data/*` genuinely same-site (Origin/Referer gated) and require a valid `X-API-Key` for every `api.pharos.watch/api/*` request. Remove all unauthenticated public lane code.

**Architecture:** Header-based gate at the Pages Function edge; collapse the Worker `evaluateAccessGate` into a single keyed path. Delete the IP-salted public rate limiter, the `PUBLIC_API_AUTH_MODE` spectrum, the `PUBLIC_API_RATE_LIMIT_SALT` env var, and `public-api-limits.ts`.

**Tech Stack:** Cloudflare Pages Functions (TypeScript), Cloudflare Worker (TypeScript), Vitest, Next.js 16 static export. Full design at `agents/specs/2026-04-24-tighten-public-api-gate-design.md`.

---

## Pre-flight

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Verify clean worktree**

Run: `git status`
Expected: no uncommitted tracked changes. Only untracked files may exist.

- [ ] **Step 2: Capture baseline test state**

Run:
```bash
npm test -- --run 2>&1 | tail -20
cd worker && npx tsc --noEmit 2>&1 | tail -5
cd ..
```
Expected: tests pass, no TypeScript errors. Note any pre-existing failures so later runs can be compared.

- [ ] **Step 3: Confirm baseline live behavior**

Run:
```bash
curl -s -o /dev/null -w "no-origin=%{http_code}\n" https://pharos.watch/_site-data/peg-summary
curl -s -o /dev/null -w "no-key=%{http_code}\n" https://api.pharos.watch/api/peg-summary
```
Expected (current prod): both `200`. After the plan lands, expected: `404` and `401` respectively.

---

## Phase 1 — Site-data lane (Pages Function)

### Task 1: Rewrite site-data origin gate with header-based checks

**Files:**
- Test: `functions/lib/__tests__/site-data-origin.test.ts` (new)
- Modify: `functions/lib/site-data-origin.ts`

Design reference: Lane 1 algorithm in the spec. Summary: Origin header primary, Referer header fallback, neither → 404; `*.pages.dev` preview hostname shortcut preserved.

- [ ] **Step 1: Create the failing test file**

Create `functions/lib/__tests__/site-data-origin.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { rejectIfNotSiteDataUiOrigin } from "../site-data-origin";

const env = { SITE_ORIGIN: "https://pharos.watch", OPS_UI_ORIGIN: "https://ops.pharos.watch" };
const notFound = () => new Response(null, { status: 404 });

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("rejectIfNotSiteDataUiOrigin", () => {
  it("passes when Origin matches an allowed hostname", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "https://pharos.watch" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("passes when Origin matches ops UI", () => {
    const r = req("https://ops.pharos.watch/_site-data/peg-summary", { Origin: "https://ops.pharos.watch" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("rejects a foreign Origin", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "https://evil.example.com" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("rejects a foreign Origin even if Referer is allowed", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", {
      Origin: "https://evil.example.com",
      Referer: "https://pharos.watch/",
    });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("passes when Origin is absent but Referer hostname is allowed", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Referer: "https://pharos.watch/some-page" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("rejects when Origin is absent and Referer is foreign", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Referer: "https://evil.example.com/path" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("rejects when neither Origin nor Referer is present", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary");
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("shortcuts the header check on Pages preview hostnames", () => {
    const r = req("https://stablecoin-dashboard.pages.dev/_site-data/peg-summary");
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("shortcuts the header check on Pages preview subdomains", () => {
    const r = req("https://abc123.stablecoin-dashboard.pages.dev/_site-data/peg-summary");
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("passes when Origin is a *.pages.dev preview hostname and request is on pharos.watch", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", {
      Origin: "https://stablecoin-dashboard.pages.dev",
    });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)).toBeNull();
  });

  it("rejects a malformed Origin header", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "not-a-url" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });

  it("rejects 'Origin: null' (file://, sandboxed iframes, some browsers)", () => {
    const r = req("https://pharos.watch/_site-data/peg-summary", { Origin: "null" });
    expect(rejectIfNotSiteDataUiOrigin(r, env, notFound)?.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/lib/__tests__/site-data-origin.test.ts`
Expected: multiple FAILs — the current implementation checks `url.origin` (request's own URL), not headers, so cases like foreign-Origin-on-pharos pass when they shouldn't.

- [ ] **Step 3: Replace the implementation**

Replace the entire contents of `functions/lib/site-data-origin.ts`:

```typescript
import {
  OPS_UI_ORIGIN,
  SITE_ORIGIN,
  isPagesAppHostname,
  resolveOrigin,
} from "@shared/lib/runtime-origins";

export const DEFAULT_SITE_UI_ORIGIN = SITE_ORIGIN;
export const DEFAULT_OPS_UI_ORIGIN = OPS_UI_ORIGIN;

function resolveAllowedHostnames(env: { SITE_ORIGIN?: string; OPS_UI_ORIGIN?: string }): Set<string> {
  return new Set([
    new URL(resolveOrigin(env.SITE_ORIGIN, DEFAULT_SITE_UI_ORIGIN)).hostname,
    new URL(resolveOrigin(env.OPS_UI_ORIGIN, DEFAULT_OPS_UI_ORIGIN)).hostname,
  ]);
}

function hostnameOfHeader(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}

function isAllowedHostname(hostname: string, allowed: Set<string>): boolean {
  return allowed.has(hostname) || isPagesAppHostname(hostname);
}

export function rejectIfNotSiteDataUiOrigin(
  request: Request,
  env: { SITE_ORIGIN?: string; OPS_UI_ORIGIN?: string },
  notFound: () => Response,
): Response | null {
  const url = new URL(request.url);
  if (isPagesAppHostname(url.hostname)) {
    return null;
  }

  const allowed = resolveAllowedHostnames(env);
  const originHost = hostnameOfHeader(request.headers.get("Origin"));
  if (originHost !== null) {
    return isAllowedHostname(originHost, allowed) ? null : notFound();
  }

  const refererHost = hostnameOfHeader(request.headers.get("Referer"));
  if (refererHost !== null) {
    return isAllowedHostname(refererHost, allowed) ? null : notFound();
  }

  return notFound();
}
```

Key behaviors:
- `isPagesAppHostname(url.hostname)` preserves the existing shortcut: if the request URL itself is on `*.pages.dev`, skip header checks.
- `Origin` header wins when present. Foreign Origin → reject regardless of Referer.
- `Origin` absent → fall back to `Referer`.
- Neither → reject.
- Malformed / `null` Origin → treated as absent, falls through to Referer; if Referer also absent/invalid → reject.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run functions/lib/__tests__/site-data-origin.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/site-data-origin.ts functions/lib/__tests__/site-data-origin.test.ts
git commit -m "$(cat <<'EOF'
feat(site-data): gate Pages lane on Origin/Referer headers

Replace the no-op url.origin check with a real header-based gate:
Origin wins when present, Referer is the fallback, and a request with
neither is rejected. Preserves the *.pages.dev preview shortcut.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Update existing site-data-proxy tests for new gate + remove public-fallback expectations

**Files:**
- Modify: `functions/__tests__/site-data-proxy.test.ts`

The existing tests construct `new Request("https://pharos.watch/_site-data/...")` without an `Origin` header. Under the new gate those would 404. They must add a matching `Origin`. Two tests also exercise the about-to-be-deleted `allowPublicApiFallback` path — those get deleted in Task 4, so their removal is sequenced there; update fixtures only here.

- [ ] **Step 1: Add Origin headers to every positive-path test**

For each test that currently expects the request to pass the site-data gate (i.e., expects 200 / 304 / 405 / 429), set an `Origin` header matching the request URL. Use `Edit` or `Write` as needed.

Representative change — each `new Request("https://pharos.watch/_site-data/...", { ... })` must include `headers: { Origin: "https://pharos.watch", ...existing }`. For the `ops.pharos.watch` request, `Origin: "https://ops.pharos.watch"`.

Example (one of many):

```diff
 const response = await onRequest({
-  request: new Request("https://pharos.watch/_site-data/stablecoins"),
+  request: new Request("https://pharos.watch/_site-data/stablecoins", {
+    headers: { Origin: "https://pharos.watch" },
+  }),
   env: makeEnv(),
   params: { path: "stablecoins" },
 });
```

Apply to every `onRequest({ ... })` call in this file that is expected to succeed past the gate:
- `enforces GET-only method rules` (POST but still host-scoped to pharos.watch — needs Origin so it reaches the method check)
- `returns a cached response ...`
- `bypasses the Pages cache for conditional requests` (merge with existing `If-None-Match` header)
- `proxies allowlisted requests ...` (this one uses ops.pharos.watch — use `Origin: "https://ops.pharos.watch"`; preserve existing `Accept: application/json`)
- `does not cache upstream responses marked no-store`
- `does not cache stale upstream responses with Warning 110`
- `preserves upstream Retry-After headers on site-data rate limits`
- `proxies public-status-history through the site-data lane`
- `proxies telegram-pulse through the site-data lane`
- `fails closed on production site hosts when SITE_API_ORIGIN is unset`
- `returns 500 when the site-proxy secret is missing`

Exclude from the Origin addition:
- `rejects requests from non-site hosts` — this test hits `example.com`, not a pharos host. Change the URL to keep testing foreign-host rejection via the Pages-level routing (see Step 2).
- `rejects non-allowlisted paths` — leave the URL as `pharos.watch/_site-data/status` but add `Origin: "https://pharos.watch"` so the request passes the gate and reaches the path-allowlist check.
- The `allows Pages preview hosts to fall back to the public API origin when SITE_API_ORIGIN is unset` test will be deleted in Task 4.

- [ ] **Step 2: Update the non-site-host rejection test**

Replace that test with one that exercises the new header-based gate rather than URL host:

```typescript
it("rejects requests without Origin or Referer", async () => {
  const response = await onRequest({
    request: new Request("https://pharos.watch/_site-data/stablecoins"),
    env: makeEnv(),
    params: { path: "stablecoins" },
  });

  expect(response.status).toBe(404);
  expect(cacheMatch).not.toHaveBeenCalled();
});

it("rejects requests from foreign origins", async () => {
  const response = await onRequest({
    request: new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://evil.example.com" },
    }),
    env: makeEnv(),
    params: { path: "stablecoins" },
  });

  expect(response.status).toBe(404);
  expect(cacheMatch).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the proxy tests**

Run: `npx vitest run functions/__tests__/site-data-proxy.test.ts`
Expected: all PASS except the one `allows Pages preview hosts to fall back to the public API origin ...` case, which is deleted in Task 4. To keep the test file green in the meantime, **skip** that case:

```diff
-it("allows Pages preview hosts to fall back to the public API origin when SITE_API_ORIGIN is unset", async () => {
+it.skip("allows Pages preview hosts to fall back to the public API origin when SITE_API_ORIGIN is unset", async () => {
```

Re-run: `npx vitest run functions/__tests__/site-data-proxy.test.ts`
Expected: all PASS (1 skipped).

- [ ] **Step 4: Commit**

```bash
git add functions/__tests__/site-data-proxy.test.ts
git commit -m "$(cat <<'EOF'
test(site-data): update proxy tests for header-based gate

Every positive-path case now sets an Origin header matching the request
host. Replaces the old "non-site host" test with explicit absent-headers
and foreign-Origin cases. Skips the public-api-fallback test pending its
removal in the upcoming fallback-deletion commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Remove `allowPublicApiFallback` from site-api-env

**Files:**
- Modify: `functions/lib/site-api-env.ts`

Design decision: after the cutover, the Pages Function cannot fall back to `api.pharos.watch` (which now returns 401 without a key). Delete the fallback branch entirely.

- [ ] **Step 1: Rewrite site-api-env.ts**

Replace the file contents with:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { getRuntimeActiveEnvKeys, getRuntimeEnvKeys } from "@shared/lib/env-contract";
import { getConfiguredValue } from "@shared/lib/env-utils";
import {
  OPS_UI_HOSTNAME,
  SITE_HOSTNAME,
  normalizeOrigin,
} from "@shared/lib/runtime-origins";

export interface SiteDataProxyEnv {
  DB?: D1Database;
  SITE_ORIGIN?: string;
  OPS_UI_ORIGIN?: string;
  SITE_API_ORIGIN?: string;
  SITE_API_SHARED_SECRET?: string;
}

export interface SiteDataProxyEnvIssue {
  code: "site-api-origin-missing" | "site-api-secret-missing" | "site-data-db-missing";
  message: string;
}

export const SITE_DATA_FUNCTIONS_REQUIRED_ENV_KEYS = getRuntimeEnvKeys("pagesSiteData", "required");
export const SITE_DATA_FUNCTIONS_OPTIONAL_ENV_KEYS = getRuntimeEnvKeys("pagesSiteData", "optional");
export const SITE_DATA_FUNCTIONS_ACTIVE_ENV_KEYS = getRuntimeActiveEnvKeys("pagesSiteData");

export function isProductionSiteDataHostname(hostname: string): boolean {
  return hostname === SITE_HOSTNAME || hostname === OPS_UI_HOSTNAME;
}

export function resolveSiteApiOrigin(
  env: Pick<SiteDataProxyEnv, "SITE_API_ORIGIN">,
): string | null {
  const configuredOrigin = getConfiguredValue(env.SITE_API_ORIGIN);
  if (!configuredOrigin) {
    return null;
  }
  try {
    return normalizeOrigin(configuredOrigin);
  } catch {
    return null;
  }
}

export function validatePagesSiteDataProxyEnv(
  env: SiteDataProxyEnv,
): SiteDataProxyEnvIssue[] {
  const hasSecret = typeof env.SITE_API_SHARED_SECRET === "string" && env.SITE_API_SHARED_SECRET.trim().length > 0;
  const issues: SiteDataProxyEnvIssue[] = [];

  if (!getConfiguredValue(env.SITE_API_ORIGIN)) {
    issues.push({
      code: "site-api-origin-missing",
      message: "SITE_API_ORIGIN must be configured for the site-data proxy.",
    });
  }

  if (!hasSecret) {
    issues.push({
      code: "site-api-secret-missing",
      message: "SITE_API_SHARED_SECRET must be configured for the site-data proxy.",
    });
  }

  if (!env.DB) {
    issues.push({
      code: "site-data-db-missing",
      message: "DB is optional for the Pages site-data proxy, but attribution telemetry is disabled when it is not bound.",
    });
  }

  return issues;
}
```

Removed:
- `DEFAULT_SITE_API_ORIGIN` export (no more fallback target).
- `SiteDataProxyRuntimePolicy` interface.
- `resolveSiteDataProxyRuntimePolicy` function.
- `resolveSiteDataUpstreamLane` function (lane is always `"site-api"` now).
- `allowPublicApiFallback` option across all functions.
- `API_ORIGIN` import.
- `SiteDataRequestUpstreamLane` import.

- [ ] **Step 2: TypeScript check**

Run: `cd worker && npx tsc --noEmit 2>&1 | tail -20 ; cd ..`
Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: errors in callers (`functions/_site-data/[[path]].ts`) — those are fixed in Task 4. Do not commit yet.

- [ ] **Step 3: Continue to Task 4 without committing**

This change is intentionally paired with Task 4 in one commit.

---

### Task 4: Update Pages Function handler to drop fallback logic

**Files:**
- Modify: `functions/_site-data/[[path]].ts`
- Modify: `functions/__tests__/site-data-proxy.test.ts` (delete skipped test)
- Modify: any other caller of the deleted symbols

- [ ] **Step 1: Find remaining callers**

Run:
```bash
grep -rn "allowPublicApiFallback\|resolveSiteDataProxyRuntimePolicy\|resolveSiteDataUpstreamLane\|SiteDataRequestUpstreamLane\|DEFAULT_SITE_API_ORIGIN" functions shared worker --include="*.ts" 2>/dev/null
```
Expected: at least `functions/_site-data/[[path]].ts`. Possibly `shared/types.ts` defining `SiteDataRequestUpstreamLane`, telemetry recorders, and type-level tests.

- [ ] **Step 2: Rewrite the onRequest handler**

In `functions/_site-data/[[path]].ts`, replace the body of `onRequest` and remove the now-unused imports. The new handler:

```typescript
import { resolveApiRequestRouteMetric } from "@shared/lib/request-attribution";
import { resolveSiteDataUpstreamPath } from "@shared/lib/site-data-routes";
import {
  jsonError,
  buildUpstreamHeaders as buildUpstreamHeadersShared,
  buildProxyResponse as buildProxyResponseShared,
} from "../lib/proxy-utils";
import { recordSiteDataRequest } from "../lib/request-attribution";
import { rejectIfNotSiteDataUiOrigin } from "../lib/site-data-origin";
import {
  resolveSiteApiOrigin,
  validatePagesSiteDataProxyEnv,
  type SiteDataProxyEnv,
} from "../lib/site-api-env";
import {
  DEFAULT_PROXY_TIMEOUT_MS,
  fetchUpstreamProxy,
  resolveWildcardProxyPath,
} from "../lib/upstream-proxy";

const SITE_PROXY_HEADER = "X-Pharos-Site-Proxy-Secret";
const FORWARDED_REQUEST_HEADERS = [
  "Accept",
  "If-None-Match",
  "If-Modified-Since",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "Cache-Control",
  "Content-Type",
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

interface SiteDataProxyContext {
  request: Request;
  env: SiteDataProxyEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
  params: { path?: string | string[] };
}

function methodNotAllowed(): Response {
  return jsonError(405, "Method not allowed", { Allow: "GET" });
}

function resolveRequestedPath(params: SiteDataProxyContext["params"]): string | null {
  return resolveWildcardProxyPath(params.path, "/_site-data/");
}

function buildUpstreamHeaders(
  request: Request,
  env: SiteDataProxyEnv,
): Headers | Response {
  const secret = env.SITE_API_SHARED_SECRET?.trim();
  if (!secret) {
    return jsonError(500, "Site API proxy is not configured");
  }
  return buildUpstreamHeadersShared(request, FORWARDED_REQUEST_HEADERS, {
    [SITE_PROXY_HEADER]: secret,
  });
}

function buildProxyResponse(upstreamResponse: Response): Response {
  return buildProxyResponseShared(upstreamResponse, FORWARDED_RESPONSE_HEADERS);
}

function buildCacheKey(request: Request): Request {
  return new Request(request.url, { method: "GET" });
}

function getDefaultCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default;
}

function canCacheResponse(response: Response): boolean {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const warning = response.headers.get("Warning") ?? "";
  return response.ok
    && !response.headers.has("Set-Cookie")
    && !/\bno-store\b/i.test(cacheControl)
    && !/(?:^|,\s*)110\b/.test(warning);
}

function hasConditionalRequestHeaders(request: Request): boolean {
  return request.headers.has("If-None-Match") || request.headers.has("If-Modified-Since");
}

async function queueSiteDataTelemetry(
  context: SiteDataProxyContext,
  upstreamPath: string,
  deliveryPath: "pages-cache-hit" | "pages-upstream-fetch" | "pages-upstream-timeout" | "pages-upstream-error",
): Promise<void> {
  const route = resolveApiRequestRouteMetric(upstreamPath);
  if (!route || !context.env.DB) return;
  const promise = recordSiteDataRequest(context.env.DB, route, deliveryPath, "site-api");
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
    return;
  }
  await promise;
}

export const onRequest = async (context: SiteDataProxyContext): Promise<Response> => {
  const { request, env, params } = context;
  const requestUrl = new URL(request.url);

  const rejected = rejectIfNotSiteDataUiOrigin(request, env, () => jsonError(404, "Not found"));
  if (rejected) return rejected;

  if (request.method !== "GET") return methodNotAllowed();

  const envIssues = validatePagesSiteDataProxyEnv(env);
  for (const issue of envIssues) {
    console.warn(`[site-data-proxy] ${issue.message}`);
  }
  if (envIssues.some((issue) => issue.code === "site-api-origin-missing")) {
    return jsonError(500, "Site API proxy is not configured");
  }

  const requestedPath = resolveRequestedPath(params);
  const upstreamPath = requestedPath ? resolveSiteDataUpstreamPath(requestedPath) : null;
  if (!upstreamPath) return jsonError(404, "Not found");

  const bypassPagesCache = hasConditionalRequestHeaders(request);
  const cacheKey = buildCacheKey(request);
  if (!bypassPagesCache) {
    const cached = await getDefaultCache().match(cacheKey);
    if (cached) {
      await queueSiteDataTelemetry(context, upstreamPath, "pages-cache-hit");
      return cached;
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(request, env);
  if (upstreamHeaders instanceof Response) return upstreamHeaders;

  const upstreamOrigin = resolveSiteApiOrigin(env);
  if (!upstreamOrigin) return jsonError(500, "Site API proxy is not configured");

  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, upstreamOrigin);
  const upstreamResult = await fetchUpstreamProxy(request, {
    upstreamUrl: upstreamUrl.toString(),
    method: "GET",
    headers: upstreamHeaders,
    timeoutMs: DEFAULT_PROXY_TIMEOUT_MS,
    timeoutReason: new DOMException("Site API upstream timed out", "TimeoutError"),
    logPrefix: "site-data-proxy",
    timeoutMessage: "Site API upstream timed out",
    fetchFailedMessage: "Site API upstream fetch failed",
  });
  if (!upstreamResult.ok) {
    await queueSiteDataTelemetry(
      context,
      upstreamPath,
      upstreamResult.errorKind === "timeout" ? "pages-upstream-timeout" : "pages-upstream-error",
    );
    return upstreamResult.response;
  }

  const response = buildProxyResponse(upstreamResult.response);
  await queueSiteDataTelemetry(context, upstreamPath, "pages-upstream-fetch");
  if (!bypassPagesCache && canCacheResponse(response)) {
    await getDefaultCache().put(cacheKey, response.clone());
  }
  return response;
};
```

- [ ] **Step 2: Update `recordSiteDataRequest` signature if needed**

Run: `grep -n "recordSiteDataRequest" functions/lib/request-attribution.ts`

Read the function signature. If its last parameter is typed as `SiteDataRequestUpstreamLane` (union of `"site-api" | "public-api-fallback" | ""`), narrow it to `"site-api"`. If it accepts `string`, no change needed.

If the type exists in `shared/types.ts`:

```bash
grep -n "SiteDataRequestUpstreamLane" shared/
```

If found, either narrow it or leave it as a union — D1 rows already on disk still carry the old value. Narrowing is cleaner; leaving it is safer for historical telemetry rows. Decision: **leave the type as-is** so historical D1 rows don't fail type-level round-trips. Only the call site changes (always passes `"site-api"` now).

- [ ] **Step 3: Delete the now-stale public-fallback test**

In `functions/__tests__/site-data-proxy.test.ts`, delete the `it.skip("allows Pages preview hosts to fall back to the public API origin ...")` block that was skipped in Task 2.

- [ ] **Step 4: Run all Pages tests**

Run: `npx vitest run functions/`
Expected: all PASS.

- [ ] **Step 5: TypeScript check (root + worker)**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -20
cd worker && npx tsc --noEmit 2>&1 | tail -5 ; cd ..
```
Expected: no new errors (the worker tree excludes `functions/`, so only the root config is directly affected).

- [ ] **Step 6: Commit**

```bash
git add functions/ shared/
git commit -m "$(cat <<'EOF'
refactor(site-data): remove public-API fallback from Pages proxy

After the upcoming public-lane cutover, api.pharos.watch/api/* returns
401 without a key, so the fallback path cannot serve data. Always
resolve the site-data upstream to SITE_API_ORIGIN; return 500 when it
is unset. Drops the allowPublicApiFallback flag, the runtime-policy
helper, and the upstream-lane resolver. Narrows telemetry's upstream
lane tag to "site-api".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Worker gate collapse

### Task 5: Test-drive the keyed-only `/api/*` gate

**Files:**
- Test: `worker/src/handlers/http/__tests__/gates.test.ts` (may exist; extend if so, else create)

First check:

```bash
ls worker/src/handlers/http/__tests__/
```

If `gates.test.ts` exists, add to it. If not, create it.

- [ ] **Step 1: Write failing tests for the new behavior**

Add (or create) `worker/src/handlers/http/__tests__/gates.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { evaluateAccessGate } from "../gates";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => ({ results: [], success: true, meta: {} }),
      }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
  return {
    DB: db,
    CORS_ORIGIN: "https://pharos.watch",
    API_KEY_HASH_PEPPER: "test-pepper",
    SITE_API_SHARED_SECRET: "test-secret",
    ...overrides,
  };
}

describe("evaluateAccessGate (post-cutover)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns 401 for unauthenticated /api/* requests", async () => {
    const req = new Request("https://api.pharos.watch/api/peg-summary");
    const url = new URL(req.url);
    const result = await evaluateAccessGate(req, url, makeEnv() as any);
    expect(result.response?.status).toBe(401);
  });

  it("returns 401 when X-API-Key is present but invalid", async () => {
    const req = new Request("https://api.pharos.watch/api/peg-summary", {
      headers: { "X-API-Key": "invalid-key" },
    });
    const url = new URL(req.url);
    const result = await evaluateAccessGate(req, url, makeEnv() as any);
    expect(result.response?.status).toBe(401);
  });

  it("does not block /api/telegram-webhook at the gate", async () => {
    const req = new Request("https://api.pharos.watch/api/telegram-webhook", { method: "POST" });
    const url = new URL(req.url);
    const result = await evaluateAccessGate(req, url, makeEnv() as any);
    expect(result.response).toBeNull();
    expect(result.requestLane).toBeNull();
  });

  it("does not gate non-/api paths at the worker", async () => {
    const req = new Request("https://api.pharos.watch/health");
    const url = new URL(req.url);
    const result = await evaluateAccessGate(req, url, makeEnv() as any);
    expect(result.response).toBeNull();
  });
});
```

Note: this is a skeleton. If the existing test harness stubs the DB differently (e.g., via a factory in `worker/src/__tests__/index.fetch.test.ts`), follow that same pattern. Mirror the `makeEnv` helper used in `index.fetch.test.ts` for consistency.

- [ ] **Step 2: Run the failing tests**

Run: `cd worker && npx vitest run src/handlers/http/__tests__/gates.test.ts ; cd ..`
Expected: `401 for unauthenticated` FAILS (current behavior is to fall through to public-rate-limit path and return null for open routes). Other cases may pass already.

- [ ] **Step 3: Commit the failing tests**

```bash
git add worker/src/handlers/http/__tests__/gates.test.ts
git commit -m "$(cat <<'EOF'
test(gates): add expected-behavior tests for keyed-only /api/*

The current gate allows unauthenticated traffic through for open routes.
These tests describe the post-cutover behavior and are expected to fail
until evaluateAccessGate is collapsed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Collapse `evaluateAccessGate` to require `X-API-Key` for every `/api/*`

**Files:**
- Modify: `worker/src/handlers/http/gates.ts`

- [ ] **Step 1: Rewrite `evaluateAccessGate`**

Replace the `evaluateAccessGate` function body (current lines 57–180 of `worker/src/handlers/http/gates.ts`) with the simplified version:

```typescript
export async function evaluateAccessGate(
  request: Request,
  url: URL,
  env: Env,
): Promise<{
  isAdmin: boolean;
  isSiteProxy: boolean;
  apiKey: AuthenticatedApiKey | null;
  requestLane: "public-api" | "site-api" | null;
  response: Response | null;
}> {
  const isAdmin = await hasValidAdminCredential(request, undefined, env);
  if (isAdmin) {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  const isPreviewRequest = isWorkerPreviewRequest(request);
  const isSiteApiRequest = url.hostname === SITE_API_HOSTNAME;
  const hasSiteProxyCredential = await hasValidSiteProxyCredential(request, env);
  if (isSiteApiRequest) {
    if (!hasSiteProxyCredential) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: errorResponse(401, "Unauthorized") };
    }
    if (!isSiteDataAllowedPath(url.pathname)) {
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response: notFoundResponse() };
    }
    if (request.method !== "GET") {
      const response = errorResponse(405, "Method not allowed");
      response.headers.set("Allow", "GET");
      return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "site-api", response };
    }
    return { isAdmin, isSiteProxy: true, apiKey: null, requestLane: "site-api", response: null };
  }

  if (isPreviewRequest && hasSiteProxyCredential && request.method === "GET" && isSiteDataAllowedPath(url.pathname)) {
    return { isAdmin, isSiteProxy: true, apiKey: null, requestLane: "site-api", response: null };
  }

  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/telegram-webhook") {
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: null, response: null };
  }

  const apiKeyAuth = await authenticateApiKey(
    env.DB,
    request.headers.get("X-API-Key"),
    env.API_KEY_HASH_PEPPER,
    env.API_KEY_HASH_PEPPER_PREVIOUS,
  );
  if (apiKeyAuth.kind !== "valid") {
    if (apiKeyAuth.kind === "unavailable") {
      return {
        isAdmin,
        isSiteProxy: false,
        apiKey: null,
        requestLane: "public-api",
        response: publicApiUnavailableResponse(),
      };
    }
    return {
      isAdmin,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: errorResponse(401, "Unauthorized", {
        message: "Valid X-API-Key required. Contact me@tokenbrice.com for access.",
      }),
    };
  }

  let rateLimitResponse: Response | null;
  try {
    rateLimitResponse = await checkApiKeyRateLimit(
      env.DB,
      apiKeyAuth.key.id,
      apiKeyAuth.key.rateLimitPerMinute,
    );
  } catch (err) {
    console.warn("[public-api-auth] API key rate-limit dependency unavailable:", err);
    return { isAdmin, isSiteProxy: false, apiKey: null, requestLane: "public-api", response: publicApiUnavailableResponse() };
  }
  if (rateLimitResponse) {
    return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: rateLimitResponse };
  }
  try {
    await recordApiKeyUsage(env.DB, apiKeyAuth.key, url.pathname);
  } catch (err) {
    console.warn("[public-api-auth] Failed to record API key usage:", err);
  }
  return { isAdmin, isSiteProxy: false, apiKey: apiKeyAuth.key, requestLane: "public-api", response: null };
}
```

Also remove the imports and helper that are no longer needed. Update the import block at the top of the file to drop:

```typescript
// delete:
import { checkPublicApiRateLimit } from "../../lib/rate-limit";
import {
  resolvePublicApiAuthMode,
  resolvePublicApiRateLimitSalt,
  validateWorkerEnvContract,
} from "../../lib/env";
import {
  PUBLIC_API_RATE_LIMIT_MAX_REQUESTS,
  PUBLIC_API_RATE_LIMIT_WINDOW_SEC,
} from "../../lib/public-api-limits";
```

Replace with:

```typescript
import { validateWorkerEnvContract } from "../../lib/env";
```

Delete the `getPublicApiAccess` import from `@shared/lib/api-endpoints` if it was imported for this function. Confirm it isn't used elsewhere in the file; if not, drop it. If it is, leave it.

Delete the helper:

```typescript
function resolveClientIp(request: Request): string { ... }
```

`warnWorkerEnvIssuesOnce`, `handleMaintenanceMode`, `publicApiUnavailableResponse`, `notFoundResponse` all stay.

- [ ] **Step 2: Error-response helper — verify signature**

The new 401 branch uses `errorResponse(401, "Unauthorized", { message: "..." })`. Confirm `errorResponse` accepts a third argument for body extras. Run:

```bash
grep -n "export function errorResponse" worker/src/lib/api-response.ts worker/src/lib/api-utils.ts 2>/dev/null
```

Read the signature. If it doesn't accept a third `extras` arg, use whatever the real signature is — e.g.:

```typescript
return errorResponse(401, "Unauthorized: valid X-API-Key required. Contact me@tokenbrice.com for access.");
```

Use the simplest form that compiles.

- [ ] **Step 3: Run gate tests**

Run: `cd worker && npx vitest run src/handlers/http/__tests__/gates.test.ts ; cd ..`
Expected: all PASS.

- [ ] **Step 4: Run Worker type check**

Run: `cd worker && npx tsc --noEmit 2>&1 | tail -20 ; cd ..`
Expected: errors in files that still import the deleted symbols (`rate-limit`, `public-api-limits`, env helpers) — those are resolved in Tasks 7–9. If any error is NOT about one of those, fix it here.

- [ ] **Step 5: Commit**

Do not commit yet — the tree has dangling imports that Task 7 will delete. Wait until Phase 3 completes.

---

### Task 7: Update `index.fetch.test.ts` for the new 401 behavior

**Files:**
- Modify: `worker/src/__tests__/index.fetch.test.ts`

- [ ] **Step 1: Survey the file**

Run: `wc -l worker/src/__tests__/index.fetch.test.ts`

The file has many scenarios using `PUBLIC_API_AUTH_MODE` and `PUBLIC_API_RATE_LIMIT_SALT`. Read it top-to-bottom before editing:

```bash
grep -n "PUBLIC_API_AUTH_MODE\|PUBLIC_API_RATE_LIMIT_SALT" worker/src/__tests__/index.fetch.test.ts
```

Group the references into:
- **Env fixture entries** (e.g., line 14): delete the lines setting `PUBLIC_API_RATE_LIMIT_SALT` and `PUBLIC_API_AUTH_MODE` in env helpers.
- **Tests asserting auth-off behavior** (`PUBLIC_API_AUTH_MODE: "off"`): these tests currently expect unauthenticated requests to succeed. Delete them — the behavior no longer exists.
- **Tests asserting report-only behavior** (`PUBLIC_API_AUTH_MODE: "report-only"`): delete.
- **Tests asserting enforce behavior** (`PUBLIC_API_AUTH_MODE: "enforce"`): keep as the canonical 401/valid-key flow; remove the env entry (enforce is the only behavior now).

- [ ] **Step 2: Execute the edits**

For each line found in Step 1:

1. In `makeEnv` (or whichever helper builds the env), delete the `PUBLIC_API_AUTH_MODE` and `PUBLIC_API_RATE_LIMIT_SALT` properties.
2. For each `makeEnv({ ... PUBLIC_API_AUTH_MODE: "off" ... })` call, evaluate the whole test: if it asserts that an unauthenticated `/api/*` request returns a 2xx payload, delete the test. If it happens to use `"off"` but doesn't rely on the behavior, just delete the property.
3. For `"report-only"`: delete the test wholesale.
4. For `"enforce"`: delete just the property.
5. Delete any `PUBLIC_API_RATE_LIMIT_SALT: "test-salt"` / `undefined` entries.

- [ ] **Step 3: Add a canonical 401 assertion**

If none of the surviving tests already covers it, add:

```typescript
it("rejects /api/* without X-API-Key with 401", async () => {
  const env = makeEnv();
  const response = await worker.fetch(
    new Request("https://api.pharos.watch/api/peg-summary"),
    env as Env,
    makeExecutionContext(),
  );
  expect(response.status).toBe(401);
});
```

(Adapt to the file's helper names.)

- [ ] **Step 4: Run the full test file**

Run: `cd worker && npx vitest run src/__tests__/index.fetch.test.ts ; cd ..`
Expected: all PASS. If the file has other fixture holes caused by the removals (e.g., `env` type mismatches), fix them here.

- [ ] **Step 5: Stage but do not commit yet**

Continue to Phase 3 cleanup; commit with Task 6 + 7 + 8 together.

---

## Phase 3 — Delete dead public-lane code

### Task 8: Delete `checkPublicApiRateLimit` and `public-api-limits.ts`

**Files:**
- Modify: `worker/src/lib/rate-limit.ts`
- Delete: `worker/src/lib/public-api-limits.ts`
- Modify: `worker/src/lib/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Remove the public rate-limit function + state**

In `worker/src/lib/rate-limit.ts`:

Delete:
- The `PUBLIC_API_PRUNE_WINDOW_MULTIPLIER`, `PUBLIC_API_EMERGENCY_BLOCK_AFTER_FAILURES`, `PUBLIC_API_EMERGENCY_RETRY_AFTER_SEC`, `PUBLIC_API_FAILURE_DECAY_SEC` constants.
- The `buildRateLimitExceededResponse` helper (unused after removal).
- The `buildRateLimitUnavailableResponse` helper.
- The entire `checkPublicApiRateLimit` function.
- The public-related fields inside the `_rl = new IsolateLocalState(...)` state: `lastPublicApiPruneBucket`, `publicApiPruneFailures`, `consecutivePublicApiRateLimitFailures`, `lastPublicApiRateLimitFailureAt`, `pendingPublicPrune`.
- The `pendingPublicPrune` handling inside `flushPendingPrunes`.
- The `errorResponse` import if no longer used.

Keep:
- `RATE_LIMITS`, `CRAWL_BUDGETS` (cron-facing constants, unrelated).
- `checkFeedbackRateLimit` and its helpers (`hashIpWithSalt`, feedback state fields).
- `resetRateLimitStateForTests` (still used by feedback tests — verify).
- `flushPendingPrunes` (still handles `pendingFeedbackPrune`).

- [ ] **Step 2: Delete public-rate-limit tests**

Open `worker/src/lib/__tests__/rate-limit.test.ts`. If it only contains `describe("checkPublicApiRateLimit", ...)`, delete the entire file. Otherwise, delete only the `describe("checkPublicApiRateLimit", ...)` block.

- [ ] **Step 3: Delete the re-export shim**

```bash
git rm worker/src/lib/public-api-limits.ts
```

- [ ] **Step 4: Worker type check**

Run: `cd worker && npx tsc --noEmit 2>&1 | tail -20 ; cd ..`
Expected: errors only about env.ts symbols (`PUBLIC_API_RATE_LIMIT_SALT`, `resolvePublicApiRateLimitSalt`, `resolvePublicApiAuthMode`, `PublicApiAuthMode`) still referenced in env.ts itself. Those are fixed in Task 9.

---

### Task 9: Remove public-lane env surface

**Files:**
- Modify: `worker/src/lib/env.ts`
- Modify: `worker/src/lib/__tests__/env.test.ts`

- [ ] **Step 1: Update `worker/src/lib/env.ts`**

Remove, in order:

1. From the `Env` interface: delete `PUBLIC_API_AUTH_MODE?: string;` and `PUBLIC_API_RATE_LIMIT_SALT?: string;`.
2. From `WorkerEnvIssue["code"]`: delete `"public-api-rate-limit-misconfigured"` and `"public-api-auth-mode-invalid"`.
3. Delete the `ResolvedPublicApiRateLimitSalt` interface.
4. Delete `PublicApiAuthMode` type alias.
5. Delete the `resolvePublicApiRateLimitSalt` function.
6. Delete the `resolvePublicApiAuthMode` function.
7. In `validateWorkerEnvContract`:
   - Narrow the `Pick<Env, ...>` signature to drop `"PUBLIC_API_RATE_LIMIT_SALT"` and `"PUBLIC_API_AUTH_MODE"`.
   - Delete the `resolvePublicApiRateLimitSalt(env)` check block (pushes `public-api-rate-limit-misconfigured`).
   - Delete the `PUBLIC_API_AUTH_MODE` validation block.
   - Replace the `if (resolvePublicApiAuthMode(env) !== "off" && !hasConfiguredValue(env.API_KEY_HASH_PEPPER))` check with an unconditional one: always require `API_KEY_HASH_PEPPER` since the keyed lane is always enforcing now.

New replacement for that last block:

```typescript
if (!hasConfiguredValue(env.API_KEY_HASH_PEPPER)) {
  issues.push({
    code: "public-api-auth-pepper-missing",
    message: "API_KEY_HASH_PEPPER must be configured; /api/* requires a valid X-API-Key.",
  });
}
```

- [ ] **Step 2: Update `env.test.ts`**

In `worker/src/lib/__tests__/env.test.ts`:
- Delete the `describe("resolvePublicApiRateLimitSalt", ...)` block.
- Delete any describe/tests covering `resolvePublicApiAuthMode`.
- Remove `PUBLIC_API_RATE_LIMIT_SALT` and `PUBLIC_API_AUTH_MODE` from any `validateWorkerEnvContract` test fixtures.
- If a test asserted on `public-api-rate-limit-misconfigured` or `public-api-auth-mode-invalid` issue codes, delete those assertions.
- Add/keep an assertion that `validateWorkerEnvContract` emits `public-api-auth-pepper-missing` when `API_KEY_HASH_PEPPER` is absent.

- [ ] **Step 3: Run worker tests**

Run: `cd worker && npx vitest run ; cd ..`
Expected: all PASS.

- [ ] **Step 4: Run worker type check**

Run: `cd worker && npx tsc --noEmit 2>&1 | tail -20 ; cd ..`
Expected: no errors.

---

### Task 10: Delete public-lane constants from `shared/lib/ops-limits.ts`

**Files:**
- Modify: `shared/lib/ops-limits.ts`

- [ ] **Step 1: Delete the two public-lane constants**

Edit `shared/lib/ops-limits.ts`. Remove lines:

```typescript
export const PUBLIC_API_RATE_LIMIT_MAX_REQUESTS = 300;
export const PUBLIC_API_RATE_LIMIT_WINDOW_SEC = 60;
```

Keep everything else (circuit-breaker constants, API-key constants, feedback constants).

- [ ] **Step 2: Confirm no stragglers**

Run:
```bash
grep -rn "PUBLIC_API_RATE_LIMIT_MAX_REQUESTS\|PUBLIC_API_RATE_LIMIT_WINDOW_SEC" worker/ shared/ functions/ --include="*.ts" 2>/dev/null
```
Expected: no output.

- [ ] **Step 3: Full type check both trees**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -5
cd worker && npx tsc --noEmit 2>&1 | tail -5 ; cd ..
```
Expected: no errors.

---

### Task 11: Remove env-contract entries for `PUBLIC_API_RATE_LIMIT_SALT` and `PUBLIC_API_AUTH_MODE`

**Files:**
- Modify: `shared/lib/env-contract.ts`

- [ ] **Step 1: Delete the two binding entries**

Read `shared/lib/env-contract.ts` around lines 185–200 and 315–330.

Delete the binding entry for `PUBLIC_API_AUTH_MODE` (around line 189):

```typescript
{
  key: "PUBLIC_API_AUTH_MODE",
  valueType: "string",
  description: "Public API auth mode: `off`, `report-only`, or `enforce`.",
  example: { section: "workerOptional", value: "" },
  runtimes: { worker: { order: 6, status: "optional" } },
},
```

Delete the binding entry for `PUBLIC_API_RATE_LIMIT_SALT` (around line 319):

```typescript
{
  key: "PUBLIC_API_RATE_LIMIT_SALT",
  valueType: "string",
  description: "Dedicated salt for hashed public API rate limiting; deployed public API traffic returns `503` until configured.",
  example: { section: "workerOptional", value: "" },
  runtimes: { worker: { order: 20, status: "optional" } },
},
```

- [ ] **Step 2: Delete the doc-comment hook**

Delete the `if (binding.key === "PUBLIC_API_RATE_LIMIT_SALT") { ... }` block around line 654:

```typescript
if (binding.key === "PUBLIC_API_RATE_LIMIT_SALT") {
  lines.push("# Required for deployed public API traffic. Public `/api/*` requests return 503");
  lines.push("# until this binding is configured.");
}
```

- [ ] **Step 3: Re-sequence ordering if needed**

Check whether any `order:` values in the remaining `workerOptional` entries need to be adjusted. Likely unnecessary — orders are just sort keys, gaps are fine.

- [ ] **Step 4: Run env-contract tests**

```bash
grep -rn "env-contract\|envContract" worker/src/__tests__ shared/lib/__tests__ 2>/dev/null | head -5
cd worker && npx vitest run ; cd ..
npm test -- --run 2>&1 | tail -20
```
Expected: all PASS.

- [ ] **Step 5: Commit Phase 2 + Phase 3 together**

```bash
git add worker/ shared/
git commit -m "$(cat <<'EOF'
feat(api): require X-API-Key for all /api/* requests, remove public lane

- Collapse evaluateAccessGate: every /api/* non-admin non-site-proxy
  non-telegram request must present a valid X-API-Key. 401 otherwise.
- Delete the IP-salted public rate limiter (checkPublicApiRateLimit) and
  its D1 prune state.
- Delete PUBLIC_API_AUTH_MODE, PUBLIC_API_RATE_LIMIT_SALT, and their env
  helpers and env-contract entries.
- Delete PUBLIC_API_RATE_LIMIT_MAX_REQUESTS and PUBLIC_API_RATE_LIMIT_WINDOW_SEC.
- Update tests: keyed-only gate tests added, auth-mode tests removed.

API_KEY_HASH_PEPPER is now unconditionally required for /api/* access.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — UI and documentation

### Task 12: Update UI copy

**Files:**
- Modify: `src/app/about/api/page.tsx`
- Modify: `src/components/status/request-source-attribution-card.tsx` (if it mentions the lane)
- Modify: `src/components/status/api-key-load-table.tsx` (if it mentions the lane)

- [ ] **Step 1: Rewrite the "Website lane" card on the about/api page**

Find and edit `src/app/about/api/page.tsx` around line 30–34 and line 59.

Replace the current "Browsers on the site use same-origin `/_site-data/*`, which proxies to the internal Worker lane. External consumers should not use this path." with wording that is factually correct:

```tsx
{
  title: "Website lane",
  // tighten: card contents
  body: "Browsers on pharos.watch use same-origin `/_site-data/*`. This path accepts only requests whose Origin or Referer maps to pharos.watch (or the ops UI). External consumers must use `api.pharos.watch/api/*` with a valid X-API-Key.",
}
```

Around line 59 (the partner-API summary copy), change:

> "The public lane is https://api.pharos.watch and is for external integrations. The website lane is same-origin /_site-data/* on pharos.watch, used only by the Pharos web app itself. External consumers should call the public lane directly."

to:

> "The partner API lane is https://api.pharos.watch and requires a valid X-API-Key header. Contact me@tokenbrice.com to request one. The website lane is same-origin /_site-data/* on pharos.watch, gated to the site's own origin — external consumers cannot use it."

(Preserve the JSX/prop shape of the surrounding file; only the string content changes.)

- [ ] **Step 2: Check status-page copies**

Read `src/components/status/request-source-attribution-card.tsx` and `src/components/status/api-key-load-table.tsx`. Where they describe the `/_site-data/*` lane, update phrasing to match the new reality (same-origin, header-gated). Do not change the telemetry semantics — the component still distinguishes `site-api` upstream lanes from other sources.

- [ ] **Step 3: Start the dev server and verify visually**

Run: `npm run dev`

Open the browser at `http://localhost:3000/about/api` and confirm:
- Website-lane card reads correctly.
- Partner API copy reads correctly.
- No layout regressions.

If any dev-server errors, fix them.

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
docs(ui): update API lane descriptions for keyed-only public access

The website lane is now same-origin header-gated, and the partner lane
requires an X-API-Key. Update the about/api page and status cards to
reflect the real access model.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Update docs

**Files:**
- Modify: `docs/api-reference.md`
- Modify: `docs/architecture.md`
- Modify: `docs/worker-and-api-limits.md`
- Modify: `docs/api-endpoint-authoring.md`
- Modify: `docs/deployment-process.md`
- Modify: `docs/testing.md`
- Modify: `docs/status-dashboard.md`

- [ ] **Step 1: Update `docs/api-reference.md`**

Read the file. Rewrite the access/authentication intro section to state:

> **All `/api/*` endpoints on `api.pharos.watch` require a valid `X-API-Key` header.** Contact me@tokenbrice.com to request one. Requests without a key return `401 Unauthorized`. Per-key rate limits default to 120 req/min (configurable per key).

Delete any section describing the public-tier 300 req/min bucket or unauthenticated access.

- [ ] **Step 2: Update `docs/architecture.md`**

- Around line 167: the sentence "requires `SITE_API_ORIGIN` on the production Pages hosts (`pharos.watch`, `ops.pharos.watch`), and still allows preview/local rehearsal to fall back to `https://api.pharos.watch` when that origin is intentionally unset" — rewrite. The site-data lane now requires `SITE_API_ORIGIN` on all hosts; the public-API fallback is removed.
- Same paragraph: remove the sentence about "exempt routes, auth-off/report-only rehearsals, or proxy setups that also forward a valid API key". Replace with a single-sentence statement of the new behavior.
- Anywhere describing auth-mode `off`/`report-only`/`enforce`: delete — the spectrum no longer exists.

- [ ] **Step 3: Update `docs/worker-and-api-limits.md`**

Remove any row/section describing the 300 req/min public tier. Keep per-key quotas and bounds documented.

- [ ] **Step 4: Update `docs/api-endpoint-authoring.md`**

Line 36 references `/_site-data/*` lane without needing substantive change. Verify the surrounding text is still accurate after the fallback removal; adjust if it mentions the public-API fallback.

- [ ] **Step 5: Update `docs/deployment-process.md` and `docs/testing.md`**

Line 148–150, 252 of `deployment-process.md` and 119–120, 196 of `testing.md` describe deploy/smoke flows that set a `STATIC_EXPORT_SITE_API_BASE` or fall back to the public API for `/_site-data/*` rehearsal. With the fallback removed, any `/_site-data/*` rehearsal must point at a site-api base and forward `SITE_API_SHARED_SECRET`. Remove the conditional wording that says "when `STATIC_EXPORT_SITE_API_BASE` is configured or the same selected API base by default" — make it required.

Also remove any mention of `PUBLIC_API_AUTH_MODE` or the `off`/`report-only` rehearsal toggle.

- [ ] **Step 6: Update `docs/status-dashboard.md`**

Lines 83 and 88 mention `/_site-data/*` as the probe path. These remain accurate. No change unless surrounding wording references the deleted fallback.

- [ ] **Step 7: Run doc-count guard**

Run: `npm run check:doc-counts 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: document keyed-only /api/* and same-origin-gated /_site-data/*

Remove references to unauthenticated public access, the 300 rpm public
tier, PUBLIC_API_AUTH_MODE, and the site-data public-API fallback.
Reflect that SITE_API_ORIGIN is now required on all hosts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Verification

### Task 14: Full pre-push validation

**Files:** none

- [ ] **Step 1: Lint**

Run: `npm run lint 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 2: Unit tests**

Run: `npm test -- --run 2>&1 | tail -20`
Expected: all PASS.

Run: `cd worker && npx vitest run 2>&1 | tail -10 ; cd ..`
Expected: all PASS.

- [ ] **Step 3: Type checks**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -5
cd worker && npx tsc --noEmit 2>&1 | tail -5 ; cd ..
```
Expected: no errors in either tree.

- [ ] **Step 4: Build**

Run: `npm run build 2>&1 | tail -20`
Expected: successful Next.js static export.

- [ ] **Step 5: Merge-gate**

Run: `npm run test:merge-gate 2>&1 | tail -30`
Expected: PASS. If it flags Pages-build or worker-type-check jobs, verify they are green.

- [ ] **Step 6: Smoke the local dev server**

Start dev server in the background:
```bash
npm run dev > /tmp/dev.log 2>&1 &
DEV_PID=$!
sleep 8
```

Visit `http://localhost:3000/about/api` in a browser. Confirm:
- Page renders without error.
- Website lane + Partner API cards show the new copy.
- No console errors in the browser devtools.

Stop server:
```bash
kill $DEV_PID
```

- [ ] **Step 7: Residual grep check**

Run:
```bash
grep -rn "PUBLIC_API_RATE_LIMIT\|checkPublicApiRateLimit\|resolvePublicApiRateLimitSalt\|resolvePublicApiAuthMode\|PUBLIC_API_AUTH_MODE\|allowPublicApiFallback\|public-api-fallback" \
  worker/ shared/ functions/ src/ docs/ --include="*.ts" --include="*.tsx" --include="*.md" 2>/dev/null | grep -v -E "^(docs/changelog|docs/retrospectives|agents/)" 
```
Expected: no output except possibly in changelog/retrospective/agents files (those are historical records and may retain references).

One exception: the D1 schema for `site_data_request_stats` may still reference the `public-api-fallback` lane string as a historical value. That's fine — leave the column as-is; only new rows will use `site-api`.

- [ ] **Step 8: Commit verification fixes if any**

If any of the above turned up fixable issues, commit them.

```bash
git status
git add -A <files-intentionally-listed>
git commit -m "$(cat <<'EOF'
fix: address residual references found during verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Manual post-deploy smoke checklist

**Files:** none (checklist for post-merge)

These are not run during implementation. Include them in the PR description so the merger can run them right after deploy.

- [ ] **Step 1: Document the post-deploy smoke commands**

```bash
# Partner API — no key → 401
curl -s -o /dev/null -w "%{http_code}\n" https://api.pharos.watch/api/peg-summary
# expected: 401

# Partner API — with key → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $KEY" https://api.pharos.watch/api/peg-summary
# expected: 200

# Partner API — invalid key → 401
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: not-a-real-key" https://api.pharos.watch/api/peg-summary
# expected: 401

# Site-data — no Origin/Referer → 404
curl -s -o /dev/null -w "%{http_code}\n" https://pharos.watch/_site-data/peg-summary
# expected: 404

# Site-data — allowed Origin → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://pharos.watch" https://pharos.watch/_site-data/peg-summary
# expected: 200

# Site-data — allowed Referer only → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Referer: https://pharos.watch/peg-summary" https://pharos.watch/_site-data/peg-summary
# expected: 200

# Site-data — foreign Origin → 404
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example.com" https://pharos.watch/_site-data/peg-summary
# expected: 404

# Browser load of pharos.watch — sanity check in DevTools
# Open https://pharos.watch in Chrome. Confirm the peg-summary and stablecoins
# requests in the Network tab still return 200 (they hit /_site-data/* with a
# real Origin header).
```

- [ ] **Step 2: Monitoring**

Watch worker logs for a 30-minute window post-deploy:

```bash
cd worker && npx wrangler tail --format pretty
```

Expected signals:
- Uptick in 401 responses on `/api/*` from anonymous callers — benign.
- No 500s from the site-data proxy.
- No `[public-api-auth]` warnings about missing rate-limit salt (config is gone).

- [ ] **Step 3: Rollback command (reference only)**

If anything breaks:

```bash
git log --oneline -n 10         # find the commit SHA of the tightening set
git revert <sha>..HEAD          # revert the range
npm run build
wrangler deploy                 # from worker/
# Pages redeploys automatically via CI
```

Re-populate `PUBLIC_API_RATE_LIMIT_SALT` in the Cloudflare Worker environment if it was pruned at the dashboard level. (It should not have been — only the code reference was removed, not the binding.)

---

## Notes for executors

- **TDD discipline:** Tasks 1, 5 have explicit failing-test-first steps. Don't skip them.
- **Commit cadence:** commits land at Task 1, 2, 4, 5, 11 (covers Phase 2+3), 12, 13, and optionally 14. Don't batch everything into one commit; the intermediate commits make review and revert cheaper.
- **Do not skip hooks.** CLAUDE.md is explicit: `npm run test:merge-gate` is the pre-push guard. Run it.
- **Surgical changes only.** The spec explicitly leaves the D1 `site_data_request_stats` column alone even though `public-api-fallback` values become historical — don't migrate. Don't touch unrelated tests. Don't "improve" the telemetry model.
- **Ambiguity fallback:** if a file surprises you (e.g., a test helper you didn't expect), read it fully before editing. Do not invent shapes.
- **Time estimate:** 2–4 hours end-to-end for a focused executor, most of it in Phase 2 test updates.
