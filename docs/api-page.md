# API Access And Reference Pages

Route contract for the public API access and reference surfaces for external Pharos integrations.

---

## Route Shape

- **Access route:** `/api/`
- **Access route file:** `src/app/api/page.tsx`
- **Offer cards (route-local):** `src/app/api/api-offer-cards.tsx` renders the `#supporter-key` and `#partner-access` cards and the free-grades band
- **Claim steps (route-local):** `src/app/api/supporter-claim-steps.tsx` renders the three-step strip, the wallet check and the two `<details>` blocks in the `#claim` section
- **Wallet check (route-local client):** `src/app/api/donor-wallet-check.tsx`, with the pure mapping in `src/lib/donor-wallet-check.ts` and the lazy `useSafetyGrades` hook (`src/hooks/api-hooks.ts`)
- **Disclosure blocks (route-local):** `src/app/api/api-disclosure.tsx` renders the shared `<details>` blocks: framed (bordered box) in the `#claim` section, unframed (`framed={false}`, top rule only) for the partner template inside its card
- **Qualifying-coin derivation:** `src/lib/donor-key-qualifying-coins.ts` joins `DONOR_KEY_QUALIFYING_STABLECOINS` with the build-time snapshot grades
- **Supporter key claim client:** `src/components/donor-key-claim.tsx`, revealing the token through the shared one-time token panel (`src/components/issued-token-panel.tsx`)
- **Reference route:** `/about/api/`
- **Server route:** `src/app/about/api/page.tsx`
- **Error boundary:** `src/app/about/api/error.tsx`
- **Build-time doc parser:** `src/lib/api-reference-doc.ts`
- **Reference source of truth:** `docs/api-reference.md`
- **Navigation rail:** `src/components/api-reference-layout.tsx` and `src/components/api-reference-sidebar.tsx`

Both routes are static build-time pages. `/api/` is the API access page: it advertises the free grades feed, presents the two keyed-access offers, and hosts the supporter-key claim. `/about/api/` reads the checked-in API reference markdown from `docs/api-reference.md`, parses the supported markdown subset (paragraphs, lists, tables, code fences, rules, H2/H3 headings), and renders a concise public integration guide plus an endpoint directory inside the public site chrome. The exhaustive HTTP contract remains canonical at `/docs/api-reference/`.

---

## Purpose

`/api/` has two jobs:

1. **Supporter key:** get donors of `$`{`DONOR_API_KEY_MIN_USD`} (10) or more to claim and use their free supporter key, and make non-donors want one.
2. **Partner key:** tell professional teams that partner keys with higher limits, integration help and direct support are available on request.

Everything else (the full endpoint catalogue, quickstart code examples, the access FAQ) belongs on `/about/api/` and `/docs/api-reference/`, and `/api/` links there. Both offer CTAs sit in the first desktop viewport; on mobile the supporter card renders first.

The access page also advertises the free no-key Safety Score grades feed (`GET /api/safety-grades`) in the band between the two offers and the claim section.

The reference page exists to give external integrators one public URL that explains:

1. which Pharos host they should call
2. when an API key is required
3. how the public, internal site, and ops/admin lanes differ
4. the public/reference endpoint contract already maintained in `docs/api-reference.md`

---

## `/api/` Shell Contract

The route renders inside `FeaturePageShell` (`src/components/feature-page-shell.tsx`). Design tier: Discovery public landing (`docs/design-language.md`), with generous whitespace, step explainers, and no cards inside cards. Metadata: title `Stablecoin API Access: Supporter and Partner Keys`, breadcrumb name `API Access` (matching the nav label). There is no FAQ section and no FAQPage JSON-LD on this route; the two `<details>` blocks and the partner card cover the questions.

Section order:

