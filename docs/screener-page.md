# Screener And Picker

`/screener/` is the public, indexable inspection/export surface for tracked stablecoins. `/screener/picker/` is the deterministic guided shortlist; its route metadata is `noindex,follow`, canonical to itself and omitted from the sitemap. Noindex is not delegated to `public/_headers`.

## Route Shape

`src/app/screener/page.tsx` owns the static shell and metadata; `client.tsx` joins live data. `createClientFeaturePage()` preserves the shell shape while loading. `src/lib/screener-filters.ts` owns row/filter semantics and `src/lib/url-state.ts` the codec. Picker orchestration lives in `src/app/screener/picker/`, wizard state in `src/lib/selector-state.ts`, and runtime-neutral engine/adapter logic in `shared/lib/selector/`.

The Picker callout reserves a responsive placeholder until hydration, then mounts directly in the viewport-appropriate layout with its stored dismissal preference.

## Universe And Data Sources

Screener starts from `CLIENT_TRACKED_STABLECOINS`: active, pre-launch and frozen assets, excluding quarantined/delisted records regardless of URL state. Policy-withheld records remain accessible through static detail pages. Canonical IDs join stablecoin supply, peg summary, report cards, stress signals and the compact DEX table projection (`useDexLiquidityTable`, score only); curated client metadata owns classification, custody and identity. There is no Screener-specific API.

Supply uses `getCirculatingRawOrNull()`. Missing assets or absent/empty/invalid peg buckets yield `null`, not zero. Active supply ranges never match `null`; an explicit zero passes a max-only filter. `supplyMax=0` means no maximum, so the palette drops non-positive `supply<=` ceilings. Null cells show `—`, CSV cells are empty, and missing supply-sparkline endpoints remain gaps; explicit zero remains numeric zero.

## URL Contract

`SCREENER_URL_SCHEMA` is the sole key/validation authority. Its families cover exact identity, stress/size, safety, classification/custody, lifecycle/control and mint authority. Enum lists are comma-delimited; minimum floors are inclusive. Writers omit defaults and clear only owned keys, preserving unrelated query parameters.

`coins` accepts up to eight recognized tracked IDs and takes precedence over broad projection filters: a relaxed Picker recommendation cannot disappear on arrival. Legacy `mechanism=<slug>` normalizes once after hydration to `mechanisms=<slug>`; without lifecycle state it pins `lifecycle=active`. Invalid/deprecated aliases are removed; canonical writers never emit them.

Palette `screen` commands encode only admitted schema fields, and the preview counts those encoded constraints. Repeated minima take the largest floor; repeated maxima take the smallest ceiling; enum-list values accumulate without duplicates. Contradictory bounds or an unrepresentable scalar produce non-runnable feedback rather than an unfiltered destination. Existing strict-operator aliases remain inclusive, and non-positive supply ceilings remain omitted.

## Loading, Error, And Freshness

Rows wait for the stablecoin list. Toolbar and pagination counts require available primary data, including retained data after refresh failure; pending and unavailable reads show explicit state copy instead of zero counts, and disable export. Successful empty filtered results still disclose zero. `buildQueryFreshnessGroup()` combines all five live sources for shared notices/retry; retained data may remain visible with stale/error metadata. The route invents no local freshness windows.

