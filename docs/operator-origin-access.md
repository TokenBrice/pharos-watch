# Operator Origin Access Setup

Runbook for the operator-origin split that now fronts `/status/` and browser admin calls with Access-protected ops hosts.

---

## Purpose

Current repo-side state:

- the Worker is attached to both `api.pharos.watch` and `ops-api.pharos.watch`
- browser CORS allows both `pharos.watch` and `ops.pharos.watch`
- `/status/` only serves the live operator panel on `ops.pharos.watch`; the public host renders the non-indexed fallback shell
- same-origin Pages Functions proxy `/api/admin/*` from `ops.pharos.watch` to `ops-api.pharos.watch` with Access service-token headers

Still true:

- Cloudflare Access remains the intended human-entry gate for the operator UI and operator API
- scripts and automation should use `ops-api.pharos.watch` plus Access service-token headers

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
- falls back to the first configured origin when there is no matching browser origin
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

Reserved in the Worker env interface for later Access-aware enforcement work, but not consumed by the current Worker code paths:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`
- `CF_ACCESS_OPS_API_AUD`

---

## Pages Functions Proxy

- `functions/api/admin/[[path]].ts`
- same-origin admin requests from `ops.pharos.watch` to `/api/admin/*`
- Pages Functions forwarding to `ops-api.pharos.watch`
- service-token auth from Pages Functions to the operator API host

The current proxy trusts the Cloudflare Access-protected `ops.pharos.watch` host as the human-entry gate and does not try to re-validate the UI JWT inside the function itself.

### Pages project bindings needed now

Required:

- `OPS_API_SERVICE_TOKEN_ID`
- `OPS_API_SERVICE_TOKEN_SECRET`

Optional overrides (the proxy has production defaults for these already):

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`

Reserved but currently unused by the proxy/runtime:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`
- `CF_ACCESS_OPS_API_AUD`

Set the required service-token bindings on the Pages project before deploying the ops-host frontend, otherwise `/api/admin/*` will return a configuration error.

---

## Cloudflare Account Setup

The remaining steps are account-bound. Wrangler can deploy the Worker route, but the Pages custom domain and Zero Trust Access applications still need to be created in Cloudflare.

### 1. Deploy the Worker route update

From the repo root:

```bash
cd worker
npx wrangler deploy
npx wrangler triggers deploy
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

### 6. Record the Access values

Capture and store:

- team domain
- UI application AUD
- API application AUD
- service-token client id
- service-token client secret

These are the values the current service-token flow and any later Access-aware enforcement work may need in runtime env.

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
curl -I https://ops.pharos.watch/status/
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

---

## Rollback

If the operator-origin setup causes issues:

1. remove `ops-api.pharos.watch` from `worker/wrangler.toml`
2. revert `CORS_ORIGIN` to `https://pharos.watch`
3. redeploy the Worker
4. remove or disable the `ops.pharos.watch` Pages custom domain if needed
5. disable the Access apps

Because the public hostnames remain unchanged, rollback risk is low as long as Access is only attached to the operator origins.