0. **Hero:** H1 `Pharos API access`, a two-sentence lead saying Safety Score grades need no key and naming the data the keys unlock (peg, supply, liquidity, reserve and depeg data need a supporter or partner key), and three jump pills: `Supporter key` to `#supporter-key`, `Partner key` to `#partner-access`, `API reference` to `/about/api/`.
1. **Two offer cards in one grid, supporter first (mobile order too):** each card is top-aligned (`md:items-start`) and sized to its own content, so opening the partner template never stretches the supporter card.
   - `#supporter-key` (kicker `For individual builders`): pitch, three facts rendered from constants (`{DONOR_API_KEY_RATE_LIMIT_PER_MINUTE}` requests/min, no expiry, every read endpoint), the qualifying-coin line (`Counts toward the key: {names}, graded A or B as of {date}.`), the community social-proof line, a filled `Claim your key` CTA to `#claim` plus an outline donation CTA to `/funding/#how-to-support`, and revocable, no-SLA fine print.
   - `#partner-access` (kicker `For teams in production`): pitch, bullets (rate, expiry and rotation, integration help, service commitments, cached endpoints during brief database outages), the public-good line, a filled Telegram CTA plus an outline X CTA (both wrap instead of overflowing at 320px), and an unframed `<details>` block holding the copyable `PARTNER_KEY_REQUEST_TEMPLATE` with a copy button, closing with the anti-impersonation line (`Check the exact handle. Pharos never asks for wallet credentials or payment by direct message.`).
