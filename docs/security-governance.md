# Security Governance

Durable rules and roadmap for keeping pharos.watch trusted by browsers and free of classifier-driven warnings. Reactive playbooks live in `docs/incident-response/`.

## Rules

### Token-in-URL discipline

**Rule:** Tokens, magic links, verification codes, and any single-use credential MUST NOT travel in URL query strings or path segments. URL fragment (`#…`) is acceptable only when the consuming page is route-scoped (not the apex or any non-credential route).

**Why:** A token in a URL query is sent in `Referer` headers, logged by CDNs, indexed by crawlers, and shown to anyone with the URL bar. URL fragments are not sent to servers, but anything that *reads* a fragment-token via inline script is structurally indistinguishable from a credential-harvesting phishing kit (see next rule).

**Apply:** The retired self-serve lane formerly emitted (and accepted) email verification links as raw fragment tokens like `https://pharos.watch/api/#akv_…`; the lane and its verification-link builder were removed on 2026-09-29, so nothing emits verification links anymore and no page reads a verification fragment. What remains on the frontend is credential-shaped but token-hygienic: the one-time supporter-key token reveal in the shared issued-token panel plus `PendingApiKeyRecovery` in the root layout, which keep an unsaved token in memory only (never localStorage or sessionStorage), and the Google Analytics `?verify=` query scrub through `stripQueryVerificationTokenFromUrl` (`src/lib/api-key-verification-url.ts`), which removes a legacy verification query parameter immediately and never treats the query as a verification-token source. Do not emit `#verify=...` or `?verify=...`; if a fragment-token consumer is ever reintroduced, it must keep the raw token fragment shape that avoids a URL-parameter signature in the route bundle.

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

The pinned Gitleaks runner (`node --import tsx scripts/ci/run-gitleaks.ts --worktree`, or `--range`) runs its configuration self-test before scanning. Solana registry exceptions match only the prefixed finding in risk-review and mint-authority JSON, scoped to `generic-api-key`. GitBook exceptions match only explicitly reviewed public CDN UUIDs in stablecoin/safety-score JSON and `data/ai-summaries.json`; additional issuer/path-pinned exceptions cover Midas's 2026 base prospectus, Apyx's August 2026 attestation, and Matrixdock's terms, silver whitepaper and July 2026 audit in their owning data, redemption configuration or ledger files. These Firebase-backed download tokens are capabilities, so new UUIDs require confirmation that the issuer publicly links the exact URL. The ledger's exact concatenated UNI/XAUT contract identities are also exempted from `generic-api-key`; the reviewed GLDT reverse-swap settlement-leg finding is exempted from `gitlab-deploy-token` in `commodity.ts`. Both path and value predicates must match (`condition = "AND"`), and no exception may suppress a whole source line. Self-tests require public identifiers to pass and adjacent synthetic AWS and generic credentials on the same line to remain detectable. Existing historical fingerprint ignores are unchanged; four commit-pinned mTBILL Final Terms findings were appended because the PDF was anonymously readable but its exact public issuer-page link could not be verified through Cloudflare, so that capability has no recurring allowlist.

Reviewed **2026-10-04** for the overnight research registries: four exact public download UUIDs are exempted from `generic-api-key` only in `shared/data/safety-score-v9/evidence-gap-classifications-v1.json`, after confirming the issuer pages carry the exact PDF hrefs:

- USD.AI July 15, 2026 attestation: `34ae6ee1-5f94-4ce9-87e8-c98bcec11762`, linked from [Proof of Loans](https://docs.usd.ai/usdai/proof-of-loans).
- Cap English whitepaper: `19d915b4-356f-4abd-a4b2-d331515adc22`, linked from [Whitepaper](https://docs.cap.app/resources/whitepaper).
- Matrixdock STBT terms dated January 20, 2025: `79d5fd49-deae-41b4-a809-9e1afaa02f32`, linked from [STBT Terms and Conditions](https://matrixdock.gitbook.io/matrixdock-docs/english/legal/token-terms-and-conditions/stbt-terms-and-conditions).
- Gold DAO September 2025 vault audit: `7a7a500e-1321-4e9d-8046-46ae8199e244`, linked from [Audit reports](https://docs.gold-dao.org/other/audit-reports).

The same review pins the exact `gitlab-deploy-token` matched spans formed by `gldt` plus each suffix `-gold-dao-df16e419ba0`, `-gold-dao-8e6db88665b`, `-gold-dao-4d85e1c0e1b`, `-gold-dao-3892111dfe4` and `-launches-as-the-worl` to the evidence-gap registry. They are public GLDT wave ids and the slug of [Gold DAO's](https://medium.com/@GoldDAO) issuer article “GLDT Launches as the World's First Fully Gold-Backed Decentralized Gold Token Governed by a DAO”, not GitLab credentials. Only the article-slug match is also exempted in `shared/data/safety-score-v9/operational-resilience-overlays-v1.json`; that finding uses `gitlab-deploy-token`, not `generic-api-key`. The documentation splits the symbol from the suffixes, and the configuration regexes escape its literal hyphen, so the pathless worktree scan does not misidentify the exception policy itself.

Three exact public identifiers are exempted from `generic-api-key` only in `shared/data/safety-score-v9/transfer-review-overlays-v1.json`: Spiko CHF's Starknet register `0x06723dcb428eddb160c5adfc2d0a5e5adc184bf6a7298780c3cbf3fa764f709b` and Stellar/Soroban register `CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4`, verified through the [issuer share-class API](https://public-api.spiko.io/share-classes/chfSAFO), and KGST's TRON proxy `TN3cfcFhLrdNZhMdHZVZ4z2XFWb7uB9CXg`, verified through [TronScan contract metadata](https://apilist.tronscanapi.com/api/contract?contract=TN3cfcFhLrdNZhMdHZVZ4z2XFWb7uB9CXg). All new exceptions require the exact value and owning path together (`condition = "AND"`), are rule-scoped, and retain mixed-line credential controls in the runner's configuration self-test.

Midas mTBILL July 2026 Final Terms capability `bf215cdc-f549-474d-8ca9-5a1810fabeb8` has **no recurring allowlist**: its exact href could not be verified on the Cloudflare-blocked [issuer legal page](https://docs.midas.app/resources/legal-product-documentation/mtbill). The PDF was anonymously readable, including without the token; the evidence-gap source now cites the same URL ending in `20260714_mTBILL_FT_signed_final.pdf?alt=media`. Both responses were byte-identical (SHA-256 `b1e58001ec0f688aedc266ec63a37026e5fcf3f720f930f3aff5403036b3944a`), preserving the cited fact. Following the historical mTBILL precedent above, 22 commit-pinned fingerprints were appended to `.gitleaksignore` for the old range findings only; no existing entry was changed or removed.

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
- No anonymous credential issuance. The self-serve email-verification lane was removed on 2026-09-29 (existing keys drain through their 60-day expiry), so keys are operator-issued apart from the donor claim, which requires a SIWE signature proving control of a wallet with a graded public donation before issuing a `donor`-tier key.
- Open-source repository (https://github.com/TokenBrice/pharos-watch) with public commit history.

## Related docs

- `docs/incident-response/safe-browsing-flag.md` — playbook when a flag is active.
