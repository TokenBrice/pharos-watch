# Chains Page

Contract for public `/chains/` and static `/chains/[chain]/` profiles. `src/app/chains/` owns shells/clients, `src/hooks/use-chains.ts` and `use-chain-profile-data.ts` reads, and `shared/lib/chains/` aggregation. [Chain Health](./chain-health.md) owns scoring, not this route guide.

## Route Shape

`shared/types/chain-identity.ts` owns `CHAIN_META`, aliases and chain types; `getActiveChainIds()` derives the static profile set. The leaderboard is indexable and exposes a crawlable complete profile directory with CollectionPage/ItemList and FAQ JSON-LD. Profiles reject unknown IDs, use canonical URLs and server-render tracked deployment links; deployment entities are Thing, not Product.

Registering a chain enables canonical attribution, not a reviewed bridge route or provider capability. Unregistered supply labels pool into unresolved chain identity in Safety Score; registration alone cannot clear bridge-route residuals. [Worker module initialization](./worker-infrastructure.md#module-initialization) and `shared/types/chain-identity.ts` own provider admission, state/archive/log distinctions and routing. Do not copy chain-by-chain probe receipts or provider rosters into route docs.

Chain supply history is an internal forward baseline, not this live chart/API. Public activation requires product scope, an explicit provenance-approved UTC baseline strictly after 2026-04-08, range/gap semantics and bounded-reader capacity. Latest completion does not certify an archive; missing days never become zero/interpolation. Missing/rejected reader evidence never authorizes stopping collection. [Supply Snapshot](./supply-snapshot.md#chain_supply_history) owns that boundary.

## `/chains/` Contract

Supply totals/shares derive from the response, not visible rows. Distinguish full registered-chain count from chains with observed supply. Excluded assets and chain observations make affected totals/rows partial. `globalTotalUsd` is observed global supply; the raw chain sum may under- or over-attribute it:

- Display a named Unattributed positive residual rather than allocate it to chains.
- Legend percentages use global `dominanceShare`, never rescaled percentages.
- Over-attribution changes bar geometry to `dominanceGeometryTotalUsd` and discloses the discrepancy; it must not clamp the statistic or invent an unattributed barge.

Default table order is descending total supply. `HarborSelectionProvider` alone owns `location.hash`: canonical `#chain-<id>` pins on load/hashchange, pinning replaces history and unpinning clears it. Hover/focus links table and harbor; Show in table scrolls/highlights with reduced-motion support. Pooled barges have no individual hash.

### Harbor

`shared/lib/harbor-scene.ts` and `harbor-scene-geometry.ts` own pure scene/geometry; `src/components/harbor/` owns interaction. Containers are a fixed linear supply encoding; display sliver floors never reach labels. Full-list pooling includes all chains beyond visible capacity. Drawn supply conserves `chainAttributedTotalUsd + unattributedTotalUsd` within $1, including fractional cargo. An unattributed barge is hatched and unflagged; discrepancy copy handles over-attribution instead.

Cargo includes all other assets, not merely a top-five slice. Shared categorical cargo colours remain distinct from health bands and the frost figure. Health uses shared band shape/pennant and hue; null health is NR with the report-card reason, never neutral health. Partial supply is explicitly a lower bound. Missing growth is not zero; positive growth from observed zero may be new. Retained/error-backed scenes disclose original source time and render retained styling, not fresh positive claims.

The equivalent sortable leaderboard and Skip the harbor link remain usable without the scene. One roving tab stop starts on the largest ship; arrows follow rank and Home/End reach endpoints. Hover/focus previews, click/Enter/Space pins, Escape/water unpins. Cards disclose exact supply/global share, health or reason, composition and changes with profile/table links. Phone sheets and docked cards must clear sticky/navigation chrome. No ambient carousel motion; the beam follows interaction without tweening. `validateHarborCapacity` covers face minima, overlap, height and conservation across growth/extreme fixtures; do not weaken it to fit a new chain.

## `/chains/[chain]/` Contract

Profiles read one `GET /api/chains?chain=<id>` generation through `useChainProfileData`/`useChainDetail`. Summary and details share `updatedAt` and freshness identity. Never reintroduce client recomputation from a second stablecoins query. `chainDetail.coins`, chain totals and `chainShare` use the same local denominator, sorted by local supply. Unclassified backing is Other, not a data-quality/health bucket.

Coverage-listed chains without a numeric row render unavailable supply/retry, not an untracked/removed fallback. Disclose excluded chain observations separately from excluded global assets. Changes require known current/historical pairs; missing history is `—`, explicit zero history remains known. Positive supply grown from zero has null ratio but valid absolute delta; zero-to-zero is measured no change.

## Chain Health Score

The API publishes composite and factor/evidence detail. Formula, weights, coverage gates, precedence, bands and versions belong to [chain-health.md](./chain-health.md) and `shared/lib/chains/health.ts`; band presentation belongs to `shared/lib/classification/chain-health.ts` for both frontend/Worker OG.

Loaded null factors show NR (loading shows `—`). Partial peg coverage shows observed-only factors and a visible coverage/missing-reference note even if the composite clears its gate. Floor observed percentages so partial cannot read 100%; no observed reference means NR. Neutral-imputation explanation applies only to factors whose methodology explicitly permits it.

## API And Freshness

Hooks use the shared cron-aligned chains preset and endpoint freshness budget, never a local duplicate. `ChainsFreshnessMetaSchema` in `shared/types/chains.ts` owns the wire shape. Body `_meta` and HTTP headers must agree; dependency lag degrades status. Only report-card dependency may be unavailable; envelope statuses remain fresh/degraded/stale. Missing scores distinguish stale/unavailable report-card inputs from genuine coverage gaps.

`worker/src/api/chains.ts` uses strict stablecoins cache and active core-aggregate assets for every aggregate/reference. Commodity references missing from FX inputs are withheld, never replaced with $1. Safety hydration requires a fresh accepted publication; held/stale/unavailable input leaves the map empty. Source `updatedAt` remains the stablecoins-cache time; degraded supply or health uses no-store. Invalid/unavailable strict cache returns 503.

Every positive-supply chain has exactly `min(stablecoinCount, 5)` top rows; schema validation rejects older/partial payloads rather than merging another generation. Absent/empty/invalid supply buckets are excluded and counted in aggregate/per-chain coverage, including chains left with no observed row. The raw chain total and discrepancy are never silently clamped.

## Update Rules

Update route semantics, API reference and relevant profile/Harbor tests when attribution, freshness, static membership or interaction changes. Scoring changes follow [ADR-3](./architecture.md#adr-3), including version source, structured chain-health changelog and public explanation; presentation-only changes do not create a second scoring authority. Provider evidence belongs with the Worker/provider owner, not this route.