2. **Free-grades band:** one line naming the free `GET /api/safety-grades` feed, a no-key curl command built from `PUBLIC_API_HOST` and `API_PATHS.safetyGrades()`, and a copy button.
3. **`#claim` section (anchor scroll offset applied):** heading `Claim your supporter key`, the three-step strip (Donate, with the qualifying coins grouped by grade status, the snapshot date in the first group label, and the note that each coin counts only on its listed networks; Wait for Sunday's update, naming the ledger reconciliation date; Sign and copy; on `lg` the Donate step takes a double-width column), `<DonorKeyClaim />` (see Supporter Key Claim Contract; its own no-wallet notice covers the browser-wallet requirement, so the section has no separate requirement line), the `Already donated? Check a wallet` disclosure (see Wallet check), and two `<details>` blocks: `Which donations count` and `Lost key, privacy and terms`. `Which donations count` includes one bullet generated at build time from `DONOR_KEY_QUALIFYING_STABLECOINS[].contracts` and `CHAIN_META` names: the coins on every funding network, then the network list for each other coin, ending `Bridged or look-alike tokens never count.` The lost-key bullet ends with the same anti-impersonation line as the partner template.
4. **`#developer-resources` nav:** link pills for `/about/api/`, `/docs/api-reference/`, the OpenAPI and Postman artifacts from `PUBLIC_API_ARTIFACTS`, and `/status/`.

### Anchors

Section ids come from `API_PAGE_ANCHORS` in `shared/lib/public-api-contract.ts`: `supporterKey` maps to `supporter-key`, `partnerAccess` to `partner-access`, `claim` to `claim`, `developerResources` to `developer-resources`. Inbound links target these anchors: the funding page and `/about/api/` deep-link `#supporter-key`; Worker messages and `API_PARTNER_ACCESS_URL` (`https://pharos.watch/api/#partner-access`) target `#partner-access`; the `/feedback/` redirect lands there too. Never rename an anchor without changing the constant and its callers in the same change.

### Private channel

Partner-key requests, lost supporter keys, and key-record removal use one private channel: Telegram DM to `@TokenBrice` (`API_ACCESS_TELEGRAM_HANDLE`, `API_ACCESS_TELEGRAM_URL`) as primary, X DM to `@PharosWatch` (`API_ACCESS_X_HANDLE`, `API_ACCESS_X_URL`) as secondary. All four constants live in `shared/lib/public-api-contract.ts`, next to `PARTNER_KEY_REPLY_BUSINESS_DAYS` and `PARTNER_KEY_REQUEST_TEMPLATE`. Key requests never go to the feedback modal: it files public GitHub issues. The global Feedback button (desktop floating button and mobile utility dock) is hidden on `/api/`, so the page offers no route to that modal. No email address for API access appears on any public surface. Channel request messages are deleted once the key is issued or rotated.

### Partner key terms

- Rate: `from {API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE} requests/min, raised per key`, reading `API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE` from `shared/lib/ops-limits.ts`. Never publish the 10,000 validation ceiling or any other capacity figure.
- Support: `Service commitments, not a contractual SLA: freshness stamped on every response and a human reply within {PARTNER_KEY_REPLY_BUSINESS_DAYS} business days.` No uptime percentage and no breaking-change notice commitment; `docs/api-reference.md` deliberately has no change-policy section.
- Commercial terms: `Free when your service is free to its users. Commercial integrations agree terms per request.`
- No partner names appear as references.
- The internal tier stays `standard`; partner keys are operator-issued through the ops key routes and keep the isolate fast path on protected cacheable reads.

### Qualifying coins

The supporter card line and claim step 1 derive the qualifying stablecoins by joining `DONOR_KEY_QUALIFYING_STABLECOINS` (`shared/lib/funding/donor-eligibility.ts`; the source file wins) with the build-time `scores-latest` public-dataset snapshot via `getSnapshotSafetyAssessment` (`src/lib/safety-grade-snapshot.ts`), stamped with the snapshot date. Never hard-code the token list on the page. Eligibility is keyed by reviewed `(chain, token contract)` pairs from that constant: each coin counts only on the deployments listed in its `contracts` map, so bridged or same-ticker contracts (for example a bridged `USDC.e`, or a non-Paxos `USDP`) never qualify. A/B grade bands, including modifiers, count; every other published grade is outside-band. An absent grade renders `grade unavailable`, never "does not count" (data-integrity rule R1). The snapshot is informational: grades are checked again at claim time against the live publication.

Claim step 1 groups coins via `donorKeyGradeStatus`: `Counts now` (A/B badge), `Does not count now` (outside-band badge), and `Grade unavailable` (no badge); omit empty groups and stamp the first with the snapshot date. Both offer and Donate copy distinguish no confirmed eligible coin with unavailable grades from every coin explicitly outside-band. Only the latter says none qualifies; neither invites a donation when eligibility is unconfirmed. Claim-time checks remain fail-closed.

### Wallet check

`DonorWalletCheck` is an advisory, client-side `<details>` control mounted after `<DonorKeyClaim />` while claims are open. The visitor pastes an address (`0x` plus 40 hex characters, any case) or presses `Use my wallet`, which reads `window.ethereum` inside the click handler only (`eth_accounts`, then `eth_requestAccounts`) and handles a missing provider and user rejection as notices. It never signs and never calls `POST /api/donor-key-claims`.

Inputs are the committed ledger rows passed from the server page (the same `donations.json` the claim reads) and the live free-lane `GET /api/safety-grades` projection through `useSafetyGrades`, which stays disabled until the first check and then follows the report-card producer polling window. `resolveDonorWalletGrades` (`src/lib/donor-wallet-check.ts`) turns the query into a grades state and grade map: a query in its error state yields no grades even when TanStack Query still holds an earlier successful response, so a failed refresh after a good check never keeps showing a total or `Enough to claim`. `checkDonorWallet` runs `summarizeDonorKeyEligibility` and maps the result to rows (chain, asset, receipt USD, reason: `counted`, `graded {grade} today`, `not a listed coin on this network`, `Giveth stream`, `grade unavailable`) and a verdict:

- `eligible`: counted USD reaches `DONOR_API_KEY_MIN_USD` (inclusive).
- `short`: rendered only with current grades, when even the grade-unavailable rows could not reach the threshold.
- `unconfirmed`: grades are loading, failed (including a failed refresh after an earlier success), or held, or grade-unavailable rows could reach the threshold. The page never states the wallet falls short in this state (R1).
- `no-donations`: no ledger rows for the address as of the ledger date; donations sent later join at the next Sunday update.

The result renders inside a `role="status"` `aria-live="polite"` region that stays mounted before the first check, so screen readers announce it. It always closes with `The claim checks again when you sign.` A held publication is treated as no grades, matching the claim route's `503`.

### Social proof

`Backed by {N} supporters since launch` uses the community donor count from `summarizeDonations` (`shared/lib/funding/helpers.ts`, field `lifetimeCommunityDonorCount`), the same figure `/funding/` renders as supporters. Never publish a display-capped value as the statistic.

### One Beam exception

`/api/` renders no One Beam hero metric. Both offers must land in the first desktop viewport, and a metric band would push them below the fold. This is the recorded exception to the hero-metric convention (owner decision O13 of the 2026-09-28 `/api/` revamp plan).

### `/feedback/` redirect

`/feedback/` is not an app route; without a redirect it 404s. `public/_redirects` sends it to `/api/#partner-access`, so historical links land on the private-channel offer instead of a dead page.

---

## Retired Self-Serve Lane

The self-serve API key request lane was removed on 2026-09-29. `POST /api/api-key-requests`, `POST /api/api-key-requests/verify`, and the admin decision routes under `/api/api-key-requests-admin/` are no longer registered, so they respond like any unknown API path on the public host: `401` without a valid `X-API-Key`, `404` with one. Existing `tier="self-serve"` keys keep authenticating at their `30` requests per minute limit with D1-only auth and revocation tombstones intact, until they drain through their 60-day expiry (about 2026-11-06). The lane's D1 tables (`api_key_requests`, `api_key_request_rate_limit_v2`, `api_key_self_serve_email_claims`, `api_key_self_serve_issuance_limits`) are left in place untouched and are dropped in a separate coordinated follow-up rollout after this Worker is live; until then the daily prune keeps sweeping the self-serve rate-limit table. The operator may delete the lane's now-unused Worker secrets with Wrangler (names only, never values): `API_KEY_SELF_SERVE_IP_SALT`, `API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER`, `API_KEY_SELF_SERVE_REQUEST_PEPPER`, `API_KEY_SELF_SERVE_EMAIL_FROM`, `API_KEY_SELF_SERVE_EMAIL_REPLY_TO`, `API_KEY_SELF_SERVE_PUBLIC_BASE_URL`, and `RESEND_API_KEY`.

---

## Supporter Key Claim Contract

`/api/` states the perk and its terms: one key per wallet that has donated at least `$10` (`DONOR_API_KEY_MIN_USD`) in the reviewed qualifying stablecoins, identified by `(chain, token contract)` against `DONOR_KEY_QUALIFYING_STABLECOINS` (`shared/lib/funding/donor-eligibility.ts`; the source file wins) and valued in receipt-date USD across the reconciled ledger on `/funding/` (excluding `pool` rows and non-qualifying assets; founder stablecoin rows count; EURC rows carry the ECB EUR/USD reference rate for the receipt date, never 1:1), `tier="donor"`, exactly `{DONOR_API_KEY_RATE_LIMIT_PER_MINUTE}` (10) requests per minute, no expiry, and no rotation by re-signing. The threshold is inclusive, so exactly `$10` qualifies. Only stablecoins graded A+, A, A-, B+, B, or B- in the current non-held canonical accepted V9 Safety Score publication at claim time count. C/D/F/NR or missing grades do not count; an unavailable, missing, or held publication pauses claims with `503`. Values remain USD at receipt, not claim-time prices. Later grade changes do not revoke or alter an issued key.

Page-level timing and wallet limits:

- The donor list is updated every Sunday. Claims are not instant; a donation counts only once it appears on the funding page, and the claim section names the ledger reconciliation date.
- Only externally-owned sender wallets can sign. Smart-contract wallets cannot claim yet; a later phase adds EIP-1271/6492 support. Exchange withdrawals and Giveth streams cannot claim.
- One key per wallet; signing again does not rotate it.
- A lost or leaked key, and any request to remove the key record, goes through the private channel (Telegram `@TokenBrice` primary, X `@PharosWatch` secondary). An operator verifies the donating wallet, then rotates or removes the record by hand. Request messages are deleted once the key is issued or rotated.

The claim component runs entirely in the browser and uses no wallet library:

1. `eth_requestAccounts` on the injected provider. The button always renders; with no `window.ethereum`, clicking it shows a notice to open the page inside a wallet's in-app browser or use a desktop browser wallet.
2. Build the Sign-In-With-Ethereum (EIP-4361) message text for domain `pharos.watch` and URI `https://pharos.watch/api/` (the SIWE URI pins the claim to this route), with a client nonce and a 5-minute expiration.
3. `personal_sign` with the selected account. User rejection and an account change mid-flow are handled as recoverable states.
4. `POST https://api.pharos.watch/api/donor-key-claims` with `{ message, signature }` through the public-API helper, with specific copy for each of `400`, `403`, `409`, `429`, and `503`; the already-claimed (`409`) and revoked-key (`403`) copy points at the private channel.
5. Reveal the plaintext token once in the shared one-time token panel, which keeps copy-to-clipboard and focus handling. An unsaved token stays in shared browser memory across internal navigation (including browser back and command-palette navigation), with a recovery panel (`PendingApiKeyRecovery` in `src/app/layout.tsx`); copying or acknowledging it clears that pending state. The claim flow warns before document unload and never stores tokens in localStorage or sessionStorage.

Supporter claims are switched by `DONOR_KEY_CLAIMS_OPEN` in `shared/lib/public-api-contract.ts`, enabled for this release. Paused means: the Worker answers `POST /api/donor-key-claims` with `403` before reading the body, and `/api/` renders the perk description with a paused notice in place of the connect-and-sign control. Release sequence: apply additive migration `0238_api_key_donor_claims.sql` before deploying the Worker with claims enabled and the `DONOR_KEY_CLAIM_RATE_LIMIT` binding, then deploy the matching Pages build. Acceptance must identify both deployed versions and the non-held accepted V9 publication used for eligibility, confirm the counted donations map to A/B-band grades in that publication, and prove a live claim from an eligible wallet, stored `tier="donor"` with null expiry, ten successful protected requests in one fixed-minute bucket followed by `429`, and replay rejection with `409`. Also prove no-key free-grades success and no-key protected-data rejection. The blog describes the release contract; it is not production acceptance evidence. Do not externally announce the release until these checks pass. To pause claims later, flip the constant back and release; never roll the Worker back to a version without the donor tier while donor keys exist. Keep the additive claim table on rollback. Both sides read the same value.

---

## `/about/api/` Shell Contract

The route renders:

1. Breadcrumb JSON-LD (structured data only, not a visible element): `Home / About / API Reference`
2. Top-fold copy that makes the auth model explicit (hero paragraph plus the lane and `Quick Facts` cards):
   - external integrations use `https://api.pharos.watch`
   - protected public routes require `X-API-Key`
   - no-key access follows the `publicApiAccess` classification in `shared/lib/api-endpoints/` (static definitions plus dynamic descriptors; see `getPublicApiAccess`); anonymous safety-grades and dependency graph/scenario publication reads are rate-limited, while Telegram webhook and Mini App exceptions use their own secret or signed `initData`
   - the website itself uses the internal `/_site-data/*` lane instead
   - operators use Cloudflare Access on the ops hosts, not public API keys
3. Four top-fold cards in one grid:
   - `External API` lane
   - `Website lane`
   - `Ops lane`
   - `Quick Facts` (public auth header, selected no-key public routes including the supporter-key claim, admin auth on the ops hosts)
4. An API-keys section that names the free `GET /api/safety-grades` feed, then points keyed access at `/api/#supporter-key` (supporter key for donors) and `/api/#partner-access` (partner key for teams). There is no issuance branch.
5. A `Quickstart` section (`id="quickstart"`) holding the curl, JavaScript and Python examples moved from `/api/`, built from `buildPublicApiCurlCommand`, `PUBLIC_API_HOST` and `PUBLIC_API_KEY_HEADER`. The examples call from a server or script, never from browser code.
6. Direct links to the static machine-readable integration artifacts:
   - `/openapi.json`
   - `/postman/pharos-api.postman_collection.json`
   - `/postman/pharos-api.postman_environment.json`
7. Data-catalog JSON-LD describing the public integration artifacts and crawlable static dataset downloads without pointing at `/_site-data/*`; Dataset nodes that use `includedInDataCatalog` include the catalog `@id`, `name`, and `url` so Google can validate the nested catalog reference in isolation. The `public-datasets` section renders the four mirror descriptions from `PUBLIC_DATASET_JSON_LD_DESCRIPTORS` with JSON, CSV, NDJSON and Sheets CSV links, explicitly distinguishing published snapshots from live API responses. Each mirror Dataset's `url` and `sameAs` target the matching visible `/about/api/#dataset-<topic>` description; stable Dataset IDs and `distribution.contentUrl` downloads are unchanged.
8. A visible API access FAQ rendered with matching `FAQPage` JSON-LD: how to get a key (supporter key and partner key on `/api/`), whether every endpoint needs a key, the public-lane versus website-lane difference, and admin auth. No entry offers closed issuance, a paid tier, or the feedback form as a key-access channel; feedback submission is named only as a no-key endpoint. JSON-LD answers stay in sync with visible text.
9. A `Before You Call The API` section rendered from the intro portion of `docs/api-reference.md`
10. A top-level scrollspy rail driven by the concise rendered H2 sections and the endpoint directory
11. An endpoint directory derived from the canonical public endpoint H3 headings, with a clear link to `/docs/api-reference/#public-endpoints` for exhaustive field tables and examples

The reference page is presentation and navigation around the canonical contract, not a second hand-maintained API spec. It renders only selected overview sections from `docs/api-reference.md` plus a route directory derived from the canonical public endpoint section. Full endpoint field tables, examples, edge cases, and admin sections remain in `docs/api-reference.md` and `/docs/api-reference/`.

The machine-readable OpenAPI artifact factors repeated response definitions into `$ref` components under `components/schemas`, while the previous inline artifact remains available in git history for clients that depended on that representation.

---

## Parsing And Rendering Contract

`src/lib/api-reference-doc.ts` currently supports these markdown constructs from `docs/api-reference.md`:

- H2 sections (`##`)
- H3 subsections (`###`)
- paragraphs
- unordered and ordered lists
- pipe tables
- fenced code blocks
- horizontal rules (`---`)

Inline rendering supports:

- inline code
- inline code wraps long host lists, token examples and paths at narrow widths; fenced code blocks retain their own horizontal scrolling
- bold text
- absolute `http(s)` links
- root-relative site links

If `docs/api-reference.md` starts using additional markdown constructs that the page should render faithfully, update the parser and this document in the same change.

---

## Update Rules

- Treat `docs/api-reference.md` as the canonical HTTP contract.
- Anchors and channel data are contract constants, not page copy: `API_PAGE_ANCHORS`, `API_PARTNER_ACCESS_URL`, `API_ACCESS_TELEGRAM_HANDLE`, `API_ACCESS_TELEGRAM_URL`, `API_ACCESS_X_HANDLE`, `API_ACCESS_X_URL`, `PARTNER_KEY_REPLY_BUSINESS_DAYS` and `PARTNER_KEY_REQUEST_TEMPLATE` live in `shared/lib/public-api-contract.ts`. `/api/`, `/about/api/`, the Worker error strings and the maintenance generators all read them; change a handle, anchor, reply window or template there once, then update dependent surfaces in the same change.
- Update `/api/` offer and claim copy, and `/about/api/` hero/auth copy, when the lane split, key requirement, key-request workflow, supporter-key terms, or operator-access model changes.
- Update the parser only when the markdown source adds a new structure the page needs to support.
- If the route path changes, also update `src/app/sitemap.ts`, `docs/README.md`, and `docs/architecture.md`.
