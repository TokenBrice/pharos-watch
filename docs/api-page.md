# API Access And Reference Pages

Public `/api/` is the static Access document; `/api/reference/` is the separate static Reference document. Their route entrypoints own metadata/shell; route-local modules render offers, navigation, wallet check and reference. `docs/api-reference.md` is the HTTP authority, rendered at build time, not a separately published `/docs/` page. Retired `/about/api/` and `/docs/api-reference/` aliases redirect directly to `/api/reference/`.

## Route Shape

Each exported document contains only its own panel, never a hidden copy of the other panel. `ApiTabs` renders crawlable document links with `aria-current`, not a client tablist with absent panels. Legacy `/api/#reference` and child Reference fragments navigate after hydration to `/api/reference/` with the fragment preserved; Access fragments retain their existing `/api/` URLs. The Reference document accepts those same section/subsection/endpoint IDs and also resolves Access fragments back to `/api/`. No CSP-breaking inline bootstrap is required. New first-party navigation points directly at the canonical document; plain anchor links retain browser hashchange behavior.

Structured-data documentation and catalog URLs use `API_REFERENCE_URL` from `shared/lib/public-api-contract.ts`. Existing `/api/#webapi` and `/api/#data-catalog` entity IDs stay stable; they identify entities, not the current document location.

## `/api/` Shell Contract

Access presents supporter and partner offers, the free Safety grades feed and claim workflow. Reference presents integration guidance, artifacts and every public non-admin API section. The route uses `FeaturePageShell`; visible FAQ and FAQPage schema agree on Reference, not a duplicate Access FAQ.

### Anchors

`API_PAGE_ANCHORS` in `shared/lib/public-api-contract.ts` owns supporter-key, partner-access, claim and developer-resources IDs. Change constants/callers atomically; funding, Worker errors and `/feedback/` redirect depend on them. The retired feedback route lands at `/api/#partner-access`, not a public key-request form.

### Private channel

`shared/lib/public-api-contract.ts` owns Telegram-primary/X-secondary handles, URLs, reply window and partner template. Partner requests, lost/leaked supporter tokens and record-removal requests stay private, never in Feedback GitHub issues. `/api/` hides global feedback triggers and publishes no API-access email. Delete request messages after issuance/rotation; anti-impersonation copy never asks for wallet credentials or DM payment.

### Partner key terms

Use ops-limit constants for published default rates, never the validation ceiling as capacity. Service commitments are not contractual SLA or uptime/breaking-notice promises. Free-to-users services are free; commercial terms are agreed per request. Do not name partners as endorsements. Operator-issued keys remain internal tier standard with protected-cache isolate fast path; ops authentication is not a public key.

### Qualifying coins

`DONOR_KEY_QUALIFYING_STABLECOINS` in `shared/lib/funding/donor-eligibility.ts` is the reviewed `(chain, token contract)` authority. Page names/grade groups derive from build-time `scores-latest` via `getSnapshotSafetyAssessment`, stamped with snapshot date, not hardcoded tickers. Bridged/look-alike contracts never qualify by symbol. A/B including modifiers is in-band; absent grade is unavailable, not does not count. Only confirmed all-outside-band copy may say none qualify; unavailable eligibility must not invite a donation as certain. Live claim rechecks independently.

### Wallet check

`DonorWalletCheck` is advisory and lazy: it reads committed ledger plus live free `GET /api/safety-grades` only after first check. It never signs or posts a claim. Injected provider access occurs only on user action; missing provider/rejection is recoverable. `resolveDonorWalletGrades` invalidates retained grades on failed refresh, and a held publication means no grades.

`checkDonorWallet` uses canonical eligibility helpers: eligible is inclusive threshold; short requires current grades and proof that unavailable rows could not reach it; unconfirmed covers loading/failure/hold or potentially qualifying unknown rows, never a false shortfall. No donations means none in the dated committed ledger, not no later transfer. Announce results in a pre-mounted polite status region and always state the claim checks again when signing.

### Social proof

Use `summarizeDonations().lifetimeCommunityDonorCount`, the same full population as Funding, never a displayed/capped donor count.

### One Beam exception

