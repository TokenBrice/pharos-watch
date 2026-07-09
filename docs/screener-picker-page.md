# Screener Picker Page

Route contract for `/screener/picker/`, the noindex profile-driven stablecoin shortlist.

The Picker flips the Screener relationship: instead of filtering the full universe, the user describes a profile (Treasury, Yield, Active Trading) and Pharos returns up to 3 profile-fit candidates plus up to 2 profile mismatches/watch-outs, with live-data justifications. The Screener remains the durable surface; the Picker seeds it.

---

## Route Shape

- **Server shell:** `src/app/screener/picker/page.tsx` (frontend agent)
- **Client implementation:** `src/app/screener/picker/client.tsx` (frontend agent)
- **URL state codec:** `src/app/screener/picker/selector-state.ts` (frontend agent)
- **Scoring engine:** `shared/lib/selector/engine.ts`, `shared/lib/selector/scoring.ts`, `shared/lib/selector/ranking.ts`, `shared/lib/selector/recommendation.ts`, `shared/lib/selector/output-helpers.ts`, `shared/lib/selector/yield-source.ts`, and `shared/lib/selector/version.ts` (engine agent)
- **Snapshot canonicalization:** `shared/lib/selector/canonicalize.ts` (engine + integration co-owned)
- **Snapshot contract/schema:** `shared/lib/selector/snapshot.ts` (engine + integration co-owned)
- **Snapshot Pages Function:** `functions/selector-snapshot/[[path]].ts` (integration)
- **Wizard components:** `src/components/selector/*` (frontend agent)
- **Editorial templates:** `shared/lib/selector/what-to-watch-templates.ts`, `shared/lib/selector/why-keys.ts` (engine agent; banned-phrase lint applies)
- **Entry callout:** `src/components/selector/selector-callout.tsx`, rendered from `src/app/screener/client.tsx`

The route shell is intentionally `noindex,follow` via route metadata and uses canonical `/screener/picker/`. It is omitted from the sitemap; no `_headers` noindex rule owns this route.

---

## Peg Scope

Initial selectable pegs are `USD`, `EUR`, `CHF`, and `GOLD`. This pass is limited to pegs that have enough active rows and live Safety/Peg/DEWS/liquidity/yield coverage to avoid empty Picker routes.

Yield exposes the same peg set (`USD`, `EUR`, `CHF`, `GOLD`). Thin or strict combinations can use the engine's low-confidence fallback rather than returning an empty result, but the fallback is limited to the explicitly relaxable peg-score floor. Rows still need required profile signals, a usable Yield source, and must not violate other profile or input-driven exclusions before they can be recommended.

`SILVER`, `VAR`, and `OTHER` are intentionally excluded because their current live signal coverage still produces empty picker routes or needs separate reference-asset treatment. `BRL` is also held back until the `peggedREAL` alias path is audited across sync, price validation, and supplemental-asset creation.

The URL key is `peg`; missing or invalid values default to `USD` for backward compatibility. For `p=yield`, unsupported peg values also normalize to `USD`.

---

## Data Contract

The engine consumes the same React Query hooks the Screener already uses; no new data endpoints land for the Picker. The full list:

1. `useStablecoins()` — tracked universe, prices, supply.
2. `useReportCards()` — Safety Score, per-dimension scores, dependency-graph data.
3. `usePegSummary()` — current peg readings, depeg events.
4. `useStressSignals()` — DEWS scores.
5. `useDexLiquidity()` — Liquidity Score, HHI, multi-DEX presence.
6. `useYieldRankings()` — Pharos Yield Score, source-risk, variance.
7. `useBluechipRatings()` — third-party bluechip grades.
8. `useRedemptionBackstops()` — effective-exit score and redemption-rail data.

The route passes the selected `pegCurrency` into the data adapter. The adapter keeps active rows for that selected peg and computes `datasetHash` over the selected-peg universe with every decision-affecting field: exclusions, normalized scoring inputs, tie-break fields, explanation inputs, venue/source fields, lifecycle/status flags, `pegCurrency`, and source/methodology metadata that changes output semantics. Freshness-only fields such as `updatedAt`, `capturedAt`, and hook fetch timestamps stay out of `datasetHash` unless they affect ranking, exclusion, or staleness policy. Refetches that change decision content change `datasetHash` and trigger a fresh picker run. The hash must be stable and collision-resistant enough for audit references; it is SHA-256-based, computed via `sha256Hex(canonicalizeForDatasetHash(...))`.

