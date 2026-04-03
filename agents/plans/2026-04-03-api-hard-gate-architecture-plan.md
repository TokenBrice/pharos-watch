# API Hard-Gate Architecture Plan

**Date:** 2026-04-03
**Status:** Proposed
**Supersedes for the hard-gate goal:** `agents/plans/2026-04-03-api-key-gating-design.md` and `agents/plans/2026-04-03-api-key-gating-implementation-plan.md`

## Goal

Meet this exact product requirement:

- the website at `pharos.watch` continues to fetch data normally for end users
- the external API at `api.pharos.watch` is hard-gated for direct consumers

## Hard Constraint

This is only possible if the website stops relying on anonymous browser calls to `api.pharos.watch`.

If the public browser can call a generic JSON API directly, external scripts can do the same. `Origin`, `Referer`, `Sec-Fetch-*`, and custom Accept markers are useful for attribution, not for hard authentication.

That means the architecture must split into:

- a **website data surface** for `pharos.watch`
- a **keyed external API surface** for `api.pharos.watch`

## Non-Goals

- preventing scraping of public website data
- making all website JSON inaccessible to third parties
- changing the admin `ops.pharos.watch` / `ops-api.pharos.watch` trust model
- converting the frontend away from static export

Public website data will remain scrapeable. The goal is to stop anonymous direct use of `api.pharos.watch`, not to make public site data undiscoverable.

## Current Repo Facts

These repo facts drive the design:

- frontend production reads currently resolve to `https://api.pharos.watch` from `src/lib/api.ts`
- the app is a static Next.js export (`next.config.ts: output = "export"`)
- Pages Functions already implement a trustworthy proxy pattern for the ops surface:
  - `ops.pharos.watch/api/admin/*` -> Pages Functions
  - Pages Functions -> `ops-api.pharos.watch`
  - Pages Functions authenticate upstream with Cloudflare Access service-token headers
- worker admin auth already verifies Access JWTs on the worker side for the operator API lane
- many website screens are client-query driven and currently depend on direct browser fetches to the public API host

## Recommended Architecture

### Summary

Adopt a four-lane split:

1. **Website UI lane**
   - Host: `pharos.watch`
   - Purpose: browser-delivered product UI and same-origin website data fetches

2. **Website data lane**
   - Host/path: `pharos.watch/_site-data/*`
   - Runtime: Cloudflare Pages Functions
   - Purpose: public browser-facing data surface used only by the website
   - Security model: no browser secrets, same-origin only in practice, but still public/scrapeable

3. **Internal site API lane**
   - Host: `site-api.pharos.watch` (recommended name; exact hostname can vary)
   - Runtime: same worker as today
   - Purpose: trusted upstream for Pages Functions
   - Security model: Cloudflare Access service-token authenticated, no browser access

4. **External API lane**
   - Host: `api.pharos.watch`
   - Runtime: same worker as today
   - Purpose: monetizable / governed API surface for external consumers
   - Security model: API key required for gated data endpoints

### Data Flow

```text
Browser on pharos.watch
  -> same-origin GET /_site-data/...
  -> Pages Function allowlist + cache
  -> site-api.pharos.watch/api/... with Access service token
  -> Worker handler
  -> D1/cache/upstreams

External consumer
  -> api.pharos.watch/api/...
  -> Worker API key gate
  -> Worker handler
  -> D1/cache/upstreams
```

### Why This Satisfies The Requirement

- End users still get normal website data fetches from `pharos.watch`
- direct calls to `api.pharos.watch` can be hard-gated because the website no longer needs anonymous access to that host
- the trust boundary moves server-side, where it is real:
  - Pages Functions hold the service token
  - browsers never see the token
  - the worker can trust the Access-authenticated `site-api` lane

## Why The Previous Header-Bypass Plan Is Not Sufficient

The superseded plan allowed “first-party website traffic” through based on `Origin`, `Referer`, and a Pharos Accept marker. That does not create a hard gate because external clients can spoof those headers.

Keep that logic only for telemetry and attribution. Do not use it as an auth bypass.

## Website Data Surface Design

### Public Browser-Facing Path

Recommended website data path:

- `/_site-data/*`

Reasons:

- keeps the browser-facing website feed distinct from the contractual external API
- avoids overloading `/api/*` semantics on the public host
- makes it clearer in code and docs that this is a site-owned data plane, not the partner API

Example mappings:

- `/_site-data/stablecoins`
- `/_site-data/peg-summary`
- `/_site-data/stablecoin/usdt-tether`
- `/_site-data/stress-signals?stablecoin=usdc-circle&days=30`

The public website surface can mirror the current API path shapes closely to minimize frontend churn.

### Pages Function Responsibilities

The new public Pages Function layer should:

- allow only `GET`
- allow only an explicit route allowlist that matches frontend consumption
- preserve query strings for the routes that already use them
- forward only narrow request headers upstream
- reflect only a narrow response-header set back to the browser
- cache aggressively at the `pharos.watch` edge
- remain intentionally undocumented as a public API contract

### Caching Requirements

This layer must not become a new hot-path overload point. Minimum design requirements:

- cache key = public website URL including query string
- cache only successful `GET` responses
- honor existing freshness semantics from worker responses (`Cache-Control`, `X-Data-Age`, `Warning`)
- preserve stale safety behavior for stale worker payloads
- never include origin- or caller-specific auth headers in the cached object

Recommended rollout posture:

- start with proxy caching in Pages Functions
- then migrate the hottest routes to bundled or artifact-backed site payloads if the proxy hit rate is not good enough

## Internal Site API Lane

### Recommended Shape

Create a new worker host:

- `site-api.pharos.watch`

Protect it with a dedicated Cloudflare Access application that only the Pages Functions proxy can use via service token.

This reuses the same trust pattern already in place for:

- `ops.pharos.watch` -> `ops-api.pharos.watch`

### Why Access Service Token Is Preferred

Compared with a custom shared header secret, the Access pattern is better because:

- the repo already uses it successfully for the ops proxy
- Cloudflare handles the outer authentication layer
- the worker can verify a JWT rather than trusting a raw shared header
- the security model is easier to audit and rotate

### Worker Behavior For The Site Lane

Requests on `site-api.pharos.watch` that carry a valid Access signal should:

- bypass API key gating
- bypass the public IP-based API limiter
- continue to use the same route handlers and cache logic as the current worker

This lane is trusted transport, not a different data contract.

## External API Lane

### Gate Scope

After website migration, gate `api.pharos.watch` for the public data endpoints that external users consume.

Recommended gated scope:

- all public JSON read endpoints used as API products

Recommended initial exemptions:

- `GET /api/health`
- `GET /api/og/*`
- `POST /api/feedback`
- `POST /api/telegram-webhook`
- existing admin lanes on `ops-api.pharos.watch`

The exact exemption set should be reviewed, but the key point is that the website must no longer depend on `api.pharos.watch`.

### API Key Model

Do not store plaintext keys in D1.

Use:

- token prefix for indexed lookup
- secret hash for verification

Recommended token shape:

```text
ph_live_<prefix>_<secret>
```

Recommended storage model:

- `key_prefix` unique
- `secret_hash`
- `name`
- `owner_email`
- `tier`
- `rate_limit_per_sec`
- `is_active`
- `created_at`
- `last_used_at`

Verification flow:

1. parse presented token into prefix + secret
2. look up row by prefix
3. hash presented secret
4. timing-safe compare against stored hash

This avoids plaintext storage and prevents full-table scans on every request.

### Admin Key Management

Keep the worker-side admin route model aligned with the current repo:

- worker admin routes should stay under `/api/*`, not `/api/admin/*`
- the ops Pages proxy should expose them to the browser as `/api/admin/*`
- use `GET` and `POST` action-style endpoints instead of introducing `PATCH` / `DELETE` into the shared endpoint contract

Recommended worker route family:

- `GET /api/api-keys`
- `POST /api/api-keys`
- `POST /api/api-keys/:id/update`
- `POST /api/api-keys/:id/deactivate`
- `POST /api/api-keys/:id/rotate`

## Frontend Changes

### Fetch Base Resolution

`src/lib/api.ts` should stop treating the public external API host as the website runtime default.

Recommended production behavior:

- canonical website hosts -> same-origin `/_site-data/*`
- admin proxy paths remain same-origin `/api/admin/*`
- explicit local dev override can continue to target `wrangler dev`

This means the frontend fetch layer should resolve two different concepts:

- website data base
- external API base

The website should use the first one. Only explicit external API tooling should use the second.

### Allowlist Inventory

The Pages Functions website-data allowlist should be derived from the frontend’s real reads in:

- `src/hooks/`
- `src/lib/blacklist-api.ts`
- any direct `apiFetch()` / `apiFetchWithMeta()` call sites

At minimum, the migration must cover the current browser-consumed read endpoints before the hard gate is switched on.

## Load-Relief Strategy

Hard-gating `api.pharos.watch` is necessary, but it does not by itself reduce the load caused by normal website usage. The design should therefore include a second goal:

- move routine website traffic off the external API host

Recommended sequence:

### Phase A: Proxy Offload

- browser traffic moves from `api.pharos.watch` to `pharos.watch/_site-data/*`
- Pages Functions caching absorbs a significant fraction of website reads
- direct external callers can no longer use `api.pharos.watch` anonymously

### Phase B: Hot Route Consolidation

Add bundled website payloads for the most expensive multi-query screens, for example:

- homepage bundle
- stablecoin detail page bundle
- compare page bundle

This reduces request fan-out from the browser even if the data still originates in the worker.