`/api/` renders no One Beam hero metric. Both offers must land in the first desktop viewport; a metric band would push them below the fold. This is the route-owned exception to [feature-page heroes](./design-language.md#feature-page-heroes).

## Retired Self-Serve Lane

Request/verify/admin-decision routes are unregistered; unknown-path auth behavior and remaining self-serve key authentication belong to [API reference](./api-reference.md). Existing keys and revocation tombstones still work through their expiry; D1-only auth is not removed merely because issuance stopped. Existing self-serve tables remain until a separate coordinated destructive rollout after compatible Worker activation; daily pruning continues meanwhile. Do not infer cleanup from removed UI, and do not roll back into incompatible key handling.

## Supporter Key Claim Contract

One key per eligible externally-owned sender wallet; direct donations count only after reconciliation into the committed ledger. Values are receipt-date USD, not claim-time prices; EURC uses receipt-date FX, not parity. Pool/Giveth/exchange withdrawals and unsupported smart-contract signatures do not qualify. Founder qualifying rows may count. [Funding](./funding-page.md#data-model) owns ledger approval/pricing; [API reference](./api-reference.md) owns request/auth and error details.

Use `DONOR_API_KEY_MIN_USD` (inclusive threshold), donor rate and reviewed deployments from shared constants. Current non-held accepted Safety Score A/B-band grades determine claim-time eligibility; missing/NR/out-of-band do not count, and missing/unavailable/held publication pauses with 503. Later grade changes do not revoke issued keys. Donor keys have no expiry and re-signing never rotates them. Lost/leaked token or removal needs operator wallet verification/private rotation or deletion. Public copy states every-Sunday ledger updates and the reconciliation date, not instant claims.

`src/components/donor-key-claim.tsx` uses injected-wallet account request, route/domain-pinned SIWE with short expiry, personal_sign and public claim endpoint. No wallet library or automatic wallet interaction. Rejection/account change recover. Distinct validation, forbidden, conflict, rate and unavailable responses remain actionable; already-claimed/revoked recovery points privately.

The shared one-time token panel reveals plaintext once with copy/focus handling. Pending unsaved token stays in browser memory across internal/back/palette navigation via `PendingApiKeyRecovery`; copy/acknowledgment clears it. Warn before unload; never persist tokens in localStorage/sessionStorage.

### Activation And Rollback Acceptance

`DONOR_KEY_CLAIMS_OPEN` is shared by Worker/Pages. Paused Worker rejects before body read; Pages replaces signing with a paused notice while retaining terms. Apply additive migration `0238_api_key_donor_claims.sql` before a compatible enabled Worker with `DONOR_KEY_CLAIM_RATE_LIMIT`, then matching Pages.

Before announcing, acceptance identifies both deployed versions and the accepted non-held publication, maps counted donations to its A/B grades and proves a live eligible-wallet claim. Confirm stored donor tier/null expiry, ten successful protected requests in one fixed-minute bucket then 429, replay 409, free-grades no-key success and protected-data no-key rejection. Blog/release copy is not acceptance evidence. Pause by shipping the constant, never rolling back to a Worker without donor tier while donor keys exist. Retain additive claim table on rollback.

## Reference Tab Contract

Render canonical reference minus admin sections, preserving section/subsection/endpoint-directory anchors and quickstart. Lane guidance separates external `https://api.pharos.watch` plus `X-API-Key`, website `/_site-data/*`, and Access-protected ops hosts. No-key classifications derive from canonical endpoint registry, including anonymous publication reads and separately authenticated Telegram exceptions; examples run from servers/scripts, not browser-key exposure.

Keep the exemption roster only in canonical [Public API Auth](./api-reference.md#public-api-auth); the FAQ links there and Quick facts does not repeat it. The free-grades example remains onboarding guidance, not an exhaustive no-key list. FAQ answer links render through the reference panel's existing inline Markdown renderer; JSON-LD answers retain link text without Markdown syntax or destinations.

OpenAPI/Postman and static-download links derive from shared artifact/descriptors. Artifact/DataCatalog/Dataset schema uses public URLs and complete nested catalog identity, never private site-data paths. Visible dataset descriptions distinguish snapshots from live API; sameAs/url point to their visible `/api/reference/#dataset-<topic>` descriptions without changing stable IDs/downloads. FAQ must not advertise closed issuance, paid tier or public-feedback key requests.

## Parsing And Rendering Contract

`src/lib/api-reference-doc.ts` owns the supported Markdown subset. If canonical prose adds a structure, extend parser/render tests together rather than silently dropping it. Long inline tokens wrap at narrow widths; fenced blocks scroll independently. Do not keep a second parser-construct inventory here.

## Update Rules

Change anchor/channel/template constants once, then dependent Pages, Worker messages and generators. HTTP changes update API reference first; route copy remains presentation/navigation. Access/terms changes include both documents, Funding pointers and claim/rollback acceptance. Route moves include redirects, sitemap and architecture.