Stablecoin-list and report-card data are critical selector inputs. When either critical query fails without retained data, both live generation and frozen-vs-today comparison return the typed `selector-data-unavailable` state with a retry path; they do not remain in loading or produce a shortlist from partial critical data. Optional source gaps remain engine-owned coverage signals.

The pure engine still filters by `input.pegCurrency`, so tests can pass an all-peg map safely. The engine reads `methodologyVersion` from each upstream `_meta` / `methodology.version` envelope when present and falls back to `"unversioned"` per endpoint otherwise; gaps surface in the output payload. `engineVersion` / `selectorVersion` must bump whenever ranking, exclusion, missing-data, tie-break, explanation, or deterministic output semantics change.

`SelectorOutput` is the replay contract, not just a UI view-model. In addition to `input`, `universe`, `recommended`, `lowerRanked`, `coverageWarnings`, `methodologyVersions`, `datasetHash`, and `engineVersion`, the current enhancement plan expects these fields or equivalent persisted semantics:

| Field                                        | Purpose                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recommended[].whyText`                      | Authored "why it ranked here" prose. Cards must not render raw `whyKey` values such as `top-*` / `strong-*`.                                                   |
| `lowerRanked[].verdictText` / `teachingText` | Authored watch-out/profile-mismatch prose. Rows must not render raw `reasonKey` or `weak-*` strings.                                                           |
| `lowConfidence`                              | Result-level quality flag shown prominently when normal confidence is not met.                                                                                 |
| `usedRelaxedFallback` / `relaxedReasons`     | Marks entries produced by relaxing constraints so users can distinguish clean fits from fallback fills.                                                        |
| `exclusionSummary`                           | Aggregated counts/reasons for hard exclusions and coverage-thin rows.                                                                                          |
| `closestSurvivors`                           | Engine-owned near-miss rows used by empty/thin states and the non-empty "Near misses / why not shown" disclosure; frontend placeholders are not authoritative. |
| `relaxableConstraints`                       | Engine-owned relax actions that correspond to actual blockers.                                                                                                 |
| `rankRobustness` / tie metadata              | Near-tie or concentration labels when score deltas are narrow or issuer/protocol concentration rules affect the shortlist.                                     |

---

## Persistence And Sharing

Browser-local state is intentionally split by lifetime. There is no long-lived local output history.

| Key / surface                      | Type                            | Lifecycle                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pharos.selector.callout.v1`       | `localStorage` JSON             | Callout dismissal state. Survives reloads; clears on site-data clear.                                                                                                                                                    |
| `pharos.selector.sessionResult.v1` | `sessionStorage` JSON           | Optional last-successful live result recovery. Clears when the tab/session closes; not written after explicit reset/clear.                                                                                               |
| `s:{sid}`                          | KV value (`SELECTOR_SNAPSHOTS`) | Content-addressed, client-unverified snapshot projection. Written with a 90-day unread TTL; the first read returns the snapshot only after extending it to the full 5-year retention TTL (KV metadata `extended: true`). |

Storage layer is best-effort; quota errors are silently dropped. Session recovery, when present, must be visibly labeled as a restored session result and must not create localStorage output history.

**Snapshot share URL:** `/screener/picker/?sid={32-hex}`. Legacy `/screener/selector/?sid={32-hex}` links are preserved through the Pages redirect table and must keep the query string intact. The sid is content-addressed — two runs that produce identical canonical output (modulo timestamp, debug, freshness suffixes, and fixed snapshot provenance fields) share the same sid. The frozen artifact contains the form answers and projected output; the sid is the lookup key. Every replay carries `provenance: "client-unverified"`, and the result banner must state that Pharos checked format and tracked identities but did not reproduce scores from canonical source data. The share UI must disclose before or during link creation that answers and shortlist output are stored for up to 5 years and that anyone with the link can view the snapshot. Snapshots that are never opened expire after 90 days; a read returns `503` if the full-retention extension cannot be confirmed.

**Snapshot-miss behavior:** when a sid-only share URL hits a KV miss, the client shows a not-found error instead of silently generating a different live result. If a legacy or hand-authored URL also carries complete wizard state, the client can fall back to live engine output for those inputs with a one-line "Original snapshot no longer cached" banner.

