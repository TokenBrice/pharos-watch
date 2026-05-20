# Screener Selector Page

Route contract for `/screener/selector/`, the noindex profile-driven stablecoin shortlist.

The Selector flips the Screener relationship: instead of filtering the full universe, the user describes a profile (Treasury, Yield, Active Trading) and Pharos returns a 2–3 coin shortlist plus 1–2 coins to avoid for that profile, with live-data justifications. The Screener remains the durable surface; the Selector seeds it.

---

## Route Shape

- **Server shell:** `src/app/screener/selector/page.tsx` (frontend agent)
- **Client implementation:** `src/app/screener/selector/client.tsx` (frontend agent)
- **URL state codec:** `src/app/screener/selector/selector-state.ts` (frontend agent)
- **Scoring engine:** `shared/lib/selector/engine.ts` + `shared/lib/selector/version.ts` (engine agent)
- **Snapshot canonicalization:** `shared/lib/selector/canonicalize.ts` (engine + integration co-owned)
- **Snapshot Pages Function:** `functions/selector-snapshot/[[path]].ts` (integration)
- **Wizard components:** `src/components/selector/*` (frontend agent)
- **Editorial templates:** `shared/lib/selector/what-to-watch-templates.ts`, `shared/lib/selector/why-keys.ts` (engine agent; banned-phrase lint applies)
- **Entry callout:** `src/components/selector/selector-callout.tsx`, rendered from `src/app/screener/client.tsx`

The route shell is intentionally `noindex,follow`, marks the route as beta, and uses canonical `/screener/selector/`. It is omitted from the sitemap.

---

## Peg Scope

Initial selectable pegs are `USD`, `EUR`, `CHF`, and `GOLD`. This pass is limited to pegs that have enough active rows and live Safety/Peg/DEWS/liquidity/yield coverage to avoid empty Selector routes.

Yield exposes the same peg set (`USD`, `EUR`, `CHF`, `GOLD`). Thin or strict combinations can use the engine's low-confidence fallback rather than returning an empty result, but rows still need required profile signals and a usable Yield source before they can be recommended.

`SILVER`, `VAR`, and `OTHER` are intentionally excluded because their current live signal coverage still produces empty selector routes or needs separate reference-asset treatment. `BRL` is also held back until the `peggedREAL` alias path is audited across sync, price validation, and supplemental-asset creation.

The URL key is `peg`; missing or invalid values default to `USD` for backward compatibility. For `p=yield`, unsupported peg values also normalize to `USD`.

---

## Data Contract

The engine consumes the same React Query hooks the Screener already uses; no new data endpoints land for the Selector. The full list:

1. `useStablecoins()` — tracked universe, prices, supply.
2. `useReportCards()` — Safety Score, per-dimension scores, dependency-graph data.
3. `usePegSummary()` — current peg readings, depeg events.
4. `useStressSignals()` — DEWS scores.
5. `useDexLiquidity()` — Liquidity Score, HHI, multi-DEX presence.
6. `useYieldRankings()` — Pharos Yield Score, source-risk, variance.
7. `useBluechipRatings()` — third-party bluechip grades.
8. `useRedemptionBackstops()` — effective-exit score and redemption-rail data.

The route passes the selected `pegCurrency` into the data adapter. The adapter keeps active rows for that selected peg and computes `datasetHash` over that selected-peg universe, including each row's `pegCurrency`; refetches change `datasetHash` and trigger a fresh selector run. The pure engine still filters by `input.pegCurrency`, so tests can pass an all-peg map safely. The engine reads `methodologyVersion` from each upstream `_meta` / `methodology.version` envelope when present and falls back to `"unversioned"` per endpoint otherwise; gaps surface in the output payload.

---

## Persistence And Sharing

One browser-local key plus one content-addressed server snapshot:

| Key / surface | Type | Lifecycle |
| --- | --- | --- |
| `pharos.selector.callout.v1` | `localStorage` JSON | Callout dismissal state. Survives reloads; clears on site-data clear. |
| `s:{sid}` | KV value (`SELECTOR_SNAPSHOTS`) | Content-addressed snapshot of a `SelectorOutput`. 5-year TTL. |

