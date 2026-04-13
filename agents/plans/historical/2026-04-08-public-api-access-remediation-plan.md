# Public API Access Remediation Plan

Date: 2026-04-08
Scope: `api.pharos.watch` no-key surface after keyed auth rollout
Status: Research complete, no behavior changes implemented in this step

## Goal

Reduce unintended anonymous or no-key traffic on `https://api.pharos.watch` without breaking:

- website reads on `pharos.watch` / `ops.pharos.watch`
- Pages preview and local smoke paths
- OG crawler fetches
- Telegram webhook delivery
- public feedback submission
- existing status transparency where intentionally public

## Current Findings

The runtime source of truth is the shared endpoint metadata plus the HTTP access gate:

- `shared/lib/api-endpoints/definitions.ts`
- `shared/lib/api-endpoints/validation.ts`
- `worker/src/handlers/http/gates.ts`

Current routes that do not require `X-API-Key` on `api.pharos.watch` are:

- `GET /api/health`
- `GET /api/public-status-history`
- `GET /api/telegram-pulse`
- `GET /api/og/*`
- `POST /api/feedback`
- `POST /api/telegram-webhook`

Important distinction:

- `POST /api/telegram-webhook` is not anonymous. It bypasses `X-API-Key` but still requires `X-Telegram-Bot-Api-Secret-Token`.

## Target-State Decision

### Keep Public On `api.pharos.watch`

- `GET /api/health`
  - Reason: public status transparency and external reachability checks are legitimate uses.
  - Internal consumers also exist, but they do not require public-host anonymity.
  - Do not change access in this remediation.
  - Follow-up idea, not part of this plan: consider a future split between a minimal public health surface and a richer site/admin health surface if abuse remains high.

- `GET /api/og/*`
  - Reason: social crawlers and metadata fetchers must be able to reach OG images without custom auth.

- `POST /api/feedback`
  - Reason: the product intentionally allows unauthenticated feedback submission from the website.
  - Current frontend submits directly to `buildApiUrl("/api/feedback")`, not `/_site-data/*`.

- `POST /api/telegram-webhook`
  - Reason: Telegram must be able to reach this endpoint directly.
  - Keep external reachability, but fix docs to stop describing it as anonymous public access.

### Tighten On `api.pharos.watch`

- `GET /api/public-status-history`
  - Change from `publicApiAccess: "exempt"` to `publicApiAccess: "protected"`.
  - Keep `siteDataAccess: "allowed"`.
  - Rationale: this is website/status-page data, not a clear external integration endpoint.

- `GET /api/telegram-pulse`
  - Change from `publicApiAccess: "exempt"` to `publicApiAccess: "protected"`.
  - Keep `siteDataAccess: "allowed"`.
  - Rationale: this is website landing-page vanity data, not a meaningful external public API surface.

## Consumer And Access Research

### `GET /api/public-status-history`

Internal consumers:

- [`src/hooks/use-public-status-history.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-public-status-history.ts)
- [`src/app/status/client.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/status/client.tsx)
- status dashboard docs also describe this route as part of the public status page

Transport behavior:

- Browser reads already route through same-origin `/_site-data/*` on site/ops/Pages hosts via [`src/lib/api.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts)
- `/_site-data/*` proxies only allowlisted GET paths via [`functions/_site-data/[[path]].ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/_site-data/[[path]].ts)
- The route is already site-data allowlisted via `SITE_DATA_ALLOWED_ENDPOINT_KEYS`

Risk:

- Production Pages hosts fail closed if `SITE_API_ORIGIN` is missing, so production website traffic is safe if env is correct.
- Preview/local still allow public-API fallback when `SITE_API_ORIGIN` is unset. If this route becomes protected before those paths are hardened, preview/local browsing can regress with `401`.

### `GET /api/telegram-pulse`

Internal consumers:

- [`src/hooks/use-telegram-pulse.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-telegram-pulse.ts)
- [`src/app/telegram/telegram-pulse-strip.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/telegram/telegram-pulse-strip.tsx)
- [`src/app/telegram/page.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/telegram/page.tsx)

Transport behavior:

- Same browser/site-data behavior as above via [`src/lib/api.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts)
- The route is already site-data allowlisted

Risk:

- Same preview/local public-host fallback risk as `public-status-history`

### `GET /api/health`

Internal consumers:

- [`src/hooks/api-hooks.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/api-hooks.ts)
- [`src/app/status/client.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/status/client.tsx)
- [`src/components/site-header.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/site-header.tsx)
- [`src/hooks/use-endpoint-probes.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-endpoint-probes.ts)
- [`worker/src/cron/status-self-check.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/status-self-check.ts)
- [`scripts/smoke-api.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-api.mjs)
- [`scripts/smoke-transport.mjs`](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-transport.mjs)

Decision:

- Do not change access in this remediation because the route has legitimate public-monitoring value and is part of the public status story.
- Documentation should explicitly position it as intentionally public rather than accidentally exempt.

### `GET /api/og/*`

Internal and external consumers:

- Metadata helpers use direct public API URLs via [`src/lib/page-metadata.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/page-metadata.ts)
- Social crawlers fetch these URLs directly

Decision:

- Keep public

### `POST /api/feedback`

Internal consumers:

- [`src/components/feedback-modal.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/feedback-modal.tsx)
- feedback docs explicitly describe direct submission to the public API host

Decision:

- Keep public in this remediation
- If abuse rises, address with anti-abuse controls rather than moving it behind API keys

### `POST /api/telegram-webhook`

External consumer:

- Telegram Bot API only

Decision:

- Keep externally reachable
- Fix documentation to describe it as a special-auth route rather than anonymous access

## Documentation Gaps To Remediate

### Must Fix

- [`docs/api-reference.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
  - Intro “Anonymous public access” list is currently inaccurate.
  - It omits `GET /api/public-status-history` and `GET /api/telegram-pulse`.
  - It conflates “no API key required” with “anonymous” for `POST /api/telegram-webhook`.
  - There is no dedicated endpoint section for `GET /api/telegram-pulse`.

- [`src/app/about/api/page.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/about/api/page.tsx)
  - Quick facts list of exempt routes is stale.

- [`docs/api-page.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-page.md)
  - Needs to remain aligned with the `/about/api/` hero/auth copy after the route list changes.

### Should Fix

- [`docs/status-dashboard.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/status-dashboard.md)
  - Replace vague “public read lane” wording for `public-status-history` with explicit same-origin `/_site-data/*` website-lane wording.

- [`docs/architecture.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
  - Route table currently omits `GET /api/public-status-history` and `GET /api/telegram-pulse`.

- [`docs/worker-infrastructure.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
  - Public auth/rate-limit wording should accurately describe the remaining exempt set and the Telegram webhook’s alternate auth.

## Implementation Plan

### Phase 0: Baseline And Safety Checks

1. Capture a 7-day and 30-day baseline for route demand before changing access.
   - Preferred source: `GET /api/request-source-stats` on the ops lane with a high enough `routeLimit`.
   - If either target route is not in the top-N response, use direct D1 inspection via Wrangler against `api_request_consumer_stats` / `site_data_request_stats`.
2. Verify production Pages env is healthy for the site-data lane.
   - `SITE_API_ORIGIN` set
   - `SITE_API_SHARED_SECRET` set
   - Pages `DB` binding present
3. Verify preview/smoke paths that render `/status/` or `/telegram/`.
   - CI static export smoke already passes `STATIC_EXPORT_SITE_API_BASE` and `STATIC_EXPORT_SITE_API_SHARED_SECRET`; confirm this remains true after the change.
   - Check Pages preview environment policy for `SITE_API_ORIGIN`. If preview deployments still rely on public-host fallback, decide whether to harden preview config first or implement the contingency described below.

Exit criteria:

- We know real traffic magnitude for the two target routes.
- Production website lane is confirmed healthy.
- Preview/smoke strategy is chosen before the auth cutover.

### Phase 1: Tighten Shared Endpoint Metadata

Code changes to make:

1. In [`shared/lib/api-endpoints/definitions.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints/definitions.ts):
   - Remove `public-status-history` from `PUBLIC_API_EXEMPT_ENDPOINT_KEYS`
   - Remove `telegram-pulse` from `PUBLIC_API_EXEMPT_ENDPOINT_KEYS`
   - Keep both in `SITE_DATA_ALLOWED_ENDPOINT_KEYS`
2. Do not change:
   - `health`
   - `feedback`
   - `telegram-webhook`
   - OG dynamic exemption behavior in validation

Expected behavior after this phase:

- `api.pharos.watch/api/public-status-history` requires `X-API-Key`
- `api.pharos.watch/api/telegram-pulse` requires `X-API-Key`
- `site-api.pharos.watch` and `/_site-data/*` continue to serve both routes to the website with `X-Pharos-Site-Proxy-Secret`

### Phase 2: Preview/Local Fallback Hardening

Primary path, lowest product risk:

1. Keep production behavior unchanged.
2. Ensure environments that browse the site through `/_site-data/*` do not depend on public-host fallback for these routes.
3. Specifically:
   - keep CI/static export smoke targeting a Worker preview URL or `site-api` host through `STATIC_EXPORT_SITE_API_BASE`
   - ensure `STATIC_EXPORT_SITE_API_SHARED_SECRET` remains present in Pages workflow inputs
   - ensure any Pages preview environments used for human QA have `SITE_API_ORIGIN` configured so they proxy to `site-api` instead of `api.pharos.watch`

Contingency if preview Pages cannot be configured in time:

1. Add an optional Pages-proxy-only authenticated fallback for preview/local `public-api-fallback` mode.
2. Shape:
   - only in `functions/_site-data/[[path]].ts`
   - only when upstream lane resolves to `public-api-fallback`
   - only when an explicit env var is present
   - inject `X-API-Key` to the public-host fallback request
3. This should be treated as a contingency, not the preferred long-term design, because it expands secret distribution and keeps preview traffic tied to the public integration lane.

### Phase 3: Tests

Update or add tests in these areas:

1. Shared endpoint policy tests
   - [`src/lib/__tests__/api-endpoints.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/__tests__/api-endpoints.test.ts)
   - Assert:
     - `getPublicApiAccess("/api/public-status-history") === "protected"`
     - `getPublicApiAccess("/api/telegram-pulse") === "protected"`
     - `isSiteDataAllowedPath(...)` remains `true` for both

2. Site-data route mapping tests
   - [`shared/lib/__tests__/site-data-routes.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/site-data-routes.test.ts)
   - Add explicit mapping assertions for:
     - `/_site-data/public-status-history`
     - `/_site-data/telegram-pulse`

3. Worker access-gate tests
   - [`worker/src/__tests__/index.fetch.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/__tests__/index.fetch.test.ts)
   - Add:
     - `401` on `api.pharos.watch` without key for both target routes in `PUBLIC_API_AUTH_MODE=enforce`
     - `200` on `site-api.pharos.watch` with `X-Pharos-Site-Proxy-Secret` for both target routes

4. Pages proxy tests
   - [`functions/__tests__/site-data-proxy.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/__tests__/site-data-proxy.test.ts)
   - Add explicit allowlisted proxy coverage for both target routes
   - If the contingency fallback-key path is implemented, add tests covering key injection only in preview/local `public-api-fallback` mode

5. Browser request-routing tests
   - [`src/lib/__tests__/api-fetch-contracts.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/__tests__/api-fetch-contracts.test.ts)
   - Add targeted assertions that browser requests for the two routes use `/_site-data/*` on site/ops hosts

### Phase 4: Documentation Remediation

1. Update [`docs/api-reference.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
   - Replace the intro list with the final no-key set
   - Change wording from “Anonymous public access” to “No `X-API-Key` required” or equivalent
   - Explicitly call out that Telegram webhook uses alternate auth
   - Add a full section for `GET /api/telegram-pulse`
   - Update `GET /api/public-status-history` auth text to protected if the access change lands

2. Update [`src/app/about/api/page.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/about/api/page.tsx)
   - Fix the quick-facts route summary
   - Keep the hero copy aligned with the actual lane split

3. Update [`docs/api-page.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-page.md)
   - Reflect the `/about/api/` hero/auth copy and the final exempt-route story

4. Update [`docs/status-dashboard.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/status-dashboard.md)
   - Clarify that website reads for status history use same-origin `/_site-data/*`

5. Update [`docs/architecture.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
   - Add the missing route entries for `public-status-history` and `telegram-pulse`

6. Update [`docs/worker-infrastructure.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
   - Align public-auth wording with the actual post-change exempt set

### Phase 5: Validation And Rollout

Run before merge:

- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:merge-gate`

Additional targeted verification:

1. Worker auth behavior
   - `curl https://api.pharos.watch/api/public-status-history` returns `401` without key after cutover
   - `curl https://api.pharos.watch/api/telegram-pulse` returns `401` without key after cutover
   - keyed requests succeed on `api.pharos.watch`
   - same requests succeed via `site-api.pharos.watch` when the site-proxy secret is supplied

2. Website behavior
   - `/status/` still loads and polls successfully on production host
   - `/telegram/` still renders pulse strip successfully on production host

3. Preview/local behavior
   - static export smoke still passes through `/_site-data/*`
   - if preview Pages QA is in scope, verify a preview deployment renders `/status/` and `/telegram/`

4. Post-deploy observability
   - compare pre/post route demand using `/api/request-source-stats` and D1 telemetry
   - verify public unauthenticated traffic drops on the two tightened routes
   - verify site-data lane traffic remains stable

## Recommended Execution Order

1. Confirm preview/smoke strategy and environment readiness
2. Land metadata/test changes for `public-status-history` and `telegram-pulse`
3. Land doc and `/about/api/` corrections in the same change
4. Run full validation and merge gate
5. Deploy
6. Compare route telemetry after deployment

## Out Of Scope For This Remediation

- redesigning feedback auth
- changing health endpoint access
- introducing a new public-vs-private health endpoint split
- changing OG image delivery semantics
- altering Telegram webhook auth flow

## Summary

The lowest-risk remediation is:

- keep `health`, `og/*`, `feedback`, and `telegram-webhook` reachable without `X-API-Key`
- protect `public-status-history` and `telegram-pulse` on `api.pharos.watch`
- keep both routes available on the website lane through `site-api` and `/_site-data/*`
- fix the stale and misleading docs/UI copy in the same change
- harden preview/local fallback assumptions before cutover so non-production browsing does not regress
