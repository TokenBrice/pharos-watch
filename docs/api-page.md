# API Access And Reference Pages

Route contract for the public API access and reference surfaces for external Pharos integrations.

---

## Route Shape

- **Access route:** `/api/`
- **Access route file:** `src/app/api/page.tsx`
- **Access client form:** `src/components/api-key-request-form.tsx` facade, `src/components/api-key-request-fields.tsx`, `src/components/api-key-request-reveal.tsx`, and `src/hooks/use-api-key-request-form-state.ts`
- **Reference route:** `/about/api/`
- **Server route:** `src/app/about/api/page.tsx`
- **Error boundary:** `src/app/about/api/error.tsx`
- **Build-time doc parser:** `src/lib/api-reference-doc.ts`
- **Reference source of truth:** `docs/api-reference.md`
- **Navigation rail:** `src/components/api-reference-layout.tsx` and `src/components/api-reference-sidebar.tsx`

Both routes are static build-time pages. `/api/` renders the self-serve key request and verification flow. `/about/api/` reads the checked-in API reference markdown from `docs/api-reference.md`, parses the supported markdown subset (paragraphs, lists, tables, code fences, rules, H2/H3 headings), and renders a concise public integration guide plus an endpoint directory inside the public site chrome. The exhaustive HTTP contract remains canonical at `/docs/api-reference/`.

---

## Purpose

The access page exists to let external integrators request an email-verified default API key without exposing requester details outside private operator tooling. The reference page exists to give external integrators one public URL that explains:

1. which Pharos host they should call
2. when an API key is required
3. how the public, internal site, and ops/admin lanes differ
4. the public/reference endpoint contract already maintained in `docs/api-reference.md`

The `/api/` form posts to `POST /api/api-key-requests` and verifies email links through `POST /api/api-key-requests/verify`. Verification links use raw `/api/#akv_...` URL fragments only — the token never appears in the query string, so it is not sent to the server in the page request, logged by intermediaries, or leaked via Referer. The fragment deliberately avoids a `verify=` parameter shape so the route bundle does not resemble a phishing-kit URL parser. Successful verification reveals the plaintext API token once, removes the fragment from the browser URL before calling the API, and warns on navigation until the token is copied or acknowledged. It does not persist tokens in local storage. Verification links expire after 30 minutes.

The default self-serve key policy is:

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
   - only a narrow no-key set remains on the public host (`health`, OG images, `feedback`, self-serve key request/verify, and `telegram-webhook` with Telegram secret auth); the Telegram Mini App session/mutation no-key exception (signed `initData`) is called out in the access FAQ
   - the website itself uses the internal `/_site-data/*` lane instead
   - operators use Cloudflare Access on the ops hosts, not public API keys
3. Four top-fold cards in one grid:
   - `External API` lane
   - `Website lane`
   - `Ops lane`
   - `Quick Facts` (public auth header, no-key public routes, admin auth on the ops hosts)
4. A `Need A Key?` notice that links to `/api/` and summarizes the email-verified 30 rpm / 60 day default key
5. Direct links to the static machine-readable integration artifacts:
   - `/openapi.json`
   - `/postman/pharos-api.postman_collection.json`
   - `/postman/pharos-api.postman_environment.json`
6. Data-catalog JSON-LD describing the public integration artifacts and crawlable static dataset downloads without pointing at `/_site-data/*`; Dataset nodes that use `includedInDataCatalog` include the catalog `@id`, `name`, and `url` so Google can validate the nested catalog reference in isolation. The `public-datasets` section renders the four mirror descriptions from `PUBLIC_DATASET_JSON_LD_DESCRIPTORS` with JSON, CSV, NDJSON and Sheets CSV links, explicitly distinguishing published snapshots from live API responses. Each mirror Dataset's `url` and `sameAs` target the matching visible `/about/api/#dataset-<topic>` description; stable Dataset IDs and `distribution.contentUrl` downloads are unchanged.
7. A visible API access FAQ rendered with matching `FAQPage` JSON-LD
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
- Update `/api/` form copy and `/about/api/` hero/auth copy when the lane split, key requirement, key-request workflow, or operator-access model changes.
- Update the parser only when the markdown source adds a new structure the page needs to support.
- If the route path changes, also update `src/app/sitemap.ts`, `docs/README.md`, and `docs/architecture.md`.
