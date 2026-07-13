# Screener Picker Page

Route contract for `/screener/picker/`, the noindex profile-driven stablecoin shortlist. The Picker asks for a user profile and produces a deterministic shortlist; the Screener remains the durable inspection surface and receives the handoff filters.

## Route Shape

- Shell and metadata: `src/app/screener/picker/page.tsx`
- Client orchestration: `src/app/screener/picker/client.tsx`
- URL/wizard state: `src/app/screener/picker/selector-state.ts`
- Result composition and handoff: `src/app/screener/picker/result-pane.tsx`, `handoff.ts`
- Wizard/result components: `src/components/selector/`
- Engine and data adapter: `shared/lib/selector/`
- Snapshot Pages Function: `functions/selector-snapshot/[[path]].ts`
- Screener entry callout: `src/components/selector/selector-callout.tsx`

The route metadata is `noindex,follow`, canonical `/screener/picker/`, and omitted from the sitemap. The noindex contract is owned by route metadata rather than `public/_headers`.

## Input And Engine Contract

The wizard collects profile, peg, time horizon, depeg tolerance, venue/custody preference, and exit-speed inputs. The available questions and branching live in `selector-state.ts`; the profile and peg policy lives with the shared selector engine.

The engine is deterministic and client-side. It consumes the shared adapter projection of stablecoins, report cards, peg summary, DEWS, DEX liquidity, yield rankings, Bluechip ratings, and redemption backstops. Stablecoin-list and report-card data are critical: failure without retained data produces a typed unavailable state and retry path. Optional source gaps become coverage signals.

`SelectorOutput` is both the result view model and replay contract. It owns shortlist and lower-ranked rows, authored explanations, coverage warnings, exclusions and near misses, relaxed constraints, confidence, methodology versions, dataset hash, engine version, and per-input staleness. UI copy must not expose internal reason/weight keys or claim a fixed result count.

Changes to ranking, exclusion, missing-data, tie-break, explanation, or deterministic-output semantics require an engine-version update through `shared/lib/selector/version.ts` and focused engine/editorial-policy tests.

## Navigation And Accessibility

Desktop uses a stepwise wizard; browser history walks completed steps. Mobile uses the compact form and a single result commit after required inputs are complete.

Step changes are announced politely and move focus to the active question. Loading states expose `aria-busy`; result generation and snapshot replay move focus to the result summary. Option cards, skipped rows, near misses, relax actions, and result links remain keyboard operable and usable at narrow widths and 200 percent zoom.

Result actions include adjusting answers, verifying the projected filters in `/screener/`, creating a share link, and contextual compare, Telegram, Yield, or per-coin links when the output supports them. `src/app/screener/picker/handoff.ts` is the authority for the Screener URL and human-readable filter chips.

## Browser Storage

| Key | Store | Purpose |
| --- | --- | --- |
| `pharos.selector.callout.v1` | `localStorage` | Screener callout dismissal. |
| `pharos.selector.sessionResult.v1` | `sessionStorage` | Optional last successful live-result recovery for the tab session. |

The Picker does not create a long-lived local result history. Restored session output is visibly identified. [privacy-page.md](./privacy-page.md) owns the user-facing storage categories.

## Snapshot Sharing

Share creation posts only the allowlisted selector input. `functions/lib/selector-canonical-snapshot.ts` reloads canonical sources, runs the shared adapter and engine, and writes the server-recomputed projection to `SELECTOR_SNAPSHOTS` KV. Caller-provided scores, identities, hashes, or prose are not trusted.

| Surface | Behavior |
| --- | --- |
| `POST /selector-snapshot` | Same-origin input validation, canonical recomputation, content-addressed snapshot write, `{ sid, ev }` response. |
| `GET /selector-snapshot/:sid` | Returns a verified or explicitly legacy-unverified snapshot, or a typed miss/error. |

Snapshot identifiers are content-addressed. Verified schema-v3 artifacts require matching trusted KV metadata and render as Pharos-verified. Legacy bodies without trusted metadata remain client-unverified. A missing sid-only snapshot shows not found rather than silently substituting current output.

Loaded snapshots remain frozen by default. The user can compare the frozen input with current data, including shortlist/rank, dataset hash, engine version, and methodology-version differences, without overwriting the stored artifact.

The exact schema, canonicalization, size limit, origin checks, quota reservation, TTL extension, and HTTP error mapping are owned by:

- `shared/lib/selector/snapshot.ts`
- `shared/lib/selector/canonicalize.ts`
- `functions/lib/selector-canonical-snapshot.ts`
- `functions/selector-snapshot/[[path]].ts`
- the Pages Function section of [api-reference.md](./api-reference.md)

Do not duplicate their full validation matrix here.

## OG Images

`public/og-selector-default.png`, `og-selector-treasury.png`, `og-selector-yield.png`, and `og-selector-trading.png` are profile-level cards. Snapshot-specific social cards are intentionally not served, so shared output and answers do not appear in social preview fetches. See [og-images.md](./og-images.md).

## Deferred Surface

There is no standalone public `/methodology/selector/` route today. Selector methodology and explanation remain in the Picker UI and shared engine contracts. Adding a dedicated methodology route is a future product decision, not a dated post-ship promise.

## Update Rules

- Wizard/input change: update `selector-state.ts`, route components, and state tests.
- Engine semantics: update `shared/lib/selector/`, engine version, and engine/editorial-policy tests.
- Snapshot payload or endpoint: update the shared snapshot modules, Pages Function tests, [api-reference.md](./api-reference.md), and [privacy-page.md](./privacy-page.md) when storage changes.
- Screener handoff: update `handoff.ts` and [screener-page.md](./screener-page.md).
- OG behavior: update the profile cards and [og-images.md](./og-images.md).

The focused test surfaces are `shared/lib/selector/`, `src/app/screener/picker/`, `src/components/selector/`, and `functions/__tests__/selector-snapshot.test.ts`.
