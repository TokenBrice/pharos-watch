# Methodology Page Contract

`/methodology` (`src/app/methodology/page.tsx`) is the canonical long-form explainer page for Pharos scoring systems. The route shell still owns metadata, breadcrumb/FAQ/Article structured data, and the reader-guide hero chrome, while `src/app/methodology/sections/index.tsx` composes the authored long-form section bodies from `src/app/methodology/sections/core/*.tsx` and `src/app/methodology/sections/monitoring/*.tsx`.

---

## Route & Structure

- **Route shell:** `src/app/methodology/page.tsx` (metadata, breadcrumb JSON-LD, Article JSON-LD, hero/reader-guide shell, and the visible `FaqSection` that emits the FAQ JSON-LD)
- **Shared helpers + section metadata:** `src/app/methodology/methodology-shared.tsx`
- **Section composition module:** `src/app/methodology/sections/index.tsx` (single ordered `MethodologySections` list)
- **Composite section body:** `src/app/methodology/sections/core-sections-pricing.tsx`
- **Shared section summary/markdown registry:** `src/lib/methodology-content.ts` (non-React section ids, titles, and markdown-export summaries)
- **Per-section body modules:** `src/app/methodology/sections/core/*.tsx` and `src/app/methodology/sections/monitoring/*.tsx`
- **Navigation model:** `METHODOLOGY_SECTIONS` + `LongformScrollspyNav`
- **Mode switching:** `MethodologyModeToggle`; mobile renders the toggle inside the hero guide card, `md+` renders it in the jump rail. It and the inline `ShowYourWorkToggle` adopt the `pharos-toggle-pill` control language (design-canon grammar alignment, 2026-07-01); `ShowYourWorkToggle` is shared, so the pill classes are passed additively from `page.tsx` and its other consumers are unchanged.
- **Design carve-out:** `/methodology/` stays a longform reference page — no signature hero and no frost "One Beam". This is an explicit exception to [Feature-page heroes](./design-language.md#feature-page-heroes); the 76rem measure and `MethodologySectionShell` layout are unchanged. Only the control + numeric *grammar* is aligned to canon: the toggles use the pill language and figures/version badges use `.pharos-numeric` (semantic badge colors preserved).
- **Mode persistence contract:** `MethodologyModeToggle` stores `pharos.methodology.mode` in `localStorage` and opens/closes authored `details` blocks via the `data-methodology-details` / `data-methodology-worked-example` attributes emitted by `MethodologyDetails` and `WorkedExample`
- **Orientation content:** mobile compresses the reading guide into the hero card; `md+` keeps both the top-right reader-guide hero card and the dedicated "How to Read This Page" overview card
- **Reusable long-form primitives:** `MethodologyDetails`, `MethodologyFacts`, `WorkedExample`, and `MethodologySectionShell`
- **Version metadata:** `shared/lib/methodology-versions/constants.ts` is the shared runtime version/path surface; domain modules under the same directory own structured changelog collections and registry metadata.
- **Public changelog routes:** pricing pipeline, stability index, scoring, liquidity score, redemption backstop, mint/burn flow, yield, depeg, depeg resolver, blacklist tracker, and chain health are all served by the dynamic route `src/app/methodology/[slug]/page.tsx`, whose slugs derive from every `METHODOLOGY_CHANGELOG_REGISTRY` entry's `publicPath`. Retired Mint Authority is the one structured lane without a standalone route; its history remains at `/methodology/#mint-authority-score`.
- **Changelog wrappers:** `src/app/methodology/[slug]/page.tsx` holds each lane's display config; the shared shell is `src/components/methodology-changelog-page.tsx`, which renders an overview block linking back to the current methodology and public docs archive before the version cards
- **Changelog sitemap policy:** `METHODOLOGY_CHANGELOG_SITEMAP_PATHS` (`shared/lib/methodology-versions/registry.ts`) is derived from every `METHODOLOGY_CHANGELOG_REGISTRY` entry's `publicPath`, and `src/app/sitemap.ts` re-exports and spreads it, so registering a changelog lane automatically promotes its route. Register a lane only when its route has enough standalone context for external readers, normally through the shared overview block plus a useful latest-version summary.
- **Scoring changelog special case:** the `scoring-changelog` slug renders custom authored content sections: `src/app/methodology/changelog-content/scoring/content.tsx` renders the machine-readable changelog order with authored detail maps from `content-v8.tsx`, the `content-v7-*.tsx` modules, `content-v6.tsx`, `content-v5.tsx`, `content-legacy.tsx`, and `content-summary.tsx` in the same directory (with `content-v6.tsx` merging `content-v6-9.tsx` and `content-v6-91-to-v6-99.tsx`)
- **Cross-app methodology links:** `src/lib/methodology-context.ts` hard-codes methodology anchors and imports shared version/changelog constants from `shared/lib/methodology-versions/constants.ts`; `src/components/methodology-hint.tsx` renders those resolved links for cards/tooltips across the app

---

## Section → Source Mapping

| Methodology Section   | Primary Runtime Source(s)                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pricing Pipeline      | `worker/src/lib/price-consensus.ts`, `worker/src/cron/sync-stablecoins/enrich-prices.ts`, `worker/src/lib/authoritative-price-sources/`, `worker/src/lib/price-validation.ts`, `shared/lib/methodology-versions/pricing-pipeline.ts`                              |
| Stability Index       | `worker/src/lib/stability-index.ts`, `shared/lib/methodology-versions/stability-index.ts`                                                                                                                                                         |
| Safety Scores         | `shared/lib/safety-score-v9/`, `shared/lib/safety-score-v9/policy.ts`, `worker/src/cron/compute-safety-score-v9.ts`, `shared/lib/methodology-versions/safety-score.ts`                                                   |
| Mint Authority / V9 mint component | `shared/lib/safety-score-v9/control.ts`, `shared/lib/safety-score-v9/mint-posture.ts`, `src/lib/mint-authority-display.ts`, `shared/lib/methodology-versions/mint-authority.ts`, `shared/data/stablecoins/domains/mint-authority/*.json` |
| Liquidity Score       | `worker/src/cron/dex-liquidity/orchestrator.ts`, `worker/src/cron/dex-liquidity/pool-helpers.ts`, `worker/src/cron/dex-discovery/orchestrator.ts`, `shared/lib/liquidity-score-weights.ts`, `shared/lib/methodology-versions/liquidity-score.ts` |
| Redemption Backstop Route Score | `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/exit-route-scoring.ts`, `shared/lib/redemption-backstop-configs/`, `worker/src/lib/redemption-backstop-sources.ts`, `shared/lib/methodology-versions/redemption-backstop.ts` |
| Infrastructure Tagging | `shared/types/core.ts`, `shared/lib/filter-tags.ts`, `src/lib/stablecoin-taxonomy.ts`, `shared/data/stablecoins/coins/*.json`                                                                                                             |
| Mint/Burn Flow        | `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`, `shared/lib/methodology-versions/mint-burn-flow.ts`                                                                                                                     |
| Yield Intelligence    | `worker/src/cron/sync-yield-data.ts`, helper modules under `worker/src/cron/yield-sync/`, `shared/lib/yield-scoring.ts` (PYS formula), `shared/lib/methodology-versions/yield-methodology.ts` |
| PegScore + DEWS       | `shared/lib/peg-score.ts`, `worker/src/lib/dews.ts`, `shared/lib/methodology-versions/depeg-dews.ts`                                                                                                                                              |
| Depeg Duration Resolver | `shared/lib/depeg-resolver/` (DDR/DDRR resolver), `shared/lib/methodology-versions/depeg-resolver.ts`                                                                                                                                          |
| Blacklist Tracker     | `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/blacklist-contracts.ts`, `shared/lib/methodology-versions/blacklist-tracker.ts`                                                                                                              |
| Chain Health Score    | `shared/lib/chains/health.ts`, `shared/lib/chains/index.ts`, `shared/lib/chains/l2beat-risk.ts`, `shared/lib/methodology-versions/chain-health.ts` — formula, factors, not-rated gate, and bands are owned by [chain-health.md](./chain-health.md) |

---

## Update Rules

When changing any methodology surface, update the runtime implementation, the detailed `/docs` explainer, and the authored `/methodology` section copy in the same change:

1. Runtime implementation (source file above).
2. Detailed methodology doc (`docs/*.md` for that system).
3. `/methodology` page copy and worked examples in the relevant section body module under `src/app/methodology/sections/core/` or `src/app/methodology/sections/monitoring/`. If the markdown export summary should also change, update the matching entry in `src/lib/methodology-content.ts`. Use `src/app/methodology/sections/index.tsx` only when changing section composition or order.

If a versioned methodology changes, add the entry under `shared/data/methodology-changelogs/`, update the corresponding domain module under `shared/lib/methodology-versions/`, and bump the shared constant when applicable so badges and changelog links stay consistent.

Commit provenance in structured changelog entries uses real commit hashes only. Use `commits: []` when provenance was not recorded; public changelog routes should omit `Commit(s)` output for those entries rather than using `unreleased` as a placeholder.

Also update `src/app/methodology/page.tsx` whenever its FAQ structured-data answers, metadata copy, or reader-guide copy changes. Those claims are runtime-facing even when the shell layout itself is unchanged.

If section IDs or changelog paths change, also update `src/lib/methodology-context.ts` so in-app "View methodology" and "Version history" links keep resolving to the correct anchor/route.

If you add a new methodology changelog route, follow the existing pattern:

1. Add the structured entries under `shared/data/methodology-changelogs/` and register them through `shared/lib/methodology-versions/registry.ts`.
2. Add or update the domain version source and `shared/lib/methodology-versions/constants.ts`.
3. Add the public route in `src/app/methodology/*-changelog/page.tsx` using `createStandardMethodologyChangelogRoute(...)` (the standard factory used by every non-scoring route); `createMethodologyChangelogRoute(...)` is reserved for the `scoring-changelog` special case with custom authored content.
4. Wire the new anchor/path into `src/lib/methodology-context.ts` if any cards/tooltips deep-link to it.

If the Chain Health methodology changes, follow the single update contract in [chain-health.md](./chain-health.md#update-contract).

If the current V9 mint component or the retired Mint Authority Score history changes, also update:

1. `docs/mint-authority-scoring.md`
2. `docs/stablecoin-data.md`
3. `docs/stablecoin-detail-page.md`
4. `docs/homepage.md`, `docs/coverage-page.md`, and screener-facing docs when cross-coin display/filter/export semantics change

If the pricing pipeline's source roster or live-price selection semantics change, also update:

1. `docs/pricing-pipeline.md`
2. `shared/data/methodology-changelogs/pricing-pipeline/`
3. `docs/data-pipeline.md`
4. `docs/about-page.md` plus `src/app/about/page.tsx`

For the safety-score changelog specifically, update both:

1. `shared/data/methodology-changelogs/safety-score/`, `shared/lib/methodology-versions/current-version.json`, and `shared/lib/methodology-versions/safety-score.ts` for the machine-readable changelog and current version.
2. `src/app/methodology/changelog-content/scoring/content.tsx` plus the split `content-v8.tsx`, `content-v7-*.tsx`, `content-v6.tsx`, `content-v5.tsx`, `content-legacy.tsx`, and `content-summary.tsx` modules for the authored long-form detail maps and reference tables (with `content-v6.tsx` merging `content-v6-9.tsx` and `content-v6-91-to-v6-99.tsx`).

---

## Methodology-Context Anchors

`src/lib/methodology-context.ts` deep-links from in-app tooltips and metric cards into the methodology page. The full long-form sections live under the `METHODOLOGY_SECTIONS` ids in `src/app/methodology/methodology-shared.tsx`. In addition, three single-topic sub-anchors are exposed so per-metric labels (added in the May 2026 detail-page work) can target them without re-rendering a full top-level section:

Score badges across the site (Safety Score, DEWS, LiquidityScore, Redemption Backstop, Chain Health, and the V9 mint component) are wrapped in `<ScoreBadgeWrapper>` (`src/components/score-badge-wrapper.tsx`), which appends the inline `vX.Y` methodology version as a small superscript and routes the badge through the unified `MethodologyHint` tooltip. Table-context badges use `variant="tooltip-only"` so rows stay clean and the column-header `<MethodologyHint>` carries the version chip. The mint component keeps a terminal `v1.3` version badge and closing note for context — its section passes no `changelogPath`, so there is no "Version history" link, and in-app mint tooltips carry the Safety Score version and scoring-changelog path instead; it is not a live standalone scoring lane.

### Blacklist tracker {#blacklist-tracker}

Per-coin record of issuer-led freeze, release, and destroy events drawn from on-chain freeze-ledger logs. `BLACKLIST_STABLECOINS` in `shared/types/market.ts` owns the response/UI/archive identity union. Live on-chain scan admission is a separate reviewed contract roster, `CONTRACT_CONFIGS` in `worker/src/lib/blacklist-contracts.ts`; do not infer that every UI identity is actively scanned or that an omitted identity lacks an administrative freeze surface. The source registries and their coverage tests own the volatile roster rather than this page.

The detail page renders the existing per-coin blacklist module unchanged. `RecentBlacklistBanner` (`src/components/stablecoin-detail/recent-blacklist-banner.tsx`) implements a "Recent activity" badge (linking to the `#blacklist` anchor) for when one of two thresholds is hit over a trailing 7-day window, but it currently has no production render site — the hero tertiary-metrics wiring that mounted it was dropped in a later presentation refactor — so the badge does not appear on the detail page today. Its thresholds are:

- `freezes >= 5` (when `destroys === 0`), or
- any `destroys > 0`.

The banner is feature-flagged (`NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER`, see [process/feature-flags.md](process/feature-flags.md)) and suppressed when the coin is already in `frozen` status so it does not double up with the existing frozen badge. Runtime source: `worker/src/cron/sync-blacklist.ts`, `worker/src/lib/blacklist-contracts.ts`, plus `shared/lib/methodology-versions/blacklist-tracker.ts` for the versioned methodology snapshot.

### Bluechip rating {#bluechip}

Bluechip has two surfaces: the external Bluechip rating sync documented in [bluechip-ratings.md](bluechip-ratings.md), and the Pharos `/about/bluechip` editorial roster. The active roster's rule admits mapped assets whose synced external Bluechip grade is A-tier and whose Pharos report-card overall grade is A-tier (`A-`, `A`, or `A+`). It is an intersection of two current feeds, not a separate hidden floor model over safety/liquidity/resilience. The rule is stated in the page copy (`src/app/about/bluechip/content.tsx`), but `BluechipActiveList` (`src/app/about/bluechip/active-list.tsx`) currently short-circuits to a "temporarily unavailable while the V9 grade floor is under review" placeholder, so no assets are listed while that hold stands.

### Proof of Reserves

`StablecoinMeta.proofOfReserves` (in `shared/types/core.ts`) was extended in May 2026 with an `attestorTier` field — one of `big4` / `regional` / `niche` / `self` / `none` / `undisclosed` — paired with a `cadence` field of `daily-nav` / `real-time` / `daily` / `weekly` / `monthly` / `semi-monthly` / `quarterly` / `semi-annual` / `annual` / `ad-hoc` / `none` / `undisclosed`. The combination determines the badge color and label rendered by `POR_TIER_STYLES` in `shared/lib/classification/badges.ts`:

- `big4` — emerald. Independent attestation from a Big-4 firm (Deloitte, EY, KPMG, PwC).
- `regional` — blue. Licensed regional CPA or auditor with a recognized practice.
- `niche` — muted/neutral. Small or single-jurisdiction attestor without a wide reputation.
- `self` — amber. Issuer-published self-attestation, no third-party signoff.
- `none` — red. A reviewer established that no reserve attestation exists: the issuer's materials were enumerated and hold none, or a claimed attestor was checked and refuted.
- `undisclosed` — muted, dashed border. The issuer names no attestor, or a named artefact could not be retrieved. This is absence of evidence, not evidence of absence, and it never renders as an assertion.

`none` and `undisclosed` are not interchangeable, and the distinction is the reviewer's: refuting an attestor is a finding, failing to reach one is a gap. Where an asset has no attestor concept at all — reserves verifiable directly on-chain through a bridge or factory contract — the field is omitted rather than forced onto either value, and the badge falls back to the `proofOfReserves.type` label.

The cadence field is rendered alongside the tier badge as supporting text (e.g. "Big-4 attestor · monthly").

## StablecoinMeta surfacing fields (May 2026)

`StablecoinMeta` carries three optional editorial fields used by the detail-page hero and mechanism diagram. None of these change scoring — they only affect how a coin is presented:

- `oneLiner?: string` — short editorial verdict rendered as the hero TL;DR when `NEXT_PUBLIC_PHAROS_HERO_VERDICT` is on (see [process/feature-flags.md](process/feature-flags.md)).
- `mechanismArchetype?: MechanismArchetype` — coarse classification (e.g. `fiat-cash`, `cdp`, `synthetic-delta-neutral`, etc.) used by the mechanism diagram primitives. The full enum (`MECHANISM_ARCHETYPE_VALUES`) lives in `shared/types/stablecoin-taxonomy.ts` and is re-exported from `shared/types/core.ts`.
- `proofOfReserves.attestorTier?` and `proofOfReserves.cadence?` — see the [Proof of Reserves](#proof-of-reserves) sub-section above.

## Show Your Work

Score-card containers (Report Card, DEWS, Liquidity, PSI, Redemption Backstop, Chain Health) expose a `<ShowYourWorkPanel>` reading the visible inputs already on the payload (`rawInputs`, `signals`, `scoreComponents`, `components`+`contributors`, sub-scores, `healthFactors`). V9 Safety Score cards use their native report-v5 breakdown rather than the V8 `rawInputs` contract: Backing rows show effective weights and contributions, Exit shows the selected route's six weighted components plus route modifiers/caps and alternatives, and Economic Control shows component scores with binding or diagnostic status but no invented weights. Stable technical keys remain visible in this audit view, and pillar adjustments reconcile evaluator and published scores. Toggle via `?show-work=1` URL flag or the inline "Show inputs" link; once a user hides or shows the panel, that explicit `localStorage` preference under `pharos.show-work` wins over the URL flag until changed again. PegScore SYW is deferred to v2 — its decomposition is not yet on the worker payload.

## Verification Shortcuts

- **Pricing pipeline source weights / consensus threshold:** `worker/src/cron/sync-stablecoins/enrich-prices.ts`, `worker/src/lib/price-consensus.ts`
- **Safety Score V9 pillar weights / peg multiplier / score-bearing gates:** `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` plus `shared/lib/safety-score-v9/score-bearing-gates-policy.ts`, loaded and jointly digested by `shared/lib/safety-score-v9/policy.ts` and evaluated under `shared/lib/safety-score-v9/`
- **Mint component weights / caps / posture bands:** `shared/lib/safety-score-v9/control.ts`, `shared/lib/safety-score-v9/mint-posture.ts`
- **PSI caps, formula, and bands:** `worker/src/lib/stability-index.ts`
- **Liquidity component weights:** `shared/lib/liquidity-score-weights.ts`, `worker/src/cron/dex-liquidity/pool-helpers.ts`
- **Pressure Shift / gauge bands / flight-to-quality:** `worker/src/lib/mint-burn-scoring.ts`, `shared/lib/mint-burn-signals.ts`
- **DEWS weights / signal thresholds / bands:** `shared/lib/dews-config.ts`, `worker/src/lib/dews.ts`
- **Peg score blend / penalties / min history:** `shared/lib/peg-score.ts`