**Frozen-vs-today behavior:** a loaded `sid` renders the frozen artifact by default. When current data is ready, "Compare to today's data" runs the live engine for the frozen `output.input` and shows deltas for shortlist membership, rank, score, `datasetHash`, `engineVersion`, and methodology-version drift without overwriting the shared artifact.

Cross-link: `docs/privacy-page.md` describes the storage policy and the content-addressed snapshot model.

---

## Snapshot Pages Function

`functions/selector-snapshot/[[path]].ts` is the only HTTP surface that the Picker adds. It runs on Cloudflare Pages Functions and adds no Worker HTTP endpoint, but its `POST` write throttle binds D1 (`env.DB`) for a durable per-IP daily quota (`selector_snapshot_daily_quota`, migration 0163); the Worker's daily-0300 cron (`0 3 * * *`) prunes that table.

| Surface                       | Method | Behavior                                                                                                           |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `POST /selector-snapshot`     | `POST` | Stores an exact, client-unverified `SelectorOutput` projection under a server-recomputed `sid`. Returns `{ sid }`. |
| `GET /selector-snapshot/:sid` | `GET`  | Returns the stored `SelectorOutput` or `404`. `private, no-store` so every read re-enters the same-origin gate.    |

**Auth:** same-origin only (mirrors `rejectIfNotSiteDataUiOrigin` from `functions/lib/site-data-origin.ts`). Browser CORS blocks cross-origin POST before it reaches the function; no write secret is required. Foreign origins receive `404`.

**Tamper evidence and provenance:** the server recomputes the sid via SHA-256 over canonical JSON (lexicographically sorted keys, debug/freshness/provenance fields stripped, NFC-normalized strings). GET recomputes it and returns `502` on mismatch. This proves that KV returned the accepted bytes, not that Pharos produced the recommendation. The boundary always writes `provenance: "client-unverified"` and `snapshotSchemaVersion: 2`.

**Validation:** shared selector snapshot code owns the runtime-neutral replay contract. It projects exact allowlists at every level, discards unknown/debug/authored-prose fields, accepts only tracked stablecoin IDs, derives names and symbols from the registry, and rejects duplicate or contradictory identity relationships. For the current engine it rebuilds normalized components, weights, contributions, scores, ranks, rank margins, relaxed-fallback state, coverage counts/flags, low-confidence state, and safe diagnostic copy where the stored fields contain enough information. Supported historical engine versions are explicit; `datasetHash` must be a 64-character lowercase SHA-256 hex value and `methodologyVersions.exclusionFilters` must match `engineVersion`.

**Canonicalization:** the strip rule covers `timestamp`, `debug`, `perInputStaleness`, plus any field whose name matches the suffixes `ageSeconds`, `capturedAt`, `stalenessMs`, `updatedAt`, `fetchedAt`. `coverageWarnings.newListingCount` is **not** stripped; the implemented engine derives it from content-level recent-listing flags, so it contributes to the sid. Cross-client sid consistency depends on this denylist; engine and integration agreed on the same strip-list in plan §0. POST strips `debug` and free-form selector prose before storage even if a debug build sends them.

**Size guard:** 100 KB defensive ceiling enforced while streaming the request body. Reading stops and the stream is cancelled as soon as the budget is crossed; `Content-Length` is only an early rejection hint.

**Write abuse controls:** the origin gate is spoofable and zone WAF rate limits only cover `api.pharos.watch/api/*`, so `POST` carries two throttles: a per-isolate HMAC-IP sliding window (10 writes/minute) and a D1-backed daily quota (`selector_snapshot_daily_quota`) capped at 100 writes/UTC day. Both use a truncated HMAC-SHA-256 key derived with the dedicated `SELECTOR_SNAPSHOT_IP_HASH_SECRET`; neither raw IPs nor enumerable unsalted hashes are stored. Missing pepper or KV configuration returns `500`; unavailable D1 quota storage returns `503`.

**Failure modes:** malformed JSON / wrong shape → `400`; oversized → `413`; origin mismatch → `404`; KV outage or unconfirmed retention extension → `503`; corrupt KV value → `502`; missing KV or HMAC-pepper configuration → `500`.

**Validation matrix:**

