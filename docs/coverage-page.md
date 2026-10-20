# Coverage Page Contract

Public `/coverage/` explains per-active-asset feature availability and count/market-cap reach, not admin cron health. `src/app/coverage/` owns the static shell/client/error boundary. `src/hooks/use-coverage-page-model.ts` composes `src/lib/coverage-matrix-model.ts`; resolvers under `src/lib/coverage/` own status labels and meanings, exported by `src/lib/coverage.ts`. Do not duplicate their inventories.

## Source Of Truth Per Column

The base is `CLIENT_ACTIVE_STABLECOINS`. Static classification is joined to canonical-ID live datasets, not guessed from metadata presence:

- Peg summary owns observed pricing/depeg coverage; NAV assets intentionally have price-only semantics. Headline corroboration requires source depth, not merely a row.
- Report-card publication owns overall rating, live-reserve use, dependency graph/coverage and mint score components. Static mint summaries independently own curation breadth.
- DEX, redemption, yield and mint/burn resolvers use their respective published snapshots. Yield means current ranking inclusion, not theoretical eligibility. Mature flow windows may be proved by completed scan span even when event retention empties.
- Reviewed freeze status owns exposure; event-tracker membership only upgrades directly freezable assets to Live. All reviewed exposure states count as assessed, including No, not just direct controls.
- Generated compliance sidecar projection owns MiCA/GENIUS assessments. Reviewed Unknown/out-of-scope/noncompliant states count as assessed; absent metadata is Not Assessed and implies no legal verdict.
- Supply weights come from `/api/stablecoins` with `getCirculatingRawOrNull()`. Missing assets/buckets are unavailable, never a valid zero. Labels derive from shared classification.

### Dependency Map Coverage

Compact `hasAuthoredDependencyEvidence` records variant parent, authored dependencies or reserve `coinId` evidence without shipping full evidence. Published graph roles take precedence, filtering edges to live report-card IDs. Without an edge, authored evidence or published dependency-coverage rows means Gap; missing per-coin report-card row is also a gap. Published reasons remain visible.

No deps (`resolved-none`) requires a report-card row, no graph role, no authored evidence and no coverage rows. It means no tracked dependency identified by those inputs, not absence of external dependencies. Whole-publication failure is Data n/a, never static-graph fallback or No deps.

### Reserve And Mint Distinctions

Reserve Score-grade means accepted live reserves actually entered report-card collateral scoring. Configured, Checking, Curated-Validated, Proof, Curated and Estimated describe different reader/detail states, not headline score coverage. Missing publication makes the reserve dimension Data n/a even with curated fallback. Only non-suspended configs project reader bindings; disabled sources fall back to curated/estimated/None, never Proof/Configured solely because a reader remains in an audit catalog. `shared/lib/live-reserve-display.ts` owns detail badge presentation.

Mint headline measures curated review breadth. Published posture bands are a separate detail dimension, never headline/risk/default-sort buckets. Unknown means no compact review, not an adverse score. Missing report-card dataset preserves curation but makes score Data n/a rather than NR. Missing individual score after a loaded publication is NR; stablecoin detail still shows its explicit unreviewed/NR section.

## Feature Snapshot

Count and market-cap denominators name the full active or feature-eligible population, not paginated rows. Headline and breakdown intentionally differ:

- Reserve headline counts score-grade live inputs, not every detail reserve view.
- Redemption headline counts strong modeled coverage; heuristic, resolved-unscored, configured-unrated and impaired rows remain in breakdowns without being counted as strong.
- Price headline requires at least three observed consensus sources; a matrix Tracked row may have fewer.
- Freezable coverage includes every reviewed exposure state across the active universe, not just live event tracking.

Source-depth tiles/filters share observed `sourceCount` with row detail. Market-source/authoritative-override categories remain distinct. Override-only data does not create a market-source card. Input-coverage explanations name the actual missing-data owner (issuer reporting cadence, for example), not a generic Pharos delay; a held publication replaces counts with hold context.

Score-input coverage calls the complete mixed-status cohort assets assessed, not assets scored. Its expanded breakdown separately reconciles rated (including partial), not-rated and pipeline-gap counts; held-publication context still takes precedence.

### Unavailable versus uncovered

Data n/a is neither covered nor uncovered: exclude it from feature count/cap denominators and ordinary gap filters, except intentionally inclusive No Dependency (Gap or Data n/a, not no upstream dependencies). All-unavailable features have null reach and cannot win insight tiles.

Safety membership comes from each published card's `ratingStatus`, not score presence: a rated zero remains Rated and genuine not-rated remains NR in the known population. Per-card pipeline gaps retain published machine reasons and use Data n/a, as do absent cards/publications; they have their own unavailable breakdown and leave known count/cap reach and the No Safety gap filter. Stacked bars retain those unavailable rows as visible segments without treating them as known coverage.

Omitted source arrays/counts mean unknown; explicit empty arrays measure zero. Cap aggregation carries observation count/completeness. Partial subtotals/ratios say known market cap; no observations is n/a; measured zero stays $0 while zero-denominator ratios remain n/a. Cap skew requires measured count and cap shares; no valid candidate means n/a. An observed uncovered denominator cannot manufacture a zero covered numerator when no covered row has observed cap.

Shared mobile/table coin identities use market-cap availability, not positivity: an observed zero displays $0, while an unavailable placeholder displays Mcap -.

## UX Contract

Search/filter/sort/page use URL state; defaults are omitted and lens changes reset page one. Default sorting is descending live cap. The strict Reserves lens matches score-grade live only, not proof/curated validation. Shared paginated table/cards must show the same eligible set and full filtered count; cards expose remaining statuses through accessible expansion. The active lens and cap share describe that set, not visible page rows.

Shared freshness notices cover every contributing live family without discarding structural coverage when optional queries fail. Retained liquidity distinguishes producer-refresh failure from source/quality warnings; older snapshot notices take precedence. Advisory detail may explain reasons without dumping machine flags into banner text. Stablecoins-source unavailability shows the error card and withholds the matrix rather than inventing cap weights.

## Structured Data Contract

The static indexable shell uses `createClientFeaturePage()`. Dataset JSON-LD is conservative/methodological: organization creator/publisher, license, `urn:pharos:dataset:coverage`, public page/API links and coverage fields. No live metrics, DataDownload, dateModified or private `/_site-data/*` URLs. Client `FaqSection includeJsonLd` owns FAQ schema.

## Update Rules

Change resolver, export and this contract together when status meaning, provenance, headline/denominator or feature coverage changes. Canonical source modules own label rosters and column order; do not copy them here. Route changes also update sitemap/metadata and owning architecture references.