### Phase C: Snapshot Artifact Offload

If proxy caching is still not enough, move the hottest cache-backed website routes to snapshot artifacts written on cron, stored in a durable edge-friendly store, and served directly by the website data plane.

This should be treated as an optimization phase, not a prerequisite for the hard gate.

## Recommended Rollout Plan

### Phase 0: Inventory And Contract Freeze

- enumerate every browser-consumed public API route
- decide the exemption list for `api.pharos.watch`
- freeze new direct frontend reads to `api.pharos.watch`

Exit criteria:

- a reviewed allowlist exists for `/_site-data/*`
- a reviewed gated-endpoint list exists for `api.pharos.watch`

### Phase 1: Stand Up The Trusted Website Lane

- add `site-api.pharos.watch`
- create Cloudflare Access app for the site lane
- create Pages service token for the public site proxy
- add Pages Functions public website-data proxy on `pharos.watch/_site-data/*`
- generalize worker auth to recognize the new Access audience

Exit criteria:

- `pharos.watch/_site-data/*` can fetch allowlisted worker data through the internal lane
- browsers never talk directly to `site-api.pharos.watch`

### Phase 2: Repoint The Frontend

- update `src/lib/api.ts` and frontend query helpers to use the website data surface in production
- preserve local dev ergonomics with explicit override behavior
- add tests to ensure canonical site hosts no longer resolve browser reads to `api.pharos.watch`

Exit criteria:

- production website traffic no longer depends on direct browser calls to `api.pharos.watch`

### Phase 3: Add API Key Infrastructure

- add D1 schema for hashed API keys and per-key rate limits
- add worker-side external API gate on `api.pharos.watch`
- add admin CRUD / rotate / deactivate flows through the existing ops proxy model

Exit criteria:

- a known-good test key can call `api.pharos.watch`
- anonymous data calls to `api.pharos.watch` fail

### Phase 4: Flip The Hard Gate

- remove the old “first-party header” bypass from auth decisions
- require API keys on the gated external data endpoints
- keep telemetry classification logic for attribution only

Exit criteria:

- the website still functions normally
- direct anonymous use of `api.pharos.watch` is blocked

### Phase 5: Optimize Hot Website Paths

- inspect request volume and cache hit rate on `/_site-data/*`
- add bundled payloads or artifact-backed site feeds for the highest-pressure routes

Exit criteria:

- website traffic is stable at acceptable load cost
- the new public website surface is not recreating the original overload problem

## Files And Areas Expected To Change

### Pages Functions

- new public website-data proxy function(s) under `functions/`
- shared Pages env contract in `functions/lib/ops-env.ts` or a sibling public-proxy env contract

### Frontend

- `src/lib/api.ts`
- `src/hooks/` and direct fetch call sites
- tests asserting production host resolution

### Worker

- auth/generalized Access verification for the site lane
- host-aware access gate in `worker/src/handlers/http/gates.ts`
- API key storage / verification / rate limiting
- route additions for admin key management

### Shared

- runtime-origin definitions for the new internal site API host
- endpoint metadata for new admin key routes if they are added

### Docs

When implementation starts, the following verified docs will need updates:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`
- `docs/testing.md`
- `README.md`

## Observability Requirements

Add metrics for both the new website data plane and the keyed external API lane.

Minimum observability additions:

- website-data proxy request volume
- website-data proxy cache hit ratio
- website-data proxy upstream miss ratio
- `site-api` authenticated request volume
- `api.pharos.watch` keyed request volume
- `api.pharos.watch` auth failures by reason:
  - missing key
  - malformed key
  - bad key
  - inactive key
  - rate-limited key

For request-source telemetry, keyed external traffic can remain part of the `external` bucket initially. A third bucket is optional and should only be added if the full stats/UI contract is updated in the same rollout.

## Risks And Tradeoffs

### Accepted Tradeoff

The website data surface remains publicly scrapeable.

This is acceptable because the objective is:

- protect `api.pharos.watch`
- preserve website UX
- move the real trust boundary server-side

### Main Technical Risk

If the Pages Functions website-data proxy is shipped without strong caching, the overload problem can simply move from `api.pharos.watch` to `pharos.watch/_site-data/*` and `site-api.pharos.watch`.

That is why cache behavior is part of the architecture, not an implementation detail to postpone.

### Main Delivery Risk

The frontend currently consumes many public routes. The migration has a real blast radius and should be staged behind clear rollout phases instead of combining:

- website repointing
- API key infra
- hard gate enforcement

into one cutover.

## Recommendation

Proceed with the split data-plane architecture.

Recommended order:

1. build the trusted website lane first
2. repoint the frontend off `api.pharos.watch`
3. then add and enforce API keys on `api.pharos.watch`
4. optimize the hottest website routes after the hard gate is live

This is the lowest-risk path that actually satisfies the requirement instead of approximating it with spoofable headers.