The current Selector build does not write a last-run recovery key. Storage layer is best-effort; quota errors are silently dropped.

**Snapshot share URL:** `/screener/selector/?sid={32-hex}`. The sid is content-addressed — two runs that produce identical canonical output (modulo timestamp and freshness suffixes) share the same sid. The frozen artifact contains the inputs; the sid is the lookup key.

**Snapshot-miss behavior:** when a sid-only share URL hits a KV miss, the client shows a not-found error instead of silently generating a different live result. If a legacy or hand-authored URL also carries complete wizard state, the client can fall back to live engine output for those inputs with a one-line "Original snapshot no longer cached" banner.

Cross-link: `docs/privacy-page.md` describes the storage policy and the content-addressed snapshot model.

---

## Snapshot Pages Function

`functions/selector-snapshot/[[path]].ts` is the only HTTP surface that the Selector adds. It runs on Cloudflare Pages Functions; no Worker, no D1, no cron.

| Surface | Method | Behavior |
| --- | --- | --- |
| `POST /selector-snapshot` | `POST` | Stores a `SelectorOutput` JSON under a server-recomputed `sid`. Returns `{ sid }`. |
| `GET /selector-snapshot/:sid` | `GET` | Returns the stored `SelectorOutput` or `404`. `private, no-store` so every read re-enters the same-origin gate. |

**Auth:** same-origin only (mirrors `rejectIfNotSiteDataUiOrigin` from `functions/lib/site-data-origin.ts`). Browser CORS blocks cross-origin POST before it reaches the function; no write secret is required. Foreign origins receive `404`.

**Tamper evidence:** the server recomputes the sid via SHA-256 over a canonicalized JSON payload (lexicographically sorted keys, freshness-derived fields stripped, NFC-normalized strings). Clients cannot persist a snapshot under a sid that does not match its content.

**Validation:** the Pages Function does not import frontend code, but it rejects snapshots that are missing the frontend replay fields: `input.pegCurrency`, `universe`, `lowConfidence`, coverage warning counts (`skippedForCoverageCount`, `newListingCount`, `redistributionCount`), and the basic shortlist/lower-ranked row fields (`id`, `symbol`, `name`, rank/slot, score/confidence or reason keys).

**Canonicalization:** the strip rule covers top-level `timestamp` and `perInputStaleness`, plus any field whose name matches the suffixes `ageSeconds`, `capturedAt`, `stalenessMs`, `updatedAt`, `fetchedAt`. `coverageWarnings.newListingCount` is **not** stripped; the implemented engine derives it from content-level recent-listing flags, so it contributes to the sid. Cross-client sid consistency depends on this denylist; engine and integration agreed on the same strip-list in plan §0.

**Size guard:** 100 KB defensive ceiling. Realistic snapshots are ~10–30 KB; bloat past 100 KB is a bug, not a feature.

**Failure modes** (full table in `agents/impl-plan-drafts/03-integration.md` §1.5): malformed JSON / wrong shape → `400`; oversized → `413`; origin mismatch → `404`; KV outage → `503` on POST or `503` on GET-read; corrupt KV value → `502`; missing KV binding → `500`.

---

## UI Responsibilities

The frontend agent owns `src/app/screener/selector/` and `src/components/selector/`. The integration owns only the callout *integration site* (`src/app/screener/client.tsx`), the snapshot endpoint, and the OG images. Per the plan:

- Q1–Q6 wizard with per-step `history.pushState`; browser back walks the wizard backwards. Q1 is profile, Q2 is peg, Q3–Q6 are horizon, depeg tolerance, venue, and exit speed.
- Mobile branching is CSS-only except for the callout slim/full variant and the mobile single-form, both gated behind `useHydrated() && useIsMobile(640)`.
- Result page renders the ranked shortlist, lower-ranked rows, peg-aware summary/chips, evidence chips, the mandatory "What to watch" line per shortlist entry, and the divergence banner when the selector inputs cannot be expressed in Screener filters. Empty states distinguish "no fit" from "coverage too thin" when selected-peg live signals are sparse.
- `[Copy share link]` uses POST-then-copy: POST the engine output, copy `/screener/selector/?sid={sid}` on `200`, leave the button disabled with a notice on failure.
- `aria-live="polite"` announcements on step transitions; programmatic focus to the new `<legend>`.

