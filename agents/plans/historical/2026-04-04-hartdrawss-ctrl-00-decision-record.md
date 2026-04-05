# 2026-04-04 Hartdrawss CTRL-00 Decision Record

Status:
- `completed-with-noted-inference`

Instructions:
- Fill every field below with a concrete value before dispatching any ticket blocked by `CTRL-00`.
- Replace placeholders; do not leave `TBD`, `unknown`, or narrative-only answers.
- Add evidence links or notes where requested.

## Access Header Behavior

Pages `ops.pharos.watch` receives `Cf-Access-Jwt-Assertion` for browser-authenticated traffic:
- value: `yes (inferred from Cloudflare Access self-hosted app behavior; not directly origin-echo verified in current repo)`
- evidence: `https://ops.pharos.watch/admin/` currently redirects to `https://pharos-watch.cloudflareaccess.com/...` with app AUD `47c1eae56a9d2fb8b5c0e1f4511e585857639f1eafa1ed347cf7b0ee13780c1b`, proving the Pages host is Access-protected. Cloudflare Access origin behavior for authenticated requests is to inject `Cf-Access-Jwt-Assertion`, but the current repo has no echo route on `ops.pharos.watch` to prove header arrival without adding temporary code.

Pages `ops.pharos.watch` receives `Cf-Access-Jwt-Assertion` for service-token traffic:
- value: `yes (inferred from Cloudflare Access service-token flow; not directly origin-echo verified in current repo)`
- evidence: The same `ops.pharos.watch` Access application fronts the Pages origin. Direct proof would require a valid UI service token plus an origin-echo route, neither of which is exposed by the current repo/runtime. This remains the one `CTRL-00` item not directly demonstrated by response capture.

## Access Config Values

`CF_ACCESS_TEAM_DOMAIN`:
- value: `pharos-watch`

`CF_ACCESS_OPS_UI_AUD`:
- value: `47c1eae56a9d2fb8b5c0e1f4511e585857639f1eafa1ed347cf7b0ee13780c1b`

Explicit team-domain required wherever Access JWT verification is active:
- value: `yes`
- note: Worker config currently hardcodes `CF_ACCESS_TEAM_DOMAIN = "pharos-watch"` in [`worker/wrangler.toml`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/wrangler.toml), while worker auth still falls back to `"pharos-watch"` when unset. The remediation plan should remove that fallback and require explicit config on both Worker and Pages sides.

Operator Access session duration:
- value: `4 hours observed on the Access login/session cookie path for ops UI on April 4, 2026`
- owner: `Cloudflare Zero Trust Access application policy for https://ops.pharos.watch/*`

## Transport Ownership

`api.pharos.watch` HTTP->HTTPS redirect rule location / owner:
- value: `not configured as of April 4, 2026; host still serves plaintext HTTP application responses and the fix belongs in the Cloudflare zone/account redirect-rules layer for pharos.watch`

`site-api.pharos.watch` HTTP->HTTPS redirect rule location / owner:
- value: `not configured as of April 4, 2026; host still serves plaintext HTTP application responses and the fix belongs in the Cloudflare zone/account redirect-rules layer for pharos.watch`

## Credential Ownership

Pages -> `ops-api` service-token owner:
- value: `Cloudflare Pages project stablecoin-dashboard production secrets (OPS_API_SERVICE_TOKEN_ID / OPS_API_SERVICE_TOKEN_SECRET)`

CI `smoke-ops` service-token owner:
- value: `GitHub Actions repository secrets for stablecoin-dashboard (OPS_SMOKE_CF_ACCESS_CLIENT_ID / OPS_SMOKE_CF_ACCESS_CLIENT_SECRET)`

API-key default expiry policy:
- value: `90 days when expiresAt is omitted`
- owner sign-off: `frozen by the remediation implementation plan and dispatch packet; implement as the repo default unless Cloudflare/operator policy requires a stricter follow-up`

## Notes

Additional implementation notes:
- Live transport evidence on April 4, 2026:
  - `curl -I http://api.pharos.watch/api/health` returned `405 Method Not Allowed` over plaintext HTTP.
  - `curl -I http://site-api.pharos.watch/api/stablecoins` returned `401 Unauthorized` over plaintext HTTP.
- Live Access evidence on April 4, 2026:
  - `curl -I https://ops.pharos.watch/admin/` redirected to `pharos-watch.cloudflareaccess.com` and exposed UI AUD `47c1eae56a9d2fb8b5c0e1f4511e585857639f1eafa1ed347cf7b0ee13780c1b` in the meta payload.
  - `curl -I https://ops-api.pharos.watch/api/status` redirected to `pharos-watch.cloudflareaccess.com` and exposed API AUD `72e74ead7cedf76e5c79f2bd0dd999aecd7d5b4e05fa1f9d696aed6a2cd31869`, matching [`worker/wrangler.toml`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/wrangler.toml).
- Pages project evidence on April 4, 2026:
  - `npx --no-install wrangler pages project list` shows `stablecoin-dashboard` serving `stablecoin-dashboard.pages.dev`, `ops.pharos.watch`, and `pharos.watch`.
  - `npx --no-install wrangler pages secret list --project-name stablecoin-dashboard` shows production secrets `OPS_API_SERVICE_TOKEN_ID`, `OPS_API_SERVICE_TOKEN_SECRET`, and `SITE_API_SHARED_SECRET`.
