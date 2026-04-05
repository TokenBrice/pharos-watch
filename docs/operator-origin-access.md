# Operator Origin Access Setup

Runbook for the operator-origin split that now fronts `/admin/` and browser admin calls with Access-protected ops hosts while leaving `/status/` public and read-only.

---

## Purpose

Current repo-side state:

- the Worker is attached to both `api.pharos.watch` and `ops-api.pharos.watch`
- browser CORS allows both `pharos.watch` and `ops.pharos.watch`
- `/admin/` only serves the live operator panel on `ops.pharos.watch`; the public host is blocked by the Pages host-gate function and returns a non-indexed `404`
- `/status/` is public and read-only on both the public and ops hosts
- same-origin Pages Functions proxy `/api/admin/*` from `ops.pharos.watch` to `ops-api.pharos.watch` with Access service-token headers

Still true:

- Cloudflare Access remains the intended human-entry gate for the operator UI and operator API
- scripts and automation should use `ops-api.pharos.watch` plus Access service-token headers
- same-origin `/api/admin/*` smoke on `ops.pharos.watch` may require a bootstrapped `CF_Authorization` session cookie even when the same CI token can reach the UI shell; a token-backed HTML response alone does not guarantee that Pages Functions receives `Cf-Access-Jwt-Assertion`

---

## Repo-Side Changes

### Worker route declarations

`worker/wrangler.toml` now declares two custom-domain routes:

- `api.pharos.watch`
- `ops-api.pharos.watch`

Deploying the Worker will attach the script to both hostnames.
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

Actively used by the current Pages Functions host gate / admin proxy:

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`

Consumed by the Worker's admin auth layer (`worker/src/lib/auth.ts`) for Access JWT verification:

- `CF_ACCESS_TEAM_DOMAIN` — used to construct the JWKS URL for JWT signature verification
- `CF_ACCESS_OPS_API_AUD` — verified against the JWT `aud` claim to confirm the token was issued for the ops-api Access application

Reserved but not yet consumed:

- `CF_ACCESS_OPS_UI_AUD`

Canonical runtime groupings now live in code:

- Worker: `worker/src/lib/env.ts` (`WORKER_REQUIRED_ENV_KEYS`, `WORKER_OPTIONAL_ENV_KEYS`, `WORKER_RESERVED_ENV_KEYS`, `WORKER_ACTIVE_ENV_KEYS`)
- Pages Functions: `functions/lib/ops-env.ts` (`PAGES_FUNCTIONS_REQUIRED_ENV_KEYS`, `PAGES_FUNCTIONS_OPTIONAL_ENV_KEYS`, `PAGES_FUNCTIONS_RESERVED_ENV_KEYS`, `PAGES_FUNCTIONS_ACTIVE_ENV_KEYS`)

Use those exports as the source of truth when auditing Cloudflare bindings before deploy. The same binding name can be reserved on one runtime and active on the other; for example `OPS_API_ORIGIN` is worker-reserved but Pages-active.

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

- Allowed upstream paths are limited to admin routes and shared dynamic-admin matchers exported from `shared/lib/api-endpoints.ts` (including `/api/discovery-candidates/:id/dismiss`).
- HTTP method rules are enforced by `validateEndpointMethod()`, so the proxy returns `405` with `Allow` when a caller uses the wrong verb for an otherwise valid admin route.
- The proxy verifies the inbound UI Access token before the upstream fetch. Missing or invalid Access token evidence (`Cf-Access-Jwt-Assertion`, `cf-access-token`, or `CF_Authorization`) returns `401`.
- Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) must include a same-origin `Origin` header matching `OPS_UI_ORIGIN`; missing or foreign origins return `403`.
- The proxy forwards only `Accept`, `Content-Type`, and `Idempotency-Key` from the browser request. It adds `CF-Access-Client-Id` and `CF-Access-Client-Secret` from Pages env itself; browser callers never supply those directly.
- The proxy reflects only a narrow response-header set back to the browser: `Allow`, `Cache-Control`, `Content-Type`, `Idempotency-Key`, `Warning`, `X-Data-Age`, and `X-Idempotent-Replay`.
- Failure policy is explicit:
  - `404` for non-ops origins or non-allowlisted paths
  - `401` for missing or invalid UI JWT
  - `403` for mutating requests without same-origin `Origin`
  - `405` for method mismatch
  - `500` when the Pages-side service token pair or UI JWT verification bindings are not configured
  - `504` when the upstream fetch hits the proxy timeout budget
  - `502` when the upstream fetch fails or Cloudflare Access responds with an auth redirect from `ops-api`

### Pages project bindings needed now

Required active bindings:

- `OPS_API_SERVICE_TOKEN_ID`
- `OPS_API_SERVICE_TOKEN_SECRET`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`

