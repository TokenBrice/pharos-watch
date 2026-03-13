# Operator Origin Access Setup

Runbook for Phase 1 of the `/status` admin hardening rollout: introducing an operator-only web origin plus a dedicated worker route for future admin API traffic.

---

## Purpose

Phase 1 prepares the infrastructure boundary for the later Access-backed admin migration without changing the user-facing auth model yet.

After this phase:

- the Worker config is prepared for `ops-api.pharos.watch`
- browser CORS can allow both `pharos.watch` and `ops.pharos.watch`
- the Pages project can add `ops.pharos.watch`
- Cloudflare Access applications and policies can be created against both origins

This phase does **not** yet:

- remove `ADMIN_KEY`
- validate Access JWTs in application code
- proxy ops requests through Pages Functions
- cut the `/status` UI over to an Access-only flow

Those arrive in later phases.

Phase 2 adds the Pages Functions proxy and host-aware status UI cutover on `ops.pharos.watch`.

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

This is required so an Access-protected `ops.pharos.watch` can still call the Worker during the transition period.

### Future-facing env placeholders

`worker/src/lib/env.ts` now includes optional bindings reserved for later Access-aware phases:

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`
- `CF_ACCESS_OPS_API_AUD`

They are not consumed yet in Phase 1.

---

## Phase 2 Notes

Phase 2 introduces:

- `functions/api/admin/[[path]].ts`
- same-origin admin requests from `ops.pharos.watch` to `/api/admin/*`
- Pages Functions forwarding to `ops-api.pharos.watch`
- service-token auth from Pages Functions to the operator API host

### Pages project bindings needed for Phase 2

Required:

- `OPS_API_SERVICE_TOKEN_ID`
- `OPS_API_SERVICE_TOKEN_SECRET`

Optional overrides (the proxy has production defaults for these already):

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`

Required runtime config for Phase 2:

- `OPS_UI_ORIGIN`
- `OPS_API_ORIGIN`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_OPS_UI_AUD`
- `OPS_API_SERVICE_TOKEN_ID`
- `OPS_API_SERVICE_TOKEN_SECRET`

Set those bindings on the Pages project before deploying the Phase 2 frontend, otherwise `/api/admin/*` will return a configuration error.

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
- Phase 2 can branch behavior by hostname before any separate-project split is needed

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

This app will later protect the admin API host used by the Pages Functions proxy.

### 5. Create service tokens for later phases

Create at least one Access service token for:

- Pages Functions -> `ops-api.pharos.watch`
- CI smoke checks
- admin scripts

These tokens are not wired in Phase 1 yet, but creating them now avoids blocking Phase 2.

### 6. Record the Access values for later phases

Capture and store:

- team domain
- UI application AUD
- API application AUD
- service-token client id
- service-token client secret

These are the values later phases will bind into runtime env.

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

If the operator-origin prep causes issues before later phases land:

1. remove `ops-api.pharos.watch` from `worker/wrangler.toml`
2. revert `CORS_ORIGIN` to `https://pharos.watch`
3. redeploy the Worker
4. remove or disable the `ops.pharos.watch` Pages custom domain if needed
5. disable the Access apps

Because the public hostnames remain unchanged in Phase 1, rollback risk is low as long as Access is only attached to the new operator origins.
