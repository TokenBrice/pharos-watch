# Operator Origin Access Setup

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Purpose · Repo-Side Changes · Worker route declarations · CORS allowlist · Runtime origin bindings · Pages Functions Proxy · Proxy contract · Pages project bindings needed now · Cloudflare Account Setup And Recovery · Recommended Cloudflare Values · Verification · Recovery.

Runbook for the operator-origin split that now fronts `/admin/`, `/admin-api/`, and browser admin calls with Access-protected ops hosts while leaving `/status/` public and read-only.

---

## Purpose

Current repo-side state:

- the Worker is attached to `api.pharos.watch`, `site-api.pharos.watch`, and `ops-api.pharos.watch`
- browser CORS allows both `pharos.watch` and `ops.pharos.watch`
- `/admin/`, `/admin/pipeline/`, `/admin/reliability/`, `/admin/crons/`, `/admin/actions/`, `/admin/comms/`, and `/admin/history/` serve route-based operator workspaces on `ops.pharos.watch`; `/admin-api/` serves private API management there. Public hosts are blocked by Pages host-gate functions and return non-indexed `404` responses.
- `/admin/*` and `/admin-api/*` static fallback headers are `no-store`; the host-gate functions also nonce-authorize inline scripts and return `no-store` HTML so stale pre-hydration operator shells cannot persist in shared caches.
- `/status/` is public and read-only on both the public and ops hosts
- same-origin Pages Functions proxy `/api/admin/*` from `ops.pharos.watch` to `ops-api.pharos.watch` with Access service-token headers

Still true:

- Cloudflare Access remains the intended human-entry gate for the operator UI and operator API
- the UI treats Access as one operator gate and does not infer or display read-only/mutating roles from unverified browser-visible identity claims
- scripts and automation should use `ops-api.pharos.watch` plus Access service-token headers
- the reserve-recovery fault injector that held the `workers.dev` admin route has been removed, and the preview-host admin carve-out is now retired: `isAccessProtectedAdminHost()` in `worker/src/lib/auth.ts` recognizes only `ops-api.pharos.watch`, so `*.workers.dev` preview hosts return `404` on admin paths even when presented with an Access JWT; `preview_urls = true` remains enabled for CI/site-proxy rehearsals
- same-origin `/api/admin/*` smoke on `ops.pharos.watch` may require a bootstrapped `CF_Authorization` session cookie even when the same CI token can reach the UI shell; a token-backed HTML response alone does not guarantee that Pages Functions receives `Cf-Access-Jwt-Assertion`

---

## Repo-Side Changes

### Worker route declarations

`worker/wrangler.toml` now declares three custom-domain routes:

- `api.pharos.watch`
- `site-api.pharos.watch`
- `ops-api.pharos.watch`

Deploying the Worker will attach the script to all three hostnames.
If the operator API hostname still does not resolve afterward, finish the custom-domain side in Cloudflare before treating it as live.

### CORS allowlist

`CORS_ORIGIN` now supports a comma-separated allowlist rather than a single static origin. The Worker:

- parses the configured origins
- echoes the request `Origin` when it is allowlisted
- falls back to the first configured origin when there is no `Origin` header at all
- omits `Access-Control-Allow-Origin` for foreign browser origins
- returns `403` for disallowed `OPTIONS` preflights
- sets `Vary: Origin`

The production repo default is now:

```toml
CORS_ORIGIN = "https://pharos.watch,https://ops.pharos.watch"
```

This is required so an Access-protected `ops.pharos.watch` can call the Worker during the current split-host setup.

### Runtime origin bindings

The shared binding manifest now lives in `shared/lib/env-contract.ts`, and the worker / Pages runtime key groupings are derived from it.

<!-- ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS:BEGIN -->
Current origin/access binding ownership derived from `shared/lib/env-contract.ts`:

| Binding | Worker | Pages ops | Pages site-data | Purpose |
| --- | --- | --- | --- | --- |
| `DB` | required | - | required | Primary D1 binding for worker reads/writes; Pages uses it for optional site-data attribution telemetry and required atomic selector-snapshot write quotas. |
| `SITE_API_SHARED_SECRET` | optional | - | required | Shared secret for Pages `/_site-data/*` -> Worker `site-api` authentication via `X-Pharos-Site-Proxy-Secret`. |
| `CF_ACCESS_TEAM_DOMAIN` | optional | required | - | Cloudflare Access team domain used to verify Access JWTs on worker admin requests and the Pages ops proxy. |
| `CF_ACCESS_OPS_API_AUD` | optional | - | - | Cloudflare Access audience for worker-side `ops-api.pharos.watch` JWT verification. |
| `OPS_UI_ORIGIN` | reserved | optional | optional | Ops UI origin override; reserved on the worker and active on Pages host-gating / same-origin checks. |
| `OPS_API_ORIGIN` | reserved | optional | - | Ops API origin override; reserved on the worker and active on the Pages admin proxy upstream hop. |
| `CF_ACCESS_OPS_UI_AUD` | reserved | required | - | Cloudflare Access audience used by the Pages ops proxy to verify the inbound UI JWT. |
| `OPS_API_SERVICE_TOKEN_ID` | - | required | - | Pages-managed Access service-token client ID used on the server-to-server hop to `ops-api.pharos.watch`. |
| `OPS_API_SERVICE_TOKEN_SECRET` | - | required | - | Pages-managed Access service-token client secret used on the server-to-server hop to `ops-api.pharos.watch`. |
| `SITE_ORIGIN` | - | - | optional | Site origin override used by the Pages `/_site-data/*` proxy when classifying production hosts. |
| `SITE_API_ORIGIN` | - | - | required | Site-data upstream origin; production Pages hosts require `https://site-api.pharos.watch`. |
| `SELECTOR_SNAPSHOT_IP_HASH_SECRET` | - | - | required | Dedicated HMAC pepper for selector-snapshot IP rate-limit and daily-quota keys; raw IP addresses are never stored. |
| `TELEGRAM_ADOPTION_IP_HASH_SECRET` | - | - | required | Dedicated HMAC pepper for PharosWatchBot CTA telemetry per-client minute quotas; raw IP addresses are never stored. |
<!-- ENV-CONTRACT:OPERATOR-ORIGIN-ACCESS:END -->

Use the derived runtime exports in `worker/src/lib/env.ts`, `functions/lib/ops-env.ts`, and `functions/lib/site-api-env.ts` when auditing Cloudflare bindings before deploy. The same binding name can be reserved on one runtime and active on the other; for example `OPS_API_ORIGIN` and `CF_ACCESS_OPS_UI_AUD` are worker-reserved but Pages-active.