| Case                                                                             | Expected result                                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Invalid `sid` syntax in URL or GET path                                          | Do not fetch from KV, show typed invalid-link/not-found state, return `404` at the function. |
| POST includes `debug`                                                            | Strip before canonical sid and storage.                                                      |
| POST has unknown enum, impossible score, malformed source, or unknown reason key | `400`.                                                                                       |
| GET stored payload fails semantic validation                                     | `502`.                                                                                       |
| GET stored payload canonical sid differs from requested `sid`                    | `502`.                                                                                       |
| KV binding absent                                                                | `500`.                                                                                       |
| KV read/write transient failure                                                  | `503`, typed client store-unavailable state.                                                 |
| Clipboard write denied after successful POST                                     | Show selectable share URL fallback and announce error through an alert/status region.        |

---

## UI Responsibilities

The frontend agent owns `src/app/screener/picker/` and `src/components/selector/`. The integration owns only the callout _integration site_ (`src/app/screener/client.tsx`), the snapshot endpoint, and the OG images. Per the plan:

- Q1–Q6 wizard with per-step `history.pushState`; browser back walks the wizard backwards. Q1 is profile, Q2 is peg, Q3–Q6 are horizon, depeg tolerance, rail/venue, and exit speed. Desktop single-select questions use a consistent select-then-Next rhythm; radio selection alone does not advance to result. Treasury Q5 labels are "Regulated custody", "Mixed rails", and "DeFi-native / on-chain"; regulated custody maps to `custodyOk="regulated-only"`, mixed rails leaves custody unconstrained, and DeFi-native maps to `custodyOk="onchain-only"` plus `decentralization="required"`.
- Mobile branching is CSS-only except for the callout slim/full variant and the mobile single-form, both gated behind `useHydrated() && useIsMobile(640)`.
- Mobile answer controls update answers only; the sticky "See my shortlist" CTA is the only mobile result commit and stays disabled until required answers are complete. The CTA area shows an answered-count/progress cue.
- Result page renders the ranked shortlist, lower-ranked/watch-out rows, peg-aware answer chips, priority chips, evidence chips, compact expandable score breakdowns, the mandatory "What to watch" line per shortlist entry, and readable Screener handoff filter chips.
- Non-empty result pages include a "Near misses / why not shown" disclosure backed by `closestSurvivors`, with readable blocker labels, live readings, and hypothetical scores.
- Treasury, Yield, and Active Trading depeg tolerance hard-gates active/current depegs plus the current `PegScore` floor. Treasury floors are `zero` 80, `tight` 70, `moderate` 60; Yield floors are `zero` 65, `tight` 55, `moderate` 45; Trading floors are `zero` 85, `tight` 80, `moderate` 70. Historical event count and peg-stability history can affect score, confidence, and watch text, but are not the hard depeg pass/fail criterion.
- Empty states use engine-owned `exclusionSummary`, `closestSurvivors`, and `relaxableConstraints` to distinguish strict constraints, sparse coverage, missing Yield rails, and no-clean-fit relaxed fallback.
- Result summary renders distinct banners for `lowConfidence`, sparse coverage, uneven coverage, `usedRelaxedFallback`, stale Trading share blockers, and methodology/version drift. Frozen snapshots also render an `Unverified client snapshot` banner explaining that the boundary checked format and tracked identities but did not reproduce scores from canonical source data.
- `[Copy share link]` uses POST-then-copy: POST the engine output, copy `/screener/picker/?sid={sid}` on `200`, leave the button disabled with a notice on failure. Active Trading share copy is blocked when relevant `perInputStaleness` exceeds the configured freshness ceiling; Treasury and Yield are not blocked by Trading-only staleness. Disabled/error reasons are associated with the button and announced through status/alert regions.
- Result actions include Adjust answers, Verify in Screener, Copy share link, a Telegram follow-command card for the shortlist (`/subscribe dews, depeg, safety <symbols>`), a Compare these action for the top shortlist shown when 2 or more entries are recommended (`/compare/?coins=<ids>`), an Inspect on Yield Intelligence action for Yield-profile outputs (`/yield/?from=selector&compare=<ids>` or a single-result `q=<symbol>` variant), and optional Compare shortlist vs watch-outs. Yield shortlist cards also link to the per-coin yield workbench (`/stablecoin/<id>/yield/`) when a recommended yield source exists. Portfolio handoff can join the rail once its URL/local-state model is reviewed.
- Loading states set `aria-busy` and include screen-reader loading text. Result generation/snapshot load moves focus to the result summary heading, full-card option labels expose `focus-within` styling, skipped-coin disclosures are explicit controls, and mobile shortlist jumps move focus like skip links.
- Mobile/narrow-width QA must cover long coin names, long hashes/version strings, multi-line relax buttons, and chip wrapping so text does not overlap at common mobile widths or 200 percent zoom.
- `aria-live="polite"` announcements on step transitions; programmatic focus to the new `<legend>`.