Freshness notices follow [ADR-42](./architecture.md#adr-42): the shared notice renders only for stale lanes or reads missing with nothing retained. Notices appear with the data table below the toolbar so settling reads do not displace filters. Toolbar count lines and the export trigger reserve their loading-to-ready geometry; actions occupy a separate row below desktop widths so longer ready-state count copy cannot displace them.

Active predicates require their own source publication: DEWS ranges use stress signals; safety/pillar/evidence and mint score/band filters use admitted report cards; PegScore and liquidity floors use their respective feeds. Pending required reads without retained data keep counts loading and export disabled; failed or inadmissible required publications make evaluation unavailable, not zero matches or issuer NR. A valid empty publication is available, and retained publications remain usable with shared error/freshness notices. Individual null/unrated row predicates are unchanged. Unrelated optional failures and curated-only filters do not gate results; exact `coins=` inspection bypasses broad predicates and their source gates.

## Sorting And Export

Default sorting is descending Safety Score; shared comparator/`useSort()` owns unrated handling, direction and `aria-sort`. The table presents published Backing / Exit / Economic Control, weakest pillar, evidence, pipeline gaps and cap context without rescoring.

Peg Range is `[worst tracked deviation, current deviation]` from peg summary, not a 30-day history or a per-coin history fetch; labels/tooltips must agree. The separate 30d Supply sparkline compares monthly/current endpoints.

Only the active responsive layout mounts. Available results render in 50-row pages with an explicit “Showing N–M of total” range; pagination bounds presentation only. Filtering and sorting run over the full matched set before paging, and the toolbar count and export remain independent of the displayed page. Desktop row-cursor shortcuts operate on the current page and yield to interactive controls, including pager and sort buttons.

`TableExportMenu` exports the complete filtered, sorted set, never just the displayed page. Preserve identity/classification, supply, score, pillar/evidence/cap, rating/partial-cause, custody/control and mint fields. Mint is the published Safety Score component through V9-named consumers, not a separate authority. CSV headers `mint_authority`, `mint_authority_score`, `mint_authority_score_band` differ intentionally from title-case directory exports; URL band keys remain stable. Stamp Safety Score provenance, including the mint component.

`safety_gap_causes` retains stable cause labels across CSV, NDJSON and Markdown: `pipeline unavailable (A)` and `public data awaiting curation (B)`, joined with `; ` for multiple causes. Reader-facing partial-evidence sentences may change independently; they do not replace these exported values.

Exports join mixed producer generations, not one atomic snapshot. All five live feeds contribute columns, so each source's `meta.updatedAt` is exported in `sourceGenerations`; absent producer clocks remain null (human-readable `unknown`). Scalar `asOfISO` uses the oldest producer generation only when every participating clock is known; otherwise it is `unknown`. Browser receipt and download times never replace producer evidence. [Table exports](./exports.md#export-contract) owns this conservative mixed-source convention.

## Picker Handoff

`src/lib/selector-handoff.ts` owns the URL and human-readable chips. Emit only `SCREENER_URL_SCHEMA` keys, published Backing/Exit terminology and recommendation IDs in `coins=`. Unsupported gates remain explicit divergence chips: yield/source warnings, Bluechip, inherited blacklist exposure, active depegs, legal uncertainty and one-hour effective TVL. Picker is the guided flow; Screener is exact inspection, sorting and export.

Telegram subscribe commands use deduplicated canonical IDs, not tickers; identically named assets stay distinct targets.

## Input And Engine Contract

The wizard's profile, peg, horizon, depeg tolerance, venue/custody and exit vocabularies come from `shared/lib/selector/types.ts`; `selector-state.ts` owns only route state, actions, steps and URL encoding. Profile/peg policies live with the engine; UI option labels and ordering remain authored separately. Stablecoin-list and report-card reads are critical: failure without retained data produces typed `selector-data-unavailable` with Adjust answers/Start over recovery. Optional gaps become coverage signals.

Question steps are independent of evaluation feeds. The client enables the canonical source queries at the result/evaluation stage; URL-initialized results and `sid` snapshots enable them immediately when URL state is admitted. Cached data does not run the ranking engine while the reader is still answering questions. Pending evaluation stays loading, never an empty shortlist.

The browser memoizes the merged universe and dataset hash separately from ranking: answer-only changes reuse them, while a different peg or participating source generation rebuilds them. This does not change deterministic adapter/engine output or snapshot identity.

Ranking reweights published domain outputs plus one Safety Score composite. Pillars and dependency evidence already inside that composite must not be weighted again; they may drive exclusion floors, explanations and watch context. A profile spends its peg budget on one PegScore slot. Watch text says Safety Score without hardcoding a major; the publication footer owns version identity and historical snapshot prose stays frozen.

Current engine invariants (arithmetic/threshold ownership stays in `shared/lib/selector/`):

- Every profile requires report-card provenance, a non-null overall and non-NR grade. NR is `coverage-too-thin` with the public reason and never enters relaxed fallback. Limited evidence lowers confidence; caps/weakest pillar are explanation context, not extra weights.
- Supply unavailable is `supply-unavailable`, distinct from an observed zero below the floor. Unavailable supply sorts last and never becomes a stand-in headline.
- Custody gates use reviewed `custodyModel`, with backing/governance inference only when no review exists. Exit floors and `strong-exit` use the published Exit pillar directly.
- Required decentralization rejects centralized governance and direct/inherited freeze control. Missing or merely possible reviewed control evidence is `insufficient-control-evidence`, counted as a coverage gap and never admitted through strict or relaxed recommendations. The separate governance policy is unchanged: centralized-dependent, decentralized and unknown governance can pass this gate only with explicit reviewed `canBeBlacklisted=false`.
- Yield-source eligibility precedes venue preference: APY floor, native-only and published risk/warning gates apply per resolved rail. Unresolved venue chains discard that rail, not the entire coin. Source risk, depth bands, freshness and source-key tie-break follow venue preference; this comparator does not price APY. The yield score blend separately includes selected-rail excess APY and PYS. `yield-source.ts` owns shared depth bands; an unmeasured rail ranks below every measured band. Non-finite/future capture ages fail stale.
- The winning rail supplies source score components, why/watch context, history and chain hints. Alternate APY/risk are its own readings; absent PYS, variance, warnings or observation counts remain unavailable, never inherited from primary history or presented as clean. Selected-source TVL is distinct from coin DEX liquidity. Missing critical inputs redistribute weights/lower confidence, not synthesize an alternate model. Coin-level Safety/PegScore/supply/liquidity/custody stay coin-level. Published coin PYS remains a producer-coverage prerequisite, not an alternate component; selected-rail APY coverage permits a missing primary APY.
- Yield history counts distinct UTC observation days in the trailing window on the recommended rail. `yieldObservationDays30d` participates in hashing/replay. Missing counts stay unavailable; short observed history caps confidence under engine policy, never borrows a mature primary's history.
- Yield freshness advances at the dataset assessment clock from the retained source instant. Explicit `sourceObservedAt` takes precedence over a published age. Age-only primary/alternate evidence uses the yield response's own acquisition/age-assessment clock; without that anchor it remains unavailable. Non-finite or future source instants produce unknown freshness (`null`), not negative ages or a failed verified snapshot. Unrelated query refreshes cannot renew the observation, and publication `updatedAt` is not an age-assessment clock. This changes source tie-breaking, not freshness-rejection policy.
- Deduplication includes `variantOf ?? id` and selects the highest score with deterministic tie-breakers. Treasury/Trading keep one family representative across strict/relaxed slots; Yield separates yield-bearing/non-yield-bearing members. Concentration substitution chooses a protocol absent from already safeguarded entries within the engine score window, otherwise retains the original; it does not promise global protocol uniqueness. Zero-tolerance Slot B uses the profile's actual peg component.

`SelectorOutput` is the view/replay contract: recommendations, lower ranks, explanations, coverage/exclusions/near misses, relaxation, confidence, methodology versions, dataset hash, engine version and input staleness. Never expose internal reason/weight keys or promise a fixed result count. Ranking, exclusion, missing-data, tie-break, explanation or deterministic-output changes require an engine-version update in `shared/lib/selector/version.ts` and focused engine/editorial tests. The Trading shortlist card shows the maximum input staleness as neutral "Oldest input" provenance (age when results were computed), never a fresh/stale verdict or warning tone; share-link freshness limits are unchanged.

Shortlist cards label the existing spot-price strip `7d price`: its signed geometry is relative to the latest observed price, not a historical peg reference or a peg-deviation score. Constant off-peg samples therefore draw a flat price trajectory, and non-USD FX/commodity price movement remains price movement. Missing samples remain gaps; neither the series math nor engine rankings, hashes or methodology change.

## Navigation And Accessibility

Desktop history walks completed wizard steps; mobile commits one result after required inputs. Repair of an over-advanced URL step waits for shared URL readiness; the query-free hydration snapshot must not consume it. Step changes announce politely and focus the active question. Loading exposes `aria-busy`; generation/replay focuses the result summary. Options, skipped/near-miss rows, relaxation and links remain keyboard operable at narrow widths and 200% zoom.

## Browser Storage

`pharos.selector.callout.v1` stores dismissal in localStorage; the legacy `pharos-selector-callout-v1` is read-only compatibility. `pharos.selector.sessionResult.v1` stores only completed wizard answers (`state`) and save time (`savedAt`) in sessionStorage, not generated output. Older envelopes' extra output is ignored. There is no long-lived result history. Recovery restores answers and regenerates against current data with a banner; it is not frozen replay. [Privacy](./privacy-page.md) owns user-facing categories.

## Snapshot Sharing

The retained `og-selector-default.png` is a static 1200×630 profile card for `/screener/picker/`. It is intentionally profile-level, not snapshot-level, so recipients of `?sid=...` links never receive a social card containing the frozen shortlist or form answers. No profile/snapshot-specific card is served; [OG images](./og-images.md) owns the asset.

Creation posts only allowlisted inputs. `functions/lib/selector-canonical-snapshot.ts` reloads canonical sources, runs the shared adapter/engine and stores the recomputed projection in `SELECTOR_SNAPSHOTS` KV. Never trust caller scores, identities, hashes or prose. POST validates allowed UI origins and returns `{ sid, ev }`; GET returns verified or explicitly legacy-unverified output, or a typed miss/error. A missing sid-only snapshot is not replaced by current output.

Content-addressed schema-v3 artifacts require matching trusted KV metadata to be Pharos-verified. Legacy bodies without it are client-unverified. Strict recommendations cannot exceed `surviving`; total recommendations cannot exceed `active`. Redistribution/listing counters cover strictly scored rows, not relaxed gaps; relaxed recommendations retain allowed reasons/confidence caps and never also appear as closest near misses.

Verification certifies canonical server recomputation, not input freshness. `verification.canonicalSources` retains the server-fetched stablecoins `_meta` evidence, including the observed generation's `updatedAt`, producer status, assessment clock and named `freshBudgetSec`/`degradedBudgetSec` when supplied. The output `timestamp` remains the separate recomputation clock. Missing or malformed source metadata is recorded as unknown (`freshness: null`); historical snapshots without source evidence also have unknown freshness, never a fresh observation inferred from recomputation. This provenance survives verified persistence and replay but is excluded from the content-addressed SID, so provenance-only changes do not change identity or rankings. Existing same-content snapshots stay frozen; a repeated POST does not refresh their evidence. No extra stale-input rejection budget is imposed.

Unread snapshots expire after 90 days. Successful GET attempts a best-effort five-year extension; failed writes do not fail reads and may be retried later. Once extension metadata is stored, expiry does not slide.

Loaded output is frozen by default. Comparing its input with current data shows shortlist/rank, dataset hash, engine and methodology differences without overwriting the artifact. `snapshot-normalize.ts` treats `selector-v2.0`–`selector-v2.12` as current-generation replay, validating component keys against the profile vector and recomputing weights/contributions under current critical sets. Supported pre-v2.0 artifacts use legacy normalization: unique components with stored weights summing to 100 within tolerance, preserving stored normalized values/redistribution and legacy critical sets. Both branches recompute score/missing-critical reasons and require exclusion-filter version to match engine version. Accepted versions are allowlisted in `version.ts`, not every older version. Normalizing a stored projection does not rerun candidate selection or replace historical membership/authored text; pre-v2.10 eligibility and source clocks remain frozen. Session recovery is a separate current-data path.

`snapshot.ts` owns structural schemas; wire types infer from them through type-only imports, keeping engine vocabulary independent of snapshot validation. The depth/reserved-key scan precedes parsing, including unknown fields and array children. Structural admission never replaces semantic normalization or verified binding; only those boundaries project stored output. Canonicalization, limits, origin, quota, retention and errors remain owned by `canonicalize.ts`, the snapshot modules and Pages handler; [API reference](./api-reference.md) owns HTTP semantics.

## Update Rules

Change canonical filters, toolbar and codec tests together; handoff changes update `shared/lib/selector/answers-to-screener.ts`, `selector-handoff.ts` and deep-link tests. Source changes update freshness/loading/export behavior. Snapshot changes update shared modules, Pages Function tests, API reference and privacy categories. Metadata changes include sitemap/robots/headers; OG changes include the retained card and OG owner.

Focused test surfaces: `shared/lib/selector/`, `src/app/screener/`, `src/components/selector/`, and `functions/__tests__/selector-snapshot.test.ts`. Methodology owners: [report cards](./report-cards.md), [DEWS](./dews.md), [DEX liquidity](./dex-liquidity.md), [mint authority](./mint-authority-scoring.md). There is no standalone `/methodology/selector/` route; do not imply a delivery commitment.
