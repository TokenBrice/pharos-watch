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

The pinned Gitleaks runner (`node --import tsx scripts/ci/run-gitleaks.ts --worktree`, or `--range`) runs its configuration self-test before scanning. `.gitleaks.toml` owns reviewed, rule-scoped public-identifier exceptions; `.gitleaksignore` owns commit-pinned historical fingerprints. Public CDN download tokens are capabilities: new exceptions require evidence that the issuer publicly links the exact URL, with both value and owning path matched (`condition = "AND"`). Never exempt a whole source line or an identifier shape. The runner's self-tests require public identifiers to pass while adjacent synthetic AWS and generic credentials remain detectable.

For committed local readiness, use `node --import tsx scripts/ci/run-gitleaks.ts --local-trusted --base=<full-base-sha> --head=<full-head-sha>`. The scanner snapshots the frozen base's scanner, transitive local helpers, configuration and ignore policy into a temporary directory outside the checkout, then runs the trusted `--range` and `--tree` passes before the frozen head's `--range --candidate-policy --trusted-root` check. Candidate scanning is skipped only when its scanner/helpers/policy exactly match the trusted snapshot; a weaker candidate policy never replaces either trusted pass. Full commit history must already be available locally. Temporary inputs and the detached scan repository are removed on success or failure; the author checkout's files, HEAD, index and refs are untouched.

Local `--tree` checks combined-diff resolution lines from merge commits in `base..head`; CI additionally checks GitHub's synthetic PR merge commit. The local mode therefore proves the requested committed range, not an uncreated synthetic merge result or uncommitted edits. Outputs retain Gitleaks redaction. Exits are `0` clean, `1` findings, and `2` invalid arguments or unavailable scan/setup prerequisites. Tooling can call `runLocalTrustedGitleaks({ baseSha, headSha, repoRoot })` from `scripts/ci/run-gitleaks.ts`, which returns `{ ok, exitCode, summary }`.

A parity caller with an already-created synthetic merge can additionally pass `mergeSha` to that function. This changes only the detached checkout identity used for merge-resolution scanning: the commit range remains `baseSha..headSha`, and candidate scanner/helpers/policy still come from `headSha`. The synthetic merge commit must be available in the supplied repository's object database; no duplicate range scan is needed.

Reviewed capability exceptions and their issuer-link evidence live beside the exact value/path predicates in `.gitleaks.toml`; consult that policy rather than maintaining a second UUID roster here.

The same review pins the exact `gitlab-deploy-token` matched spans formed by `gldt` plus each suffix `-gold-dao-df16e419ba0`, `-gold-dao-8e6db88665b`, `-gold-dao-4d85e1c0e1b`, `-gold-dao-3892111dfe4` and `-launches-as-the-worl` to the evidence-gap registry. They are public GLDT wave ids and the slug of [Gold DAO's](https://medium.com/@GoldDAO) issuer article “GLDT Launches as the World's First Fully Gold-Backed Decentralized Gold Token Governed by a DAO”, not GitLab credentials. Only the article-slug match is also exempted in `shared/data/safety-score-v9/operational-resilience-overlays-v1.json`; that finding uses `gitlab-deploy-token`, not `generic-api-key`. The documentation splits the symbol from the suffixes, and the configuration regexes escape its literal hyphen, so the pathless worktree scan does not misidentify the exception policy itself.

Transfer-review public-identifier exceptions are owned by `.gitleaks.toml`, including native-chain register and mint identities. New exceptions must match the exact value and owning path together (`condition = "AND"`), remain rule-scoped, and retain mixed-line credential self-tests.

Wave-4 recurring exceptions retain exact public values and their owning paths: the USDC input mint in the Raydium simulation and Solana CLMM pinned fixtures, feUSD's HyperCore spot asset identifier, and the STUSD token runtime hash in wrapper allocation evidence. The retired Meteora DLMM pinned fixture, its dedicated input-mint allowlist and its scanner controls are removed together. Public document capabilities are separately pinned for Reservoir's SSC bridge audit in the evidence-gap registry and Midas's 2026/2025 base prospectuses in settlement configuration. Every new value/path pair participates in the runner's public-only, mixed-line AWS credential and mixed-line generic API credential self-test controls. No base58, hash or UUID shape exemption is added. These policy and self-test changes must land on `main` in their own PR before the release PR, because PR preflight trusts the base policy and scans the original branch commits; later fixture or prose edits cannot remove a historical finding.

Midas mTBILL July 2026 Final Terms capability exceptions are now governed by `.gitleaks.toml`, including the reviewed compliance-sidecar allowlist. The evidence-gap registry's earlier token-free citation and historical fingerprints do not imply a repository-wide ban or exemption; inspect the owning path and rule before changing policy.

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

Route-specific exception: `/pharoswatchbot/app/` is the Telegram Mini App surface. `shared/lib/site-csp.ts` permits `'self' https://telegram.org` plus the per-request nonce in runtime HTML, drops Google Analytics script/image/connect origins, and sets `frame-ancestors https://telegram.org https://*.telegram.org`. Its static fallback has no nonce. Do not broaden that exception to other pages.

## Positive trust signals (already shipped)

These are already in the build; documented here so they aren't accidentally regressed.

- JSON-LD `Organization` (`sameAs`: X, GitHub, Telegram) and `Person` (TokenBrice; `sameAs`: X, GitHub, Farcaster) nodes — gives classifiers verifiable third-party identity backing.
- `MIT` license declaration in repo root; the about page identifies the license and links to the repository.
- Strict CSP for non-script directives: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Standard security headers: HSTS preload, X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy denying camera/mic/geo/payment/usb.
- No anonymous credential issuance. The self-serve email-verification lane was removed on 2026-09-29 (existing keys drain through their 60-day expiry), so keys are operator-issued apart from the donor claim, which requires a SIWE signature proving control of a wallet with a graded public donation before issuing a `donor`-tier key.
- Open-source repository (https://github.com/TokenBrice/pharos-watch) with public commit history.

## Related docs

- `docs/incident-response/safe-browsing-flag.md` — playbook when a flag is active.
