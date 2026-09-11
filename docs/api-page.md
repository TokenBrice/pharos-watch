# API Access And Reference Pages

Route contract for the public API access and reference surfaces for external Pharos integrations.

---

## Route Shape

- **Access route:** `/api/`
- **Access route file:** `src/app/api/page.tsx`
- **Access client form:** `src/components/api-key-request-form.tsx` facade, `src/components/api-key-request-fields.tsx`, `src/components/api-key-request-reveal.tsx`, and `src/hooks/use-api-key-request-form-state.ts`
- **Supporter key claim client:** `src/components/donor-key-claim.tsx`, sharing the one-time token panel with the self-serve reveal
- **Reference route:** `/about/api/`
- **Server route:** `src/app/about/api/page.tsx`
- **Error boundary:** `src/app/about/api/error.tsx`
- **Build-time doc parser:** `src/lib/api-reference-doc.ts`
- **Reference source of truth:** `docs/api-reference.md`
- **Navigation rail:** `src/components/api-reference-layout.tsx` and `src/components/api-reference-sidebar.tsx`

Both routes are static build-time pages. `/api/` renders the self-serve key request and verification flow. `/about/api/` reads the checked-in API reference markdown from `docs/api-reference.md`, parses the supported markdown subset (paragraphs, lists, tables, code fences, rules, H2/H3 headings), and renders a concise public integration guide plus an endpoint directory inside the public site chrome. The exhaustive HTTP contract remains canonical at `/docs/api-reference/`.

---

## Purpose

The access page exists to advertise the free no-key Safety Score grades feed (`GET /api/safety-grades`) and, when self-serve issuance is open, to let external integrators request an email-verified default API key without exposing requester details outside private operator tooling. The reference page exists to give external integrators one public URL that explains:

1. which Pharos host they should call
2. when an API key is required
3. how the public, internal site, and ops/admin lanes differ
4. the public/reference endpoint contract already maintained in `docs/api-reference.md`

The `/api/` form posts to `POST /api/api-key-requests` and verifies email links through `POST /api/api-key-requests/verify`. Verification links use raw `/api/#akv_...` URL fragments only — the token never appears in the query string, so it is not sent to the server in the page request, logged by intermediaries, or leaked via Referer. The fragment deliberately avoids a `verify=` parameter shape so the route bundle does not resemble a phishing-kit URL parser. Successful verification reveals the plaintext API token once, removes the fragment from the browser URL before calling the API, and warns on navigation until the token is copied or acknowledged. It does not persist tokens in local storage. Verification links expire after 30 minutes.

Self-serve issuance is switched by `SELF_SERVE_ISSUANCE_OPEN` in `shared/lib/public-api-contract.ts`, currently `false`. Closed means: the Worker answers `POST /api/api-key-requests` with `403` before parsing the body, `/api/` renders a "Self-serve key issuance is closed" notice (pointing at the free grades feed and the feedback form for by-hand requests) instead of the request form, and `/about/api/` copy and FAQ switch to the closed wording. The verification/reveal component stays mounted independently from request intake, so already-sent fragment links are scrubbed and verified even while issuance is closed. Flip the constant to reopen; both sides read the same value.

`/api/` also renders a **Supporter Key** section between the free-grades card and the self-serve notice. It states the perk and its terms: one key per wallet that has donated at least $10 in stablecoins, valued in receipt-date USD across the reconciled ledger on `/funding/` (exclude `pool` rows and non-stablecoin assets; founder stablecoin rows count), `tier="donor"`, exactly 10 requests per minute, no expiry, and no rotation by re-signing. The threshold is inclusive, so exactly $10 qualifies. Only stablecoins graded A+, A, A-, B+, B, or B- in the current non-held canonical accepted V9 Safety Score publication at claim time count. C/D/F/NR or missing grades do not count; an unavailable, missing, or held publication pauses claims with `503`. Values remain USD at receipt, not claim-time prices. Later grade changes do not revoke or alter an issued key. It names the ledger reconciliation date, says claims are not instant because the donor list is updated once a week on Sunday mornings and a donation counts only once it appears on the funding page, says only externally-owned sender wallets can sign, and points a lost key at the `/feedback/` form for an operator rotation.

The claim component runs entirely in the browser and uses no wallet library:

1. `eth_requestAccounts` on the injected provider. The button always renders; with no `window.ethereum`, clicking it shows a notice to open the page inside a wallet's in-app browser or use a desktop browser wallet.
2. Build the Sign-In-With-Ethereum (EIP-4361) message text for domain `pharos.watch` and URI `https://pharos.watch/api/`, with a client nonce and a 5-minute expiration.
3. `personal_sign` with the selected account. User rejection and an account change mid-flow are handled as recoverable states.
4. `POST https://api.pharos.watch/api/donor-key-claims` with `{ message, signature }` through the public-API helper, with specific copy for each of `400`, `403`, `409`, `429`, and `503`.
5. Reveal the plaintext token once in the shared one-time token panel, which keeps copy-to-clipboard and focus handling. An unsaved token stays in shared browser memory across internal navigation (including browser back and command-palette navigation), with a recovery panel in the root layout; copying or acknowledging it clears that pending state. Both issuance flows warn before document unload and never store tokens in localStorage or sessionStorage.

