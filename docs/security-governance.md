# Security Governance

Durable rules and roadmap for keeping pharos.watch trusted by browsers and free of classifier-driven warnings. Reactive playbooks live in `docs/incident-response/`.

## Rules

### Token-in-URL discipline

**Rule:** Tokens, magic links, verification codes, and any single-use credential MUST NOT travel in URL query strings or path segments. URL fragment (`#…`) is acceptable only when the consuming page is route-scoped (not the apex or any non-credential route).

**Why:** A token in a URL query is sent in `Referer` headers, logged by CDNs, indexed by crawlers, and shown to anyone with the URL bar. URL fragments are not sent to servers, but anything that *reads* a fragment-token via inline script is structurally indistinguishable from a credential-harvesting phishing kit (see next rule).

**Apply:** API key email verification links use raw fragment tokens like `https://pharos.watch/api/#akv_…`; this remains the only emitted link format, produced by `buildVerificationUrl` in `worker/src/api/api-key-requests/request.ts`. The frontend consumes raw tokens via a React effect on the `/api/` route only — never via a root-layout inline script. That route still accepts a legacy `?verify=...` query solely to scrub it immediately; it never uses the query as a verification-token source. The client also retains a route-scoped legacy `sessionStorage` pickup for an already staged raw `akv_...` token and removes it immediately; this is compatibility behavior, not a supported email-link format. Do not emit `#verify=...` or `?verify=...`; the raw token fragment avoids a URL-parameter signature in the route bundle.

### Inline-script discipline in root layouts

**Rule:** The root `src/app/layout.tsx` (and any nested layout that ships to multiple routes) MUST NOT contain inline executable `<script>` JSX, including `next/script` blocks with `strategy="beforeInteractive"`. Sole exception: non-executable JSON-LD data scripts (`type="application/ld+json"`) whose content is deterministic structured metadata — the only shape the ESLint guard permits. Analytics and theme bootstrapping stay outside layout files: GA runs from the `GoogleAnalytics` client component (gtag stub installed in an effect, external `gtag/js` appended at idle) and theme bootstrapping comes from `next-themes` inside `src/components/providers.tsx`.

**Why:** Inline scripts in the root layout ship verbatim to every static HTML page including the apex `pharos.watch/`. Token-handling or URL-rewriting patterns in those scripts pattern-match phishing kits regardless of intent. Safe Browsing's social-engineering classifier flagged pharos.watch on 2026-05-12 for exactly this — an `api-key-verify-url-sanitizer` script that read `location.hash`, parsed a `verify=` token, stored it in `window.__PHAROS_API_KEY_VERIFY_TOKEN__`, and called `history.replaceState`. Each pattern alone is benign; together they are the textbook phishing-kit shape.

**Apply:** Enforced by ESLint (`no-restricted-syntax` rule scoped to `src/app/**/layout.{ts,tsx}`) and at build time by `npm run check:phishing-signatures` (scans built HTML for inline-script signatures across `out/**`).

## CI guardrails

| Check | When it runs | Catches |
|---|---|---|
| `check:phishing-signatures` | Pages validate after `npm run build` | inline scripts in built HTML matching `history.replaceState` near credentials, `URLSearchParams(location.hash)`, token-shaped window globals, or the full `try{location.hash…replaceState}` shape |
| ESLint `no-restricted-syntax` (layout files) | every `npm run lint` | `<Script strategy="beforeInteractive">` and inline `<script>` JSX in any `src/app/**/layout.{ts,tsx}` |
| `check:safe-browsing` | daily GitHub scheduled workflow + manual dispatch | live Google Safe Browsing verdict for `pharos.watch` and high-traffic URLs |

## Monitoring

### Google Search Console

Verified property: `pharos.watch` (Domain property). Owner: `me@tokenbrice.com`.

**Do this once:** in Search Console → Settings → User Preferences, confirm email notifications are enabled. Google emails the verified contact the moment a security issue is logged. The May 12 flag would have been caught same-day if notifications had been on.

**Routine check:** Security & Manual Actions → Security Issues. Currently the only source that names the specific flagged URL and the exact category (deceptive vs malware vs unwanted software).

### Safe Browsing direct lookup

`npm run check:safe-browsing` queries Google's Safe Browsing v4 API for `pharos.watch` and key URLs. Requires `GOOGLE_SAFE_BROWSING_API_KEY` env var. The `Safe Browsing Monitor` GitHub workflow runs it daily at 07:17 UTC and also supports manual dispatch. A workflow failure is treated as an incident trigger and should be triaged through `docs/incident-response/safe-browsing-flag.md`.

To get a key: https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com

## CSP posture

Production HTML CSP is nonce-backed by `functions/_middleware.ts`:

```
script-src 'self' 'nonce-<per-request-value>' https://www.googletagmanager.com
```

The Pages middleware generates a random nonce per HTML request, rewrites inline `<script>` tags to carry that nonce, and overwrites the response CSP. `public/_routes.json` must include the single broad `/*` include so static document routes such as `/`, `/chains/*`, and `/stablecoins/*` pass through the middleware; keep only static asset prefixes excluded from function routing because Cloudflare rejects overlapping include splats. The broad static fallback in `public/_headers` also omits script `unsafe-inline`, so a middleware miss fails closed instead of permitting arbitrary inline JavaScript. HTML responses get `Cloudflare-CDN-Cache-Control: no-store` / `CDN-Cache-Control: no-store` because a nonce-bearing response must not be shared from the CDN cache.

`shared/lib/site-csp.ts` owns both the nonce-aware runtime CSP and the static fallback policy used by Pages middleware, the ops-host asset gates, `public/_headers`, and the local static-export smoke server. `npm run check:site-csp-sync` fails when the managed `public/_headers` CSP lines drift; use `npx --no-install tsx scripts/ci/check-site-csp-sync.ts --write` only when intentionally regenerating those managed lines from the shared builder.

Keep `style-src 'unsafe-inline'` unless the Tailwind/Next style emission path is separately nonce- or hash-authorized. Do not add script `unsafe-inline` back for local convenience; fix the nonce transform or route-specific script instead.

Route-specific exception: `/pharoswatchbot/app/` is the Telegram Mini App surface, so `shared/lib/site-csp.ts` sets that route's `script-src` to `'self' https://telegram.org` (dropping `googletagmanager`, and the Google Analytics `img-src` / `connect-src` origins with it) and relaxes `frame-ancestors` to `https://telegram.org https://*.telegram.org`. Do not broaden that exception to the root layout or other public pages.

## Positive trust signals (already shipped)

These are already in the build; documented here so they aren't accidentally regressed.

- JSON-LD `Organization` (`sameAs`: X, GitHub, Telegram) and `Person` (TokenBrice; `sameAs`: X, GitHub, Farcaster) nodes — gives classifiers verifiable third-party identity backing.
- `MIT` license declaration in repo root + linked from the about page.
- Strict CSP for non-script directives: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Standard security headers: HSTS preload, X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy denying camera/mic/geo/payment/usb.
- Email verification for API key issuance (no anonymous credential issuance).
- Open-source repository (https://github.com/TokenBrice/pharos-watch) with public commit history.

## Related docs

- `docs/incident-response/safe-browsing-flag.md` — playbook when a flag is active.