Optional active overrides (the proxy has production defaults for these already):

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`

Reserved but currently unused by the Pages proxy/runtime:

- `CF_ACCESS_OPS_API_AUD`

Set the required Pages bindings before deploying the ops-host frontend, otherwise `/api/admin/*` will fail closed with a configuration error.

---

## Cloudflare Account Setup

The remaining steps are account-bound. Wrangler can deploy the Worker route, but the Pages custom domain and Zero Trust Access applications still need to be created in Cloudflare.

### 1. Deploy the Worker route update

From the repo root:

```bash
cd worker
npx --no-install wrangler deploy
npx --no-install wrangler triggers deploy
```

Expected result:

- `api.pharos.watch` continues to serve the current Worker
- `ops-api.pharos.watch` is attached to the same Worker script

Observed during the initial rollout on 2026-03-13:

- the Worker deploy accepted the `ops-api.pharos.watch` route declaration
- `api.pharos.watch` immediately reflected the new CORS allowlist
- `ops-api.pharos.watch` still did not resolve publicly afterward

Interpretation:

- the repo-side route declaration is necessary, but the hostname still needs the zone/custom-domain side finished in Cloudflare before it becomes reachable

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
- CI smoke checks
- admin scripts

The Pages Functions proxy already uses the service token pair; create separate tokens only when you need distinct scopes for CI or operator tooling.

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

#### CI `smoke-ops` service token

- owner: GitHub repository secrets `OPS_SMOKE_CF_ACCESS_CLIENT_ID` / `OPS_SMOKE_CF_ACCESS_CLIENT_SECRET`
- CI contract:
  - direct `ops-api.pharos.watch` smoke uses the raw service-token headers
  - same-origin `ops.pharos.watch/api/admin/*` smoke first tries the raw token path, then retries with any `CF_Authorization` cookie returned by the Access-protected UI host
  - if the UI host only exposes the interactive Access redirect, if the service-token UI flow renders the shell without yielding a browser session cookie, or if the proxied request remains `401 Unauthorized` even after best-effort cookie replay, the CI smoke records that the shell is gated correctly and skips the same-origin proxy assertion rather than failing on a non-browser auth shape
- rotation sequence:
  1. create a new Access service token scoped for CI smoke against `ops.pharos.watch` / `ops-api.pharos.watch`
  2. update the GitHub repository secrets with the new client id / secret
  3. run the `smoke-ops` lane through workflow dispatch or an equivalent local invocation
  4. revoke the old token only after the smoke lane succeeds with the new credentials
- rollback:
  - restore the prior GitHub secrets if the new token fails and the old token still exists
  - otherwise create another CI token and re-run the smoke lane before revoking anything else

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

---

## Recommended Cloudflare Values

### Hostnames

- public UI: `pharos.watch`
- operator UI: `ops.pharos.watch`
- public API: `api.pharos.watch`
- operator API: `ops-api.pharos.watch`

### Access posture

- `ops.pharos.watch`: human identities only
- `ops-api.pharos.watch`: human identities plus service-token access

### Session policy

- UI session should be shorter than the old browser-held key fallback
- MFA should be enforced for all human operators
- owner: Cloudflare Zero Trust Access application policy for `https://ops.pharos.watch/*`
- observed current session duration: 4 hours on April 4, 2026
- repo code does not invalidate or shorten an active Cloudflare Access session; logout/session-duration changes must be made in the Zero Trust policy, not in the Pages or Worker codepaths

---

## Verification

### Worker route verification

After deploy:

```bash
curl -I https://ops-api.pharos.watch/api/health
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

---

## Rollback

If the operator-origin setup causes issues:

1. remove `ops-api.pharos.watch` from `worker/wrangler.toml`
2. revert `CORS_ORIGIN` to `https://pharos.watch`
3. redeploy the Worker
4. remove or disable the `ops.pharos.watch` Pages custom domain if needed
5. disable the Access apps

Because the public hostnames remain unchanged, rollback risk is low as long as Access is only attached to the operator origins.