Supporter claims are switched by `DONOR_KEY_CLAIMS_OPEN` in `shared/lib/public-api-contract.ts`, enabled for this release. Paused means: the Worker answers `POST /api/donor-key-claims` with `403` before reading the body, and `/api/` renders the perk description with a paused notice in place of the connect-and-sign control. Release sequence: apply additive migration `0238_api_key_donor_claims.sql` before deploying the Worker with claims enabled and the `DONOR_KEY_CLAIM_RATE_LIMIT` binding, then deploy the matching Pages build. Acceptance must identify both deployed versions and the non-held accepted V9 publication used for eligibility, confirm the counted donations map to A/B-band grades in that publication, and prove a live claim from an eligible wallet, stored `tier="donor"` with null expiry, ten successful protected requests in one fixed-minute bucket followed by `429`, and replay rejection with `409`. Also prove no-key free-grades success and no-key protected-data rejection. The blog describes the release contract; it is not production acceptance evidence. Do not externally announce the release until these checks pass. To pause claims later, flip the constant back and release; never roll the Worker back to a version without the donor tier while donor keys exist. Keep the additive claim table on rollback. Both sides read the same value.

The keyed-access notice adds one sentence for partner integrations: an integration that delivers a freely available, non-profit service on top of Pharos data (FrankenCoin and Octav are the current examples) gets a standard key at no cost on request through the feedback form.

The default self-serve key policy when open is:

- email-verified before issuance
- `30` requests per minute
- `60` day expiry
- one active or pending self-serve key claim per normalized email
- request details visible only in the private `ops.pharos.watch/admin-api/` UI

The reference page is presentation and navigation around the canonical contract, not a second hand-maintained API spec. It renders only selected overview sections from `docs/api-reference.md` plus a route directory derived from the canonical public endpoint section. Full endpoint field tables, examples, edge cases, and admin sections remain in `docs/api-reference.md` and `/docs/api-reference/`.

The machine-readable OpenAPI artifact now factors repeated response definitions into `$ref` components under `components/schemas`, while the previous inline artifact remains available in git history for clients that depended on that representation.

---

## Shell Contract

The route renders:

1. Breadcrumb JSON-LD (structured data only, not a visible element): `Home / About / API Reference`
2. Top-fold copy that makes the auth model explicit (hero paragraph plus the lane and `Quick Facts` cards):
   - external integrations use `https://api.pharos.watch`
   - protected public routes require `X-API-Key`
   - only a narrow no-key set remains on the public host (`safety-grades`, `health`, OG images, `feedback`, self-serve key request/verify, the supporter-key claim `donor-key-claims`, and `telegram-webhook` with Telegram secret auth); the Telegram Mini App session/mutation no-key exception (signed `initData`) is called out in the access FAQ
   - the website itself uses the internal `/_site-data/*` lane instead
   - operators use Cloudflare Access on the ops hosts, not public API keys
3. Four top-fold cards in one grid:
   - `External API` lane
   - `Website lane`
   - `Ops lane`
   - `Quick Facts` (public auth header, no-key public routes including the supporter-key claim, supporter-key terms, admin auth on the ops hosts)
4. A `Need A Key?` notice that names the free `GET /api/safety-grades` feed, then either summarizes the email-verified 30 rpm / 60 day default key and links to `/api/` (open) or states that issuance is closed and links to `/api/` for current options (closed). It also names the supporter key for donor wallets (10 requests per minute, no expiry) and the free standard key for freely available non-profit integrations requested through the feedback form
5. Direct links to the static machine-readable integration artifacts:
   - `/openapi.json`
   - `/postman/pharos-api.postman_collection.json`
   - `/postman/pharos-api.postman_environment.json`
6. Data-catalog JSON-LD describing the public integration artifacts and crawlable static dataset downloads without pointing at `/_site-data/*`; Dataset nodes that use `includedInDataCatalog` include the catalog `@id`, `name`, and `url` so Google can validate the nested catalog reference in isolation. The `public-datasets` section renders the four mirror descriptions from `PUBLIC_DATASET_JSON_LD_DESCRIPTORS` with JSON, CSV, NDJSON and Sheets CSV links, explicitly distinguishing published snapshots from live API responses. Each mirror Dataset's `url` and `sameAs` target the matching visible `/about/api/#dataset-<topic>` description; stable Dataset IDs and `distribution.contentUrl` downloads are unchanged.
7. A visible API access FAQ rendered with matching `FAQPage` JSON-LD, including a supporter-key entry covering eligibility, the ledger reconciliation and release lag, one key per wallet, and the feedback-form path for a lost key
8. A `Before You Call The API` section rendered from the intro portion of `docs/api-reference.md`
9. A top-level scrollspy rail driven by the concise rendered H2 sections and the endpoint directory
10. An endpoint directory derived from the canonical public endpoint H3 headings, with a clear link to `/docs/api-reference/#public-endpoints` for exhaustive field tables and examples

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
- Update `/api/` form copy and `/about/api/` hero/auth copy when the lane split, key requirement, key-request workflow, supporter-key terms, or operator-access model changes.
- Update the parser only when the markdown source adds a new structure the page needs to support.
- If the route path changes, also update `src/app/sitemap.ts`, `docs/README.md`, and `docs/architecture.md`.
