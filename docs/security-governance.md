# Security Governance

Durable rules and roadmap for keeping pharos.watch trusted by browsers and free of classifier-driven warnings. Reactive playbooks live in `docs/incident-response/`.

## Rules

### Token-in-URL discipline

**Rule:** Tokens, magic links, verification codes, and any single-use credential MUST NOT travel in URL query strings or path segments. URL fragment (`#…`) is acceptable only when the consuming page is route-scoped (not the apex or any non-credential route).

**Why:** A token in a URL query is sent in `Referer` headers, logged by CDNs, indexed by crawlers, and shown to anyone with the URL bar. URL fragments are not sent to servers, but anything that *reads* a fragment-token via inline script is structurally indistinguishable from a credential-harvesting phishing kit (see next rule).

**Apply:** No page currently consumes email-verification fragments. Supporter-key reveal and `PendingApiKeyRecovery` keep unsaved tokens in memory only, never localStorage/sessionStorage. `stripQueryVerificationTokenFromUrl` in `src/lib/api-key-verification-url.ts` removes legacy query tokens before analytics, never admits them as credentials. Do not emit `#verify=...` or `?verify=...`; any separately approved fragment consumer must use a raw token on its scoped route, avoiding a URL-parameter signature.

### Inline-script discipline in root layouts

**Rule:** The root `src/app/layout.tsx` (and any nested layout that ships to multiple routes) MUST NOT contain inline executable `<script>` JSX, including `next/script` blocks with `strategy="beforeInteractive"`. Sole exception: non-executable JSON-LD data scripts (`type="application/ld+json"`) whose content is deterministic structured metadata — the only shape the ESLint guard permits. Analytics and theme bootstrapping stay outside layout files: GA runs from the `GoogleAnalytics` client component (gtag stub installed in an effect, external `gtag/js` scheduled immediately in the effect at idle with a two-second deadline/post-paint fallback, without a window `load` gate) and theme bootstrapping comes from `next-themes` inside `src/components/providers.tsx`.

