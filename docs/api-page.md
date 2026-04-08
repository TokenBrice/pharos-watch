# API Page Contract

Route contract for `/about/api/`, the public-facing API reference page for external Pharos integrations.

---

## Route Shape

- **Route:** `/about/api/`
- **Server route:** `src/app/about/api/page.tsx`
- **Error boundary:** `src/app/about/api/error.tsx`
- **Build-time doc parser:** `src/lib/api-reference-doc.ts`
- **Reference source of truth:** `docs/api-reference.md`
- **Navigation rail:** `src/components/longform-scrollspy-nav.tsx`

The route is a static build-time page. It reads the checked-in API reference markdown from `docs/api-reference.md`, parses the supported markdown subset (paragraphs, lists, tables, code fences, rules, H2/H3 headings), and renders that content inside the public site chrome.

---

## Purpose

The page exists to give external integrators one public URL that explains:

1. which Pharos host they should call
2. when an API key is required
3. how the public, internal site, and ops/admin lanes differ
4. the full endpoint contract already maintained in `docs/api-reference.md`

This page is presentation and navigation around the canonical contract, not a second hand-maintained API spec.

---

## Shell Contract

The route renders:

1. Breadcrumbs: `Dashboard / About / API Reference`
2. Hero copy that makes the auth model explicit:
   - external integrations use `https://api.pharos.watch`
   - protected public routes require `X-API-Key`
   - only a narrow no-key set remains on the public host (`health`, OG images, `feedback`, and `telegram-webhook` with Telegram secret auth)
   - the website itself uses the internal `/_site-data/*` lane instead
   - operators use Cloudflare Access on the ops hosts, not public API keys
3. Three top-fold lane cards:
   - `External API`
   - `Website lane`
   - `Ops lane`
4. A `Need A Key?` notice that sends users to the Pharos Telegram channel and tells them to include intended usage, endpoints, cadence, and expected volume when requesting a key
5. A `Before You Call The API` section rendered from the intro portion of `docs/api-reference.md`
6. A top-level scrollspy rail driven by H2 sections from the markdown doc
7. Per-section endpoint indexes when a section contains H3 endpoint subsections

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
- bold text
- absolute `http(s)` links
- root-relative site links

If `docs/api-reference.md` starts using additional markdown constructs that the page should render faithfully, update the parser and this document in the same change.

---

## Update Rules

- Treat `docs/api-reference.md` as the canonical HTTP contract.
- Update `/about/api/` hero/auth copy when the lane split, key requirement, key-request workflow, or operator-access model changes.
- Update the parser only when the markdown source adds a new structure the page needs to support.
- If the route path changes, also update `src/app/sitemap.ts`, `docs/README.md`, and `docs/architecture.md`.