The shortlist section starts directly with the ranked cards. When lower-ranked rows exist, the result view can include one Compare shortlist vs watch-outs action outside the shortlist section. Each shortlist card carries three evidence chips plus header chips for the selected peg and "Filter output". Trading-profile staleness renders as a discrete label ("Fresh" / "1m" / "5m" / "Stale") on mobile, and a compact duration ("30s old" / "5m old" / "2h old") on desktop.

Visible copy guardrails: do not use fixed output counts ("3 candidates plus 2 coins") when counts are variable, do not use "Hold safely", do not call entries recommendations, and do not expose raw internal keys (`whyKey`, `reasonKey`, `top-*`, `strong-*`, `weak-*`, or `WeightKey` values) as user-facing prose.

---

## OG Images

Static checked-in 1200×630 PNG cards at:

- `public/og-selector-default.png`
- `public/og-selector-treasury.png`
- `public/og-selector-yield.png`
- `public/og-selector-trading.png`

**Current status:** checked-in profile cards are real 1200×630 marketing surfaces. They avoid coin names and keep the profile-level privacy property.

OG metadata wiring lives in `src/app/screener/picker/page.tsx` (frontend agent). Per-snapshot OG cards are intentionally NOT served; recipients of `?sid=...` URLs always see the profile-level OG. That is the privacy property.

---

## Update Rules

When changing Picker behavior, update this doc alongside:

1. **Snapshot endpoint contract** (POST/GET, failure modes, canonicalization rules) → `functions/selector-snapshot/[[path]].ts`, `functions/__tests__/selector-snapshot.test.ts`, `docs/api-reference.md` Pages Function endpoints section.
2. **localStorage keys or schema** → `src/components/selector/selector-callout.tsx` (frontend), `docs/privacy-page.md`.
3. **Banned-phrase policy** → `scripts/ci/check-selector-banned-phrases.mjs`. Wire any new banned phrase into `BANNED_PATTERNS`; document durable replacement guidance in this file or a focused `/docs/` page.
4. **Weight, exclusion, scoring, ranking, yield-source, or deterministic output behavior changes** → bump `engineVersion` via `shared/lib/selector/version.ts`, update editorial worked examples, and rerun selector engine tests plus banned-phrase lint. The current picker remediation is `selector-v1.91`.
5. **OG content** → replace `public/og-selector-*.png` and re-verify the marketing copy is calibrated against the banned-phrase list before commit.
6. **Methodology page** → `/methodology/selector/` ships within 30 days post-MVP (design §9.1 item 7; project-tracker post-ship task).

The Picker engine is deterministic and client-only. It does not call the Worker. The only HTTP surface it adds is the snapshot store, which is Pages-only. Picker UI and selector-engine changes are Pages-impacting; they do not require a Worker deploy unless Worker-imported shared contracts or Worker endpoints change.

---

## File Index

| File                                            | Role                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/app/screener/picker/page.tsx`              | Static route shell (frontend agent)                                                   |
| `src/app/screener/picker/client.tsx`            | Interactive wizard + result render (frontend agent)                                   |
| `src/components/selector/*`                     | Wizard/result components (frontend agent)                                             |
| `shared/lib/selector/engine.ts`                 | `runSelector(input, data) → SelectorOutput` (engine agent)                            |
| `shared/lib/selector/canonicalize.ts`           | Snapshot canonicalization (engine + integration co-owned)                             |
| `shared/lib/selector/snapshot.ts`               | Snapshot replay contract, validation, and sid helpers (engine + integration co-owned) |
| `functions/selector-snapshot/[[path]].ts`       | POST + GET snapshot endpoint (integration)                                            |
| `functions/__tests__/selector-snapshot.test.ts` | Snapshot endpoint tests (integration)                                                 |
| `scripts/ci/check-selector-banned-phrases.mjs`  | Banned-phrase lint (integration)                                                      |
| `public/og-selector-*.png`                      | Static 1200×630 OG cards per profile (integration)                                    |

---

## Editorial Owner

`tokenbrice` is the named owner of editorial template content, banned-phrase reconciliation, and the post-ship `/methodology/selector/` page (per plan §0).