The shortlist section places a "Compare the shortlisted stablecoins" callout directly under the heading. It links to `/compare/` with the selector answers and shortlisted coin IDs pre-filled. Each shortlist card carries three evidence chips plus header chips for the selected peg and "Filter output". Trading-profile staleness renders as a discrete label ("Fresh" / "1m" / "5m" / "Stale") on mobile, precise seconds on desktop.

---

## OG Images

Static checked-in 1200×630 PNG cards at:

- `public/og-selector-default.png`
- `public/og-selector-treasury.png`
- `public/og-selector-yield.png`
- `public/og-selector-trading.png`

**Current status:** checked-in profile cards are real 1200×630 marketing surfaces. They avoid coin names and keep the profile-level privacy property.

OG metadata wiring lives in `src/app/screener/selector/page.tsx` (frontend agent). Per-snapshot OG cards are intentionally NOT served; recipients of `?sid=...` URLs always see the profile-level OG. That is the privacy property.

---

## Update Rules

When changing Selector behavior, update this doc alongside:

1. **Snapshot endpoint contract** (POST/GET, failure modes, canonicalization rules) → `functions/selector-snapshot/[[path]].ts`, `functions/__tests__/selector-snapshot.test.ts`, `docs/api-reference.md` Pages Function endpoints section.
2. **localStorage keys or schema** → `src/components/selector/selector-callout.tsx` (frontend), `docs/privacy-page.md`.
3. **Banned-phrase policy** → `scripts/ci/check-selector-banned-phrases.mjs`. Wire any new banned phrase into `BANNED_PATTERNS`; document the replacement in `agents/screener-selector/03-editorial.md` §8.
4. **Weight, exclusion, or deterministic behavior changes** → bump `engineVersion` via `shared/lib/selector/version.ts`, update editorial worked examples, and rerun selector engine tests plus banned-phrase lint.
5. **OG content** → replace `public/og-selector-*.png` and re-verify the marketing copy is calibrated against the banned-phrase list before commit.
6. **Methodology page** → `/methodology/selector/` ships within 30 days post-MVP (design §9.1 item 7; project-tracker post-ship task).

The Selector engine is deterministic and client-only. It does not call the Worker. The only HTTP surface it adds is the snapshot store, which is Pages-only. Because the current Selector remediation also touches shared runtime selector code, the deploy classifier result for this change set is `pages=yes`, `worker=yes`.

---

## File Index

| File | Role |
|------|------|
| `src/app/screener/selector/page.tsx` | Static route shell (frontend agent) |
| `src/app/screener/selector/client.tsx` | Interactive wizard + result render (frontend agent) |
| `src/components/selector/*` | Wizard/result components (frontend agent) |
| `shared/lib/selector/engine.ts` | `runSelector(input, data) → SelectorOutput` (engine agent) |
| `shared/lib/selector/canonicalize.ts` | Snapshot canonicalization (engine + integration co-owned) |
| `functions/selector-snapshot/[[path]].ts` | POST + GET snapshot endpoint (integration) |
| `functions/__tests__/selector-snapshot.test.ts` | Snapshot endpoint tests (integration) |
| `scripts/ci/check-selector-banned-phrases.mjs` | Banned-phrase lint (integration) |
| `public/og-selector-*.png` | Static 1200×630 OG cards per profile (integration) |
| `agents/selector-design.md` | Source design — R2-converged |
| `agents/selector-implementation-plan.md` | Implementation plan — Step-4 revised; binding |
| `agents/screener-selector/03-editorial.md` | Editorial policy + worked examples (banned-phrase lint scans §4) |

---

## Editorial Owner

`tokenbrice` is the named owner of editorial template content, banned-phrase reconciliation, and the post-ship `/methodology/selector/` page (per plan §0).