For `/_site-data/*` and server-recomputed selector snapshots, configure `SITE_API_SHARED_SECRET`; every Pages host requires the exact HTTPS `SITE_API_ORIGIN=https://site-api.pharos.watch`, and anything else fails closed before secrets are attached (contract in [Worker Infrastructure: Site-Data Auth](./worker-infrastructure.md#site-data-auth)). Bind `DB` for attribution and selector quota writes, and configure the dedicated `SELECTOR_SNAPSHOT_IP_HASH_SECRET` HMAC pepper.

Build-time and release-time fetchers in `scripts/lib/sync-from-api.ts` attach `SITE_API_SHARED_SECRET` only to direct reads of `SITE_API_ORIGIN`; `SITE_API_SHARED_SECRET_TRUSTED_ORIGINS` is the comma-separated allowlist that extends that egress set, normally for preview Worker runs. An entry is honoured only when it parses as an HTTPS origin whose hostname ends in `.workers.dev`, so the variable cannot redirect the secret to an arbitrary host. It is a build-side egress control only: it does not grant any origin access to the Worker or Pages runtimes, which keep their own fail-closed checks. A read that carries the shared secret never also carries `X-API-Key`, and `/_site-data/*` reads carry neither, since those go out browser-shaped with `Origin` alone.

---

## Pages Functions Proxy

- `functions/api/admin/[[path]].ts`
- same-origin admin requests from `ops.pharos.watch` to `/api/admin/*`
- Pages Functions forwarding to `ops-api.pharos.watch`
- service-token auth from Pages Functions to the operator API host

The current proxy now fails closed on its own trust boundary:

- it verifies the inbound UI Access token against `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`
- it accepts that token from `Cf-Access-Jwt-Assertion` when Cloudflare forwards the assertion header, or from same-origin `cf-access-token` / `CF_Authorization` when the request is backed by an existing Access session cookie
- it requires same-origin `Origin` evidence for mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`)
- it still injects the Pages-managed service token pair only on the server-to-server hop to `ops-api.pharos.watch`

### Proxy contract

- Allowed upstream paths are limited to admin routes and shared dynamic-admin matchers exported from `shared/lib/api-endpoints/` (for example `/api/api-keys/:id/update`).
- HTTP method rules are enforced through the shared endpoint validators (`validateRouteMatchMethod()` in the Worker router, backed by `validateAllowedEndpointMethods()`), so the proxy returns `405` with `Allow` when a caller uses the wrong verb for an otherwise valid admin route.
- The proxy verifies the inbound UI Access token before the upstream fetch. Missing or invalid Access token evidence (`Cf-Access-Jwt-Assertion`, `cf-access-token`, or `CF_Authorization`) returns `401`.
- Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) must include a same-origin `Origin` header matching `OPS_UI_ORIGIN`; missing or foreign origins return `403`. Only `POST` reaches that check in practice: the shared method validator runs first and rejects `PUT`, `PATCH`, and `DELETE` with `405` and `Allow: GET, POST`.
- The proxy forwards only `Accept`, `Content-Type`, `Idempotency-Key`, and `X-Pharos-Admin` from the browser request. After signature-verifying the UI Access JWT and normalizing its email claim, it injects that verified value as `Cf-Access-Authenticated-User-Email` for durable audit attribution; a browser-supplied actor header is ignored. It also adds `CF-Access-Client-Id` and `CF-Access-Client-Secret` from Pages env itself, so browser callers never supply server-to-server credentials.
- The proxy reflects only `Allow`, `Cache-Control`, `Content-Type`, `Idempotency-Key`, `Warning`, `X-Data-Age`, `X-Execution-Certainty`, and `X-Idempotent-Replay` back to the browser. This preserves replay/certainty semantics without opening arbitrary upstream headers. A final policy decorator forces `private, no-store`, both CDN-specific no-store headers, `noindex`, and response security headers on every early or upstream return. Upstream `public` cache directives cannot survive the operator boundary.
- Request bodies are capped incrementally at 128 KiB, including when `Content-Length` is absent or understated; oversized requests return `413`. Upstream responses are buffered under the shared 16 MiB proxy cap before returning to the browser; oversized or unreadable upstream responses return `502`.
- Failure policy is explicit:
  - `404` for non-ops origins or non-allowlisted paths
  - `401` for missing or invalid UI JWT
  - `403` for mutating requests without same-origin `Origin`
  - `405` for method mismatch
  - `413` when the request body exceeds 128 KiB
  - `500` when the Pages-side service token pair or UI JWT verification bindings are not configured
  - `504` when the upstream fetch hits the proxy timeout budget
  - `502` when the upstream fetch fails, its buffered response exceeds 16 MiB, or Cloudflare Access responds with an auth redirect from `ops-api`

### Pages project bindings needed now

Required active bindings:

- `OPS_API_SERVICE_TOKEN_ID`
- `OPS_API_SERVICE_TOKEN_SECRET`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`

For the site-data proxy:

- `SITE_API_SHARED_SECRET`
- `SITE_API_ORIGIN=https://site-api.pharos.watch` on production Pages hosts
- `SELECTOR_SNAPSHOTS` KV namespace binding for Picker snapshots
- `SELECTOR_SNAPSHOT_IP_HASH_SECRET`
- `TELEGRAM_ADOPTION_IP_HASH_SECRET`
- `DB` for Pages-side storage: optional for durable `/_site-data/*` attribution telemetry, but required by `POST /selector-snapshot` for the atomic hashed-IP daily quota store. Plain site-data reads continue without DB telemetry; selector snapshot writes fail closed when the binding is absent.

Optional active overrides (the proxy has production defaults for these already):

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`
- `SITE_ORIGIN`

Set the required Pages bindings before deploying the ops-host frontend, otherwise `/api/admin/*` will fail closed with a configuration error.

---

## Cloudflare Account Setup And Recovery

These steps are for fresh provisioning or recovery of account-bound configuration. Existing production releases use the standard [deployment process](./deployment-process.md); do not replay raw Wrangler upload/promotion commands from this runbook.

### 1. Confirm the standard Worker deployment

Run the normal main-branch release flow in [Deployment Process](./deployment-process.md). After a successful Worker deployment, confirm:

- `api.pharos.watch` continues to serve the current Worker
- `site-api.pharos.watch` remains attached to the same Worker script
- `ops-api.pharos.watch` is attached to the same Worker script

If `ops-api.pharos.watch` does not resolve on a fresh account or after accidental zone removal, restore the Worker custom-domain/DNS configuration in Cloudflare, then rerun the standard release and verification below.

### 2. Add the operator Pages custom domain

Current Pages project:

- `stablecoin-dashboard`

Add:

- `ops.pharos.watch`

Recommended target:

- the same Pages project as `pharos.watch` for now

Reason:

- lowest migration cost for this static-export repo
- the current split can branch behavior by hostname before any separate-project split is needed

### 3. Create the Access application for the operator UI

Create a Cloudflare Access self-hosted application for:

- `https://ops.pharos.watch/*`

Recommended policy baseline:

- allow only the operator identity group/list
- require MFA
- set a short session duration

### 4. Create the Access application for the operator API origin

Create a second Access self-hosted application for:

- `https://ops-api.pharos.watch/*`

This app protects the admin API host used by the Pages Functions proxy.

### 5. Create service tokens

Create at least one Access service token for:

- Pages Functions -> `ops-api.pharos.watch`
- explicit operator diagnostics or admin scripts, when needed

The Pages Functions proxy already uses the service token pair; create a separate
short-lived token only when operator tooling needs direct Access-protected origin
access.

### Service-token ownership and rotation

#### Pages -> `ops-api` service token

- owner: Cloudflare Pages project `stablecoin-dashboard` production secrets `OPS_API_SERVICE_TOKEN_ID` / `OPS_API_SERVICE_TOKEN_SECRET`
- rotation sequence:
  1. create a new Access service token for `https://ops-api.pharos.watch/*`
  2. update the Pages project production secrets with the new client id / secret
  3. deploy the Pages project so `/api/admin/*` starts using the new token
  4. validate same-origin `https://ops.pharos.watch/api/admin/status` through `npm run test:smoke-ops` or an equivalent authenticated smoke
  5. revoke the old token only after the new token-backed proxy path is confirmed working
- rollback:
  - restore the previous Pages secrets if the new token fails before the old token is revoked
  - if the old token was already revoked, mint another replacement token and repeat the sequence

#### Operator `smoke-ops` service token

- owner: the operator's secure credential store; export
  `OPS_SMOKE_CF_ACCESS_CLIENT_ID` / `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET` only
  for the explicit diagnostic command
- diagnostic contract:
  - direct `ops-api.pharos.watch` smoke uses the raw service-token headers
  - same-origin `ops.pharos.watch/api/admin/*` smoke first tries the raw token path, then retries with any `CF_Authorization` cookie returned by the Access-protected UI host
  - transient `502`/`504` same-origin proxy responses are retried up to twice
  - interactive-only Access redirects or unavailable proxy-session cookies are reported as a skipped same-origin assertion rather than a deployment gate
- rotation sequence:
  1. create a new Access service token scoped for diagnostics against `ops.pharos.watch` / `ops-api.pharos.watch`
  2. update the operator credential store with the new client id / secret
  3. run `npm run test:smoke-ops` with the new credentials
  4. revoke the old token only after the diagnostic succeeds
- rollback:
  - restore the prior operator credentials if the new token fails and the old token still exists
  - otherwise create another diagnostic token before revoking anything else

### 6. Record the Access values

Capture and store:

- team domain
- UI application AUD
- API application AUD
- service-token client id
- service-token client secret

These are the values the current service-token flow and any later Access-aware enforcement work may need in runtime env.

### 7. Add API-host HTTP to HTTPS redirects

At the Cloudflare zone/rules layer for `pharos.watch`, add edge redirects so:

- `http://api.pharos.watch/...` -> `https://api.pharos.watch/...`
- `http://site-api.pharos.watch/...` -> `https://site-api.pharos.watch/...`

Contract:

- return `308`
- preserve host, path, and query
- upgrade only the scheme
- fire before Worker auth or application logic responds

Repo smoke coverage for this contract lives in `npm run test:smoke-transport`.

### 8. Rotate the site-data shared secret

When `SITE_API_SHARED_SECRET` changes, use a 24-hour overlap window:

1. Copy the retiring current value into `SITE_API_SHARED_SECRET_PREVIOUS`.
2. Deploy the new current value everywhere that emits `X-Pharos-Site-Proxy-Secret`.
3. Keep both values configured for 24 hours so the worker can accept either secret during the cutover.
4. Remove `SITE_API_SHARED_SECRET_PREVIOUS` after the overlap window ends.

Pages proxy code and smoke tooling continue emitting only the current secret throughout the rotation.

### 9. Maintain the WAF rate-limiting rule

The deployed account posture is owned by `scripts/ci/cloudflare-account-state-manifest.json`, not by the older policy proposals in feature runbooks. The zone's free plan has one rate-limiting slot. It is occupied by `api-rate-limit-ip`, deliberately **disabled**, with no rule-order constraints. It therefore provides no active edge throttling; keyed API limits, self-serve issuance fencing, Telegram pre-auth bindings, webhook deduplication, and Mini App quotas are enforced in the Worker/application layer.

The disabled rule is retained with this exact configuration so account drift remains visible:

- Match:

  ```
  (http.host eq "api.pharos.watch"
    and starts_with(http.request.uri.path, "/api/")
    and not cf.bot_management.verified_bot)
  ```

- Characteristics: Cloudflare data-center ID plus source IP
- Threshold: `120` requests / `10` seconds
- Action: `Block` for `10` seconds
Any enablement, exception, exact-path replacement, or plan upgrade is an account-state change: verify current plan capabilities, update the manifest and drift fixtures in the same review, then verify the rule ID and matches under Cloudflare Security Events. Do not describe a proposed rule in a feature policy file as deployed state.

---

### 10. Monitor Cloudflare account-state drift

`scripts/ci/cloudflare-account-state-manifest.json` is the committed, secret-free
expectation for the account-bound configuration that this repository does not
deploy: the active zone, Pages project and production binding names/types,
Pages and Worker custom domains, Access applications, and WAF rate-limit rules.
It contains neither resource IDs nor secret values.

The weekly **Cloudflare Account-State Drift** workflow runs
`npm run check:cloudflare-account-state` with the repository secret exposed only
as `CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN`. The script derives the account
and zone IDs from the `pharos.watch` zone lookup at runtime, performs only
Cloudflare API `GET` requests, and reports only resource names, public binding
types, and differing policy fields. It never prints the token, account/zone IDs,
or Pages secret values.

Create a dedicated read-only API token for this check. It needs the minimum
read access for the zone lookup, Pages project/domains, Access applications,
Worker custom domains, and zone WAF/rulesets. Do not reuse a deployment or
cache-purge token. If the GitHub secret is absent, the workflow fails before
making a network request and names the required secret. Intentional account
changes must update the manifest and its fixture tests in the same review;
Terraform/OpenTofu import remains owner-gated and out of scope.

---

## Recommended Cloudflare Values

### Hostnames

- public UI: `pharos.watch`
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- website data API: `site-api.pharos.watch`
- operator API: `ops-api.pharos.watch`

### Access posture

- `ops.pharos.watch`: human identities only
- `ops-api.pharos.watch`: human identities plus service-token access

### Session policy

- UI session duration is manifest-owned and currently expected to be 12 hours
- MFA should be enforced for all human operators
- owner: Cloudflare Zero Trust Access application policy for `https://ops.pharos.watch/*`
- `scripts/ci/cloudflare-account-state-manifest.json`, its fixtures, and the Zero Trust policy must change together when that duration changes
- repo code does not invalidate or shorten an active Cloudflare Access session; logout/session-duration changes must be made in the Zero Trust policy, not in the Pages or Worker codepaths

---

## Verification

### Worker route verification

After deploy:

```bash
curl -i https://ops-api.pharos.watch/api/health
```

Expected before Access is attached:

- a normal Worker response from the same script as `api.pharos.watch`

If the hostname does not resolve:

- finish the custom-domain / DNS side in Cloudflare for `ops-api.pharos.watch`
- then retry the verification check

Expected after Access is attached:

- an Access challenge/redirect when unauthenticated

### UI domain verification

After adding `ops.pharos.watch` to the Pages project:

```bash
curl -I https://ops.pharos.watch/
curl -I https://ops.pharos.watch/admin/
```

Expected before Access is attached:

- the current Pages content

Expected after Access is attached:

- an Access challenge/redirect when unauthenticated

### CORS verification

After Worker deploy:

```bash
curl -i https://api.pharos.watch/api/health \
  -H 'Origin: https://ops.pharos.watch'
```

Expected:

- `Access-Control-Allow-Origin: https://ops.pharos.watch`
- `Vary: Origin`

### Transport verification

After the zone-level redirect rule is configured:

```bash
npm run test:smoke-transport
```

Expected:

- `http://api.pharos.watch/...` returns `308` to the matching `https://api.pharos.watch/...`
- `http://site-api.pharos.watch/...` returns `308` to the matching `https://site-api.pharos.watch/...`
- no plaintext HTTP request reaches Worker auth or app handlers anymore

### Workspace route verification

The automated coverage of the operator workspace routes is `npm run test:ops-browser`, documented in [Testing & Linting](./testing.md). It runs against the local static export with fixture API responses, so it validates the workspace routes, layout, and accessibility only — it does not exercise this document's Access applications, service tokens, or CORS boundary, which stay covered by the checks above and by `npm run test:smoke-ops`.

---

## Recovery

Treat the operator host split as permanent infrastructure. For a code or artifact regression, use the standard Worker or Pages rollback path in [Deployment Process](./deployment-process.md) and preserve the `ops.pharos.watch` / `ops-api.pharos.watch` host, CORS, and Access boundaries. For an account-configuration failure, restore the affected custom domain, Access application, policy, or service token using the provisioning and rotation steps above, then rerun the operator smoke checks.