**Why:** Root-layout scripts ship to every static HTML page. Reading credential fragments, storing token-shaped window globals and rewriting history together resemble credential-harvesting code regardless of intent. The [immutable incident rationale](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/security-governance.md#inline-script-discipline-in-root-layouts) preserves the classifier incident; prevention belongs in runtime/layout boundaries, not a copied incident diary.

**Apply:** Enforced by ESLint (`no-restricted-syntax` rule scoped to `src/app/**/layout.{ts,tsx}`) and at build time by `npm run check:phishing-signatures` (scans built HTML for inline-script signatures across `out/**`).

## CI guardrails

| Check | When it runs | Catches |
|---|---|---|
| `check:phishing-signatures` | Pages validate after `npm run build` | inline scripts in built HTML matching `history.replaceState` near credentials, `URLSearchParams(location.hash)`, token-shaped window globals, or the full `try{location.hash…replaceState}` shape |
| ESLint `no-restricted-syntax` (layout files) | every `npm run lint` | `<Script strategy="beforeInteractive">` and inline `<script>` JSX in any `src/app/**/layout.{ts,tsx}` |
| `check:safe-browsing` | monthly GitHub scheduled workflow + manual dispatch | live Google Safe Browsing verdict for `pharos.watch` and high-traffic URLs |

Safe Browsing response admission is fail-closed: only Google's documented `{}` clean response or a schema-validated `matches` envelope is accepted. Error envelopes and unknown top-level fields are API failures even with HTTP 200, never clean verdicts. Threat matches remain a non-clean result; HTTP and deadline failures remain API failures.

The pinned Gitleaks runner (`node --import tsx scripts/ci/run-gitleaks.ts --worktree`, or `--range`) runs its configuration self-test before scanning. `.gitleaks.toml` owns reviewed, rule-scoped public-identifier exceptions; `.gitleaksignore` owns commit-pinned historical fingerprints. Public CDN download tokens are capabilities: new exceptions require evidence that the issuer publicly links the exact URL, with both value and owning path matched (`condition = "AND"`). Never exempt a whole source line or an identifier shape. The runner's self-tests require public identifiers to pass while adjacent synthetic AWS and generic credentials remain detectable.

Historical fingerprints remain commit/path/rule/source-line identities even after source cleanup or relocation. Remove one only after the trusted scanner with the candidate ignore file proves a full-history scan clean; a scan with that fingerprint still active is not removal evidence. Worktree scanning omits deleted bodies and scans added/untracked bytes without source-path identity, so path-scoped public exceptions may not apply there. Record that limitation rather than broadening the policy.

For committed local readiness, use `node --import tsx scripts/ci/run-gitleaks.ts --local-trusted --base=<full-base-sha> --head=<full-head-sha>`. The scanner snapshots the frozen base's scanner, transitive local helpers, configuration and ignore policy into a temporary directory outside the checkout, then runs the trusted `--range` and `--tree` passes before the frozen head's `--range --candidate-policy --trusted-root` check. Candidate scanning is skipped only when its scanner/helpers/policy exactly match the trusted snapshot; a weaker candidate policy never replaces either trusted pass. Full commit history must already be available locally. Temporary inputs and the detached scan repository are removed on success or failure; the author checkout's files, HEAD, index and refs are untouched.

Local `--tree` checks combined-diff resolution lines from merge commits in `base..head`; CI additionally checks GitHub's synthetic PR merge commit. The local mode therefore proves the requested committed range, not an uncreated synthetic merge result or uncommitted edits. Outputs retain Gitleaks redaction. Exits are `0` clean, `1` findings, and `2` invalid arguments or unavailable scan/setup prerequisites. Tooling can call `runLocalTrustedGitleaks({ baseSha, headSha, repoRoot })` from `scripts/ci/run-gitleaks.ts`, which returns `{ ok, exitCode, summary }`.

The PR secrets job snapshots the trusted base scanner and policy before candidate checkout, so candidate code cannot influence the trusted snapshot. [PR outcomes and transport](./testing.md#pr-outcomes-and-transport) owns the scan sequence and required outcomes.

A parity caller with an already-created synthetic merge can additionally pass `mergeSha` to that function. This changes only the detached checkout identity used for merge-resolution scanning: the commit range remains `baseSha..headSha`, and candidate scanner/helpers/policy still come from `headSha`. The synthetic merge commit must be available in the supplied repository's object database; no duplicate range scan is needed.

Reviewed capability exceptions, public-identifier values, owning paths and issuer-link evidence live only in `.gitleaks.toml`. New or relocated exceptions must preserve exact rule/value/path predicates and public-only, mixed-line AWS and mixed-line generic-credential self-tests for each admitted pair. Do not copy the exception roster into documentation or exempt base58, hash, UUID, review-ID or prose shapes.

Policy and self-test changes needed by a release must land on `main` in a separate PR first: preflight trusts base policy and scans original branch commits, so later fixture/prose edits cannot erase a historical finding.

## Monitoring

### Google Search Console

Verified property: `pharos.watch` (Domain property). Owner: `me@tokenbrice.com`.

**Do this once:** in Search Console → Settings → User Preferences, confirm email notifications are enabled. Google emails the verified contact the moment a security issue is logged. The May 12 flag would have been caught same-day if notifications had been on.

**Routine check:** Security & Manual Actions → Security Issues. Currently the only source that names the specific flagged URL and the exact category (deceptive vs malware vs unwanted software).

### Safe Browsing direct lookup

`npm run check:safe-browsing` queries Google's Safe Browsing v4 API for `pharos.watch` and key URLs. Requires `GOOGLE_SAFE_BROWSING_API_KEY` env var. The `Safe Browsing Monitor` GitHub workflow runs it monthly (the 1st, 07:17 UTC) and also supports manual dispatch. A workflow failure is treated as an incident trigger and should be triaged through `docs/incident-response/safe-browsing-flag.md`.

To get a key: https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com

## CSP posture

Production HTML CSP is nonce-backed by `functions/_middleware.ts`:

```
script-src 'self' 'nonce-<per-request-value>' https://www.googletagmanager.com https://challenges.cloudflare.com
frame-src https://challenges.cloudflare.com
```

The Pages middleware generates a random nonce per HTML request, rewrites inline `<script>` tags to carry that nonce, and overwrites the response CSP. `public/_routes.json` must include the single broad `/*` include so static document routes such as `/`, `/chains/*`, and `/stablecoins/*` pass through the middleware; keep only static asset prefixes excluded from function routing because Cloudflare rejects overlapping include splats. The broad static fallback in `public/_headers` also omits script `unsafe-inline`, so a middleware miss fails closed instead of permitting arbitrary inline JavaScript. HTML responses get `Cloudflare-CDN-Cache-Control: no-store` / `CDN-Cache-Control: no-store` because a nonce-bearing response must not be shared from the CDN cache.

Keep [public RSC/static exclusions](./architecture.md#frontend-runtime-and-seo-surface) narrow: blanket text/PNG/JSON rules bypass operator gates or artifact handlers.

`shared/lib/site-csp.ts` owns both the nonce-aware runtime CSP and the static fallback policy used by Pages middleware, the ops-host asset gates, `public/_headers`, and the local static-export smoke server. `npm run check:site-csp-sync` fails when the managed `public/_headers` CSP lines drift; use `npx --no-install tsx scripts/ci/check-site-csp-sync.ts --write` only when intentionally regenerating those managed lines from the shared builder.

Cloudflare Email Obfuscation is off for `pharos.watch` paths `/cemetery` and `/cemetery/` only, through one owner-applied Configuration Rule (2026-10-27): its injected `email-decode.min.js` throws on Cemetery's SVG grave anchors, and the page's issuer contact is already public. Other routes keep the zone default; do not widen the rule or rewrite the SVG anchors. Mobile smoke fails on that decoder signature.

Keep `style-src 'unsafe-inline'` unless the Tailwind/Next style emission path is separately nonce- or hash-authorized. Do not add script `unsafe-inline` back for local convenience; fix the nonce transform or route-specific script instead.

Route-specific exception: `/pharoswatchbot/app/` is the Telegram Mini App surface. `shared/lib/site-csp.ts` permits `'self' https://telegram.org https://challenges.cloudflare.com` plus the per-request nonce in runtime HTML, drops Google Analytics script/image/connect origins, and sets `frame-ancestors https://telegram.org https://*.telegram.org`. Its static fallback has no nonce. Do not broaden that exception to other pages.

All variants (runtime nonce, static fallback, Mini App and ops asset responses) allow only `https://challenges.cloudflare.com` for Turnstile scripts and frames; the shared builder owns both directives.

## Browser session gate

`SiteSession`, mounted by `providers.tsx`, is inert unless `NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK=true` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is nonempty. Its effect creates the external Turnstile script element, like the analytics component: keeping executable scripts out of shared layouts preserves the inline-script discipline above. The widget uses `action: "site-data"`, `appearance: "interaction-only"` and explicit rendering.

With the flag and public key on, a non-script preconnect hint uses the already CSP-allowed challenge origin, and the provider's first client effect starts the script without idle scheduling, in parallel with the session chunk requested at provider-module evaluation; a valid stored expiry skips script loading until the renewal window. Navigation-relative User Timing marks `pharos-session-script` (script insertion), `pharos-session-token` (token received) and `pharos-session-ready` (accepted session response) stay in browser memory, without beacons or storage.

The module singleton shares one attempt sequence, backs off one then two seconds between attempts, and caps all attempts (including renewals) at three per page view, with a 15-second deadline per attempt. It posts the single-use challenge token only in the JSON body of same-origin `POST /_site-data/session` with same-origin credentials. No token enters a URL, persistent browser storage or logs. Only a local expiry derived from the browser-session lifetime at acquisition is stored in guarded localStorage, so server/browser clock differences do not reject a valid session; the session cookie is HttpOnly. Visible tabs check for renewal every minute and on visibility changes when less than one hour remains.

Only same-origin `/_site-data/` reads wait up to three seconds for a session before fetching anyway. A hinted `401` invalidates the expiry, waits again and retries once; a hinted bootstrap `401` falls through to that normal path. Final hinted failures use a recognizable subtype of the existing API error; a successful acquisition after rejection refetches active queries with that error once. Only an actual hinted rejection followed by unavailable acquisition shows the reload notice; challenge failure alone leaves working observe-mode reads without a notice. No further challenge attempts run after the cap on that page view. [Privacy](./privacy-page.md#browser-security-session) describes the 12-hour security cookie.

The shared token helper trims signing keys in both mint and verify, treats blank keys as absent, and rejects empty session IDs or lifetimes above the token kind's limit (12 hours for browser sessions, 15 minutes for automation).

All detailed `site_session_gate` events share a 60-event cap per isolate per UTC minute, including valid decisions sampled at 1 in 16. The first decision in the next active minute emits one `site_session_gate_summary` for the completed window, with its minute and exact unsampled counts per outcome and mode; isolate recycle discards unflushed counters.

Turnstile replay detection is eventually consistent, so one solved challenge submitted concurrently can mint more than one session; the per-network budget bounds the effect.

## Positive trust signals (already shipped)

These are already in the build; documented here so they aren't accidentally regressed.

- JSON-LD `Organization` (`sameAs`: X, GitHub, Telegram, Wikidata) and `Person` (TokenBrice; `sameAs`: X, GitHub, Farcaster) nodes — gives classifiers verifiable third-party identity backing.
- `MIT` license declaration in repo root; the about page identifies the license and links to the repository.
- Strict CSP for non-script directives: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Standard security headers: HSTS preload, X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy denying camera/mic/geo/payment/usb.
- No anonymous credential issuance: keys are operator-issued apart from donor claims, which require SIWE proof of a graded public donation. [Legacy self-serve drain and incident response](./deployment-process.md#self-serve-key-incident-rollback) owns remaining expiry/cleanup obligations.
- Open-source repository (https://github.com/TokenBrice/pharos-watch) with public commit history.

## Related docs

- `docs/incident-response/safe-browsing-flag.md` — playbook when a flag is active.
