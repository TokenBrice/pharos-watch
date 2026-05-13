# Security Governance

Durable rules and roadmap for keeping pharos.watch trusted by browsers and free of classifier-driven warnings. Reactive playbooks live in `docs/incident-response/`.

## Rules

### Token-in-URL discipline

**Rule:** Tokens, magic links, verification codes, and any single-use credential MUST NOT travel in URL query strings or path segments. URL fragment (`#…`) is acceptable only when the consuming page is route-scoped (not the apex or any non-credential route).

**Why:** A token in a URL query is sent in `Referer` headers, logged by CDNs, indexed by crawlers, and shown to anyone with the URL bar. URL fragments are not sent to servers, but anything that *reads* a fragment-token via inline script is structurally indistinguishable from a credential-harvesting phishing kit (see next rule).

**Apply:** API key email verification uses `https://pharos.watch/api/#verify=…` exclusively. The worker emits this format from `buildVerificationUrl` in `worker/src/api/api-key-requests/request.ts`. The frontend consumes it via a React effect on the `/api/` route only — never via a root-layout inline script.

### Inline-script discipline in root layouts

**Rule:** The root `src/app/layout.tsx` (and any nested layout that ships to multiple routes) MUST NOT contain inline `<script>` JSX, including `next/script` blocks with `strategy="beforeInteractive"`. Exception: GA / analytics inline snippets and theme bootstrapping that genuinely need to run before hydration.

**Why:** Inline scripts in the root layout ship verbatim to every static HTML page including the apex `pharos.watch/`. Token-handling or URL-rewriting patterns in those scripts pattern-match phishing kits regardless of intent. Safe Browsing's social-engineering classifier flagged pharos.watch on 2026-05-12 for exactly this — an `api-key-verify-url-sanitizer` script that read `location.hash`, parsed a `verify=` token, stored it in `window.__PHAROS_API_KEY_VERIFY_TOKEN__`, and called `history.replaceState`. Each pattern alone is benign; together they are the textbook phishing-kit shape.

**Apply:** Enforced by ESLint (`no-restricted-syntax` rule scoped to `src/app/**/layout.{ts,tsx}`) and at build time by `npm run check:phishing-signatures` (scans built HTML for inline-script signatures across `out/**`).

## CI guardrails

| Check | When it runs | Catches |
|---|---|---|
| `check:phishing-signatures` | `validate:prebuild` after `npm run build` | inline scripts in built HTML matching `history.replaceState` near credentials, `URLSearchParams(location.hash)`, token-shaped window globals, or the full `try{location.hash…replaceState}` shape |
| ESLint `no-restricted-syntax` (layout files) | every `npm run lint` | `<Script strategy="beforeInteractive">` and inline `<script>` JSX in any `src/app/**/layout.{ts,tsx}` |
| `check:safe-browsing` | manual / future cron | live Google Safe Browsing verdict for `pharos.watch` and high-traffic URLs |

## Monitoring

### Google Search Console

Verified property: `pharos.watch` (Domain property). Owner: `me@tokenbrice.com`.

**Do this once:** in Search Console → Settings → User Preferences, confirm email notifications are enabled. Google emails the verified contact the moment a security issue is logged. The May 12 flag would have been caught same-day if notifications had been on.

**Routine check:** Security & Manual Actions → Security Issues. Currently the only source that names the specific flagged URL and the exact category (deceptive vs malware vs unwanted software).

### Safe Browsing direct lookup

`npm run check:safe-browsing` queries Google's Safe Browsing v4 API for `pharos.watch` and key URLs. Requires `GOOGLE_SAFE_BROWSING_API_KEY` env var. Free tier covers our query volume. Designed to run from CI on a schedule — gives a verdict in seconds rather than waiting for a Search Console email.

To get a key: https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com

## CSP roadmap

Current production CSP:

```
script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://static.cloudflareinsights.com
```

The `'unsafe-inline'` directive is what *permits* phishing-kit-shaped inline scripts to run at all. Removing it forces every inline script to be either nonce-authorized or hash-authorized, which:
- prevents an entire class of accidental phishing-pattern shipments
- gives classifiers a strong positive signal (this site cannot execute arbitrary inline JS)

**Why it's not done yet:** Next.js static export emits inline `<script>` blocks with per-page hydration state. Hash-based CSP would require recomputing the allowlist on every build for every page (HTTP header bloat). Nonce-based CSP requires per-request nonce injection via a Cloudflare Pages Function, which is moderate work.

**Phased plan:**

1. **Audit** all inline `<script>` blocks emitted by Next.js for current routes. Confirm: gtag-init, theme bootstrap (next-themes), and Next.js hydration push (`__next_s`).
2. **Implement** a Cloudflare Pages Function (`functions/_middleware.ts`) that:
   - generates a random nonce per request
   - rewrites the CSP header to `script-src 'self' 'nonce-<value>' ...` (drops `'unsafe-inline'`)
   - rewrites inline `<script>` tags in the HTML response to carry `nonce="<value>"`
3. **Verify** in staging that hydration still works, gtag fires, themes apply, no console violations.
4. **Ship** with monitoring on Cloudflare Workers Analytics for CSP `report-to` violations.

Estimated effort: 1 engineer-day including the manual verification pass. Track under a separate issue when prioritized.

## Positive trust signals (already shipped)

These are already in the build; documented here so they aren't accidentally regressed.

- JSON-LD `Organization` and `Person` (TokenBrice) nodes with `sameAs` references to GitHub, X, Farcaster — gives classifiers verifiable third-party identity backing.
- `MIT` license declaration in repo root + linked from the about page.
- Strict CSP for non-script directives: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Standard security headers: HSTS preload, X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy denying camera/mic/geo/payment/usb.
- Email verification for API key issuance (no anonymous credential issuance).
- Open-source repository (https://github.com/TokenBrice/pharos-watch) with public commit history.

## Related docs

- `docs/incident-response/safe-browsing-flag.md` — playbook when a flag is active.
- `docs/incident-response/telegram-secret-rotation.md` — secret rotation runbook.
- `docs/incident-response/telegram-token-rotation.md` — bot token rotation runbook.
