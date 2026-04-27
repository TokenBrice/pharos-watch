# Frozen Stablecoin Status — Design Spec

**Date:** 2026-04-27
**Status:** Approved
**Owner:** tokenbrice

## Background

Stablecoins we used to track sometimes die (e.g. USR/`usr-resolv` after its collapse). Today the only retirement path is moving the entry to `shared/data/dead-stablecoins.json` (the cemetery), which:

- Erases the live detail page at `/stablecoin/<id>/`.
- Discards all preserved historical context (mcap chart, depeg history, distribution, blacklist events, mint/burn flows).
- Leaves no archival breadcrumb for researchers, journalists, or anyone landing from a now-broken external link.

A "frozen" lifecycle phase, parallel to the existing pre-launch phase, preserves the historical record while removing the coin from every live data pipeline. USR is the guinea pig; the procedure must be standardized for repeated future use.

## Goals

1. **No new data is collected for a frozen coin.** Every Worker fetch, snapshot, computation, alert, and event-detection job must skip frozen coins. This is the headline invariant.
2. **The detail page keeps rendering** with the preserved historical data, plus an obituary-style banner above the hero and a persistent "data frozen" note above each chart section.
3. **Frozen coins appear in the cemetery** alongside never-tracked dead coins, with a "View archived data →" link to the detail page. Never-tracked coins remain link-less.
4. **Site-wide aggregates and market views drop frozen coins** (homepage table, `/stablecoins/`, all aggregate pages, related candidates, PSI, Telegram alerts, static comparison presets).
5. **Frozen coins remain searchable and selectable for live comparison**, with a visual badge.
6. **Existing preserved data is never destroyed** by retention pruning, eviction crons, or upstream pruning.
7. **The procedure is documented and CI-guarded** so a freeze is a single PR with a deterministic checklist.

## Non-goals

- Capturing a freeze-time snapshot of *every* metric (rolling-window 24h flows, 7d net flow, etc.). Stale-graceful decay is accepted for v1; the only freeze-time snapshot is the upstream `peggedAssets` cache row, captured solely to survive DefiLlama dropping the asset.
- Admin UI for freezing. The procedure is JSON-edit + script + PR.
- Un-freezing / resurrection. Out of scope; would be a manual reverse-edit if ever needed.
- Reorganizing the cemetery dataset format for downstream consumers beyond adding rows.
- Migration of the existing `dead-stablecoins.json` entries to the new `obituary` shape.

## Architecture

### Four-universe registry taxonomy

`shared/lib/stablecoins/registry.ts` exports four overlapping coin universes. Every consumer in the worker, frontend, and shared libs picks exactly one.

| Export | Definition | Used by |
|---|---|---|
| `TRACKED_STABLECOINS` | every coin (active + pre-launch + frozen) | sitemap, search/command palette, detail-page `generateStaticParams`, eviction-cron preserve sets |
| `ACTIVE_STABLECOINS` | `status === "active"` (excludes pre-launch and frozen) | write-side crons, market lists, aggregate pages, related candidates, PSI eligibility |
| `READABLE_STABLECOINS` | `status !== "pre-launch"` (active + frozen) | API endpoints serving the frozen detail page (reserves, stress-signals, OG), compare picker, `/api/stablecoins` payload, rebuild-side caches |
| `FROZEN_STABLECOINS` | `status === "frozen"` | cemetery merge, freeze-time invariants, eviction-exemption checks |

Companion sets: `TRACKED_IDS`, `ACTIVE_IDS`, `READABLE_IDS`, `FROZEN_IDS`. Companion maps: `TRACKED_META_BY_ID`, `ACTIVE_META_BY_ID`, `READABLE_META_BY_ID`.

The semantic shift of `ACTIVE_STABLECOINS` (from `status !== "pre-launch"` to `status === "active"`) is the single highest-risk change in this spec. Every existing consumer is audited and either kept on ACTIVE (if it should hide frozen) or moved to READABLE/TRACKED (if it should still surface frozen). See §Implementation.

### Type system

In `shared/types/core.ts`:

```ts
export const STABLECOIN_STATUS_VALUES = ["pre-launch", "active", "frozen"] as const;
export type StablecoinStatus = (typeof STABLECOIN_STATUS_VALUES)[number];

export interface StablecoinObituary {
  causeOfDeath: CauseOfDeath;   // shared enum, see below
  deathDate: string;             // YYYY-MM or YYYY-MM-DD; matches dead-stablecoins.json precision
  epitaph: string;               // headline shown in banner + tombstone
  obituary: string;              // collapsible paragraph in banner + tombstone
  peakMcap?: number;             // computed from D1 at freeze time
  sourceUrl: string;
  sourceLabel: string;
}

export interface StablecoinMeta {
  // ...existing fields
  status?: StablecoinStatus;
  frozenAt?: string;             // YYYY-MM-DD; required when status === "frozen"
  obituary?: StablecoinObituary; // required when status === "frozen"
}
```

`CauseOfDeath`, `CAUSE_META`, and `CAUSE_HEX` relocate from `shared/lib/dead-stablecoins.ts` to a new `shared/lib/cause-of-death.ts` so both `DeadStablecoin` (untracked) and the new `obituary` block (was-tracked) reference one source. `dead-stablecoins.ts` re-exports for back-compat.

Registry validation runs at module load: if `status === "frozen"`, both `frozenAt` and a complete `obituary` block must be present. Mirrors how `pre-launch` validates its companion fields.

### Freeze-time snapshot mechanism

A new file `shared/data/stablecoins/frozen-snapshots.json` keyed by stablecoin id captures, at freeze time, the coin's last known `peggedAssets` cache row (the structure DefiLlama would have returned). Schema:

```ts
type FrozenSnapshotEntry = {
  id: string;
  capturedAt: string;            // ISO timestamp
  peggedAssetRow: PeggedAssetRow; // identical to one element of cache.payload.peggedAssets
};
```

`worker/src/cron/sync-stablecoins/intake.ts` injects these rows when DefiLlama drops the upstream entry. Logic: after upstream merge and before `applyTrackedAssetOverrides`, iterate `FROZEN_SNAPSHOTS`; for each frozen id missing from the upstream payload, append the captured row. The captured row is **never updated** — it represents a moment-in-time archive.

This is the only freeze-time snapshot machinery in v1. Other tables (peg-summary, report-cards, dex-liquidity, supply-history, depeg-events, etc.) rely on D1 row preservation + retention carve-outs.

### Detail page rendering (stale-graceful)

`src/app/stablecoin/[id]/page.tsx` and `client.tsx` are largely unchanged. The page renders the existing `<HeroCard>` and chart sections; data flows through the existing API endpoints. Where rolling-window data has decayed, panels render "—" naturally — the existing null-handling is adequate.

Two new components:

- `<FrozenStateBanner>` — sits **above** `<HeroCard>` when `coin.status === "frozen"`. Shows the cause-of-death badge (reusing `CAUSE_META` colors), the epitaph as headline, the obituary as collapsible paragraph, the source link, a "View on cemetery →" link, and the `frozenAt` date.
- `<FrozenDataNote>` — small footer above each major chart section (mcap chart, depeg history, distribution, flows, liquidity, blacklist) when `coin.status === "frozen"`. Copy: "Data frozen on YYYY-MM-DD. Pharos no longer collects new metrics for this asset."

Detail-page metadata adjustment: `buildStablecoinDetailMetadata` (`src/lib/page-metadata.ts`) detects `coin.status === "frozen"` and produces archive-themed title and description (e.g., "Resolv USR — Frozen Stablecoin Archive | Pharos") instead of the live-data copy.

### Cemetery merge

`src/components/cemetery-tombstones.tsx` and adjacent components source from a merged array:

```ts
const cemeteryEntries = [
  ...DEAD_STABLECOINS,                          // never-tracked
  ...FROZEN_STABLECOINS.map(toDeadStablecoinShape), // was-tracked
];
```

`toDeadStablecoinShape` projects a `StablecoinMeta` + `obituary` into the existing `DeadStablecoin` shape. The shape gains one optional field, `archivedDataAvailable: boolean`, distinguishing the two origins. Tombstones for `archivedDataAvailable === true` render an extra "View archived data →" link to `/stablecoin/<id>/`.

`scripts/generate-cemetery-dataset.ts` regenerates the public JSON/CSV from the merged array. The CSV gains an `archivedDataAvailable` column (preserves existing column order before it). The JSON entries for frozen coins set `pharosUrl` to the detail page; never-tracked entries continue to point at the cemetery anchor.

### Worker pipeline rules

**Write-side rule.** Every cron/job that fetches upstream data or runs computations and INSERTs new rows uses one of: `ACTIVE_STABLECOINS`, `ACTIVE_IDS`, `ACTIVE_META_BY_ID`, or `loadStablecoinsCache` constrained to active-only.

**Eviction rule.** Every `DELETE WHERE stablecoin_id NOT IN (...)` widens its preserve set from `ACTIVE_STABLECOINS` to `TRACKED_STABLECOINS` (which contains all coins including frozen). Time-based pruning (`stored_at < ?`) extends with `AND stablecoin_id NOT IN (frozen_ids)` so retention never deletes frozen rows.

**Update-side carve-outs.** `worker/src/cron/detect-depegs.ts` orphan-close pass (currently force-closes any open depeg event whose coin missed the cache iteration) skips coins in `FROZEN_IDS`.

**Read-side rule.** API endpoints and rebuild caches serving the frozen detail page use `READABLE_*` (active + frozen). Specifically:

- `worker/src/api/stablecoin-reserves.ts` gate switches from `ACTIVE_IDS` to `READABLE_IDS`.
- `worker/src/api/stress-signals.ts` gate switches from `ACTIVE_IDS` to `READABLE_IDS`.
- `worker/src/api/og.tsx` gate switches from `ACTIVE_IDS` to `READABLE_IDS` (so shared frozen URLs render correct OG images, not 404).
- `/api/stablecoins` payload includes frozen coins. Each entry gains `frozen: boolean` and `frozenAt: string` fields so the frontend renders the banner without a second round-trip.
- Report-card snapshot finalize (`worker/src/lib/report-cards-snapshot-finalize.ts`) extends `buildDefunctReportCards` to inject frozen-coin cards alongside `DEAD_STABLECOINS`-driven defunct cards. Frozen-coin cards reuse their last successful card content from D1 (or a freeze-time snapshot captured by the freeze script).

**Independent membership lists.** Several worker registries are hand-coded and don't consult `STABLECOIN_STATUS`. The freezing runbook removes the frozen coin from each:

- `MINT_BURN_CONFIG_SPECS` in `worker/src/lib/mint-burn-contracts-data.ts`
- `CONTRACT_CONFIGS` in `worker/src/lib/blacklist-contracts.ts`
- `BLUECHIP_SLUG_MAP` in `worker/src/lib/bluechip-slugs.ts`
- `YIELD_POOL_MAP` in `worker/src/cron/yield-history-backfill.ts`
- Any per-coin sync cron (e.g., `sync-usds-status.ts`, `sync-kinesis-supply.ts`) that targets the frozen coin.
- `STATIC_COMPARE_PAIRS` in `src/lib/compare-pages.ts` (any pair containing the coin).

CI guard `check:frozen-invariants` (new) asserts no frozen id remains in any of the above after the JSON edits.

**PSI eligibility.** `shared/lib/psi-eligible.ts` derives `PSI_ELIGIBLE_IDS` from `TRACKED_IDS ∪ SHADOW_IDS` minus pre-launch. The set is amended to also exclude `FROZEN_IDS`, keeping the market-wide stability index from being contaminated by zero/decayed frozen entries.

**Crons specifically requiring filter changes** (audited from worker validator, may extend during implementation):

| Cron / file | Today | Change |
|---|---|---|
| `detect-depegs.ts` | iterates cache + `TRACKED_META_BY_ID` | filter to `ACTIVE_IDS`; skip orphan-close for `FROZEN_IDS` |
| `confirm-pending-depegs.ts` | `TRACKED_META_BY_ID` lookups | skip `FROZEN_IDS` |
| `sync-mint-burn.ts` | `MINT_BURN_CONFIGS` registry | filter via `FROZEN_IDS` (or remove from registry per runbook) |
| `sync-blacklist.ts` | `CONTRACT_CONFIGS` | filter via `FROZEN_IDS` (or remove from registry) |
| `sync-bluechip.ts` | `BLUECHIP_SLUG_MAP` | filter via `FROZEN_IDS` (or remove) |
| `yield-history-backfill.ts` | `YIELD_POOL_MAP` | filter via `FROZEN_IDS` (or remove) |
| `snapshot-chain-supply.ts` | iterates raw cache, no registry filter | add `ACTIVE_IDS` filter |
| `snapshot-safety-grade-history.ts` | filters `isDefunct !== true` (dead-stablecoins-only) | extend "skip" to include frozen |
| `publish-report-card-cache.ts` | inherits from above | inherits |
| `sync-stablecoins/post-enrichment.ts` | `TRACKED_META_BY_ID` lookups | gate writes on `ACTIVE_IDS` |
| `sync-stablecoins/supply-gap-reconciliation.ts` | `TRACKED_META_BY_ID` lookups | gate on `ACTIVE_IDS` |
| `sync-stablecoins/phase-helpers.ts` | `TRACKED_META_BY_ID` lookups | gate on `ACTIVE_IDS` |
| `dex-liquidity/persistence.ts` (cleanup) | `validIds = ACTIVE_STABLECOINS` | switch to `TRACKED_IDS` |
| `dews/persistence.ts` (cleanup) | `eligibleIds`-only preservation | preserve `FROZEN_IDS` rows explicitly |
| `compute-dews.ts` | `PSI_ELIGIBLE_STABLECOINS` (TRACKED-derived) | inherits PSI fix |
| `stability-index.ts` | `PSI_ELIGIBLE_IDS` | inherits PSI fix |
| `snapshot-supply.ts` | `PSI_ELIGIBLE_STABLECOINS` | inherits PSI fix |
| `telegram-alerts.ts` (preset builder) | iterates `TRACKED_STABLECOINS` | filter to `ACTIVE_STABLECOINS` |
| `dispatch-telegram-alerts.ts` | already `ACTIVE_IDS` | no change |
| `telegram-digest-appendices.ts` | diffs `DEAD_STABLECOINS` only | add a separate "newly frozen" diff source keyed off `FROZEN_IDS`; emit a cemetery appendix on first detection |
| Backfill admin endpoints (`backfill-*.ts`) | no frozen check | add `assertNotFrozen()` guard; 403 for frozen ids |

### Frontend changes

| Surface | File | Change |
|---|---|---|
| Detail page metadata | `src/lib/page-metadata.ts` `buildStablecoinDetailMetadata` | branch on `coin.status === "frozen"` for archive-themed title/description |
| Detail page render | `src/app/stablecoin/[id]/client.tsx` | insert `<FrozenStateBanner>` above `<HeroCard>` and `<FrozenDataNote>` above each major chart section when `coin.status === "frozen"` |
| Sitemap | `src/app/sitemap.ts` | keep `TRACKED_STABLECOINS` (do not narrow); ensure `STATIC_COMPARISON_PAGES` source has been pre-filtered |
| Compare picker options | `src/lib/compare-config.ts` `COMPARE_COIN_OPTIONS` | switch from `ACTIVE_STABLECOINS` to `READABLE_STABLECOINS`; render frozen entries with a "frozen" badge |
| Compare URL handling | `src/hooks/use-compare-selection.ts` | accept frozen ids in `?coins=...`; render with a "frozen, last data YYYY-MM-DD" chip in `<ComparisonTable>` (decision D1=a) |
| Comparison table | `src/components/comparison-table.tsx` | when a coin chip is frozen, surface chip badge + a tooltip; metric cells render "—" with explanatory tooltip when null |
| Static compare pages | `src/lib/compare-pages.ts` `STATIC_COMPARE_PAIRS` | filter at construction: drop any pair containing a `status === "frozen"` coin; sitemap and `/compare/[slug]/` `generateStaticParams` inherit |
| Command palette / search | `src/components/command-palette.tsx` | continues using `TRACKED_STABLECOINS` (preserves pre-launch searchability); render frozen entries with a "frozen" badge; demote frozen entries on tied search scores |
| Pinned stablecoins | `src/lib/pinned-stablecoins.ts` | continues using `ACTIVE_IDS`; frozen pins drop silently (decision D2=a); document in runbook |
| Related stablecoins | `src/lib/related-stablecoins.ts` | continues using `ACTIVE_STABLECOINS` for candidates; no change |
| `/about` page | `src/app/about/page.tsx` | add a paragraph explaining the frozen-status archive; existing `ACTIVE_STABLECOINS.length` count auto-shifts |
| `/methodology` page | `src/app/methodology/...` | add a "Frozen status" subsection; bump methodology version to v5.81 |
| Hardcoded counts | `docs/supply-snapshot.md`, `docs/report-cards.md`, root `CLAUDE.md`, `agents/...` | replace literal "215" with computed `ACTIVE_STABLECOINS.length` references where they're rendered, or note the count is post-frozen-exclusion |

### Layout / scrollspy

`<FrozenStateBanner>` adds vertical height above `<HeroCard>`. `LongformScrollspyNav` uses IntersectionObserver with section IDs; inserting a banner shifts all anchors uniformly without code changes. Constraint: the banner must have a static (non-animating) height on initial mount to avoid scrollspy mis-firing. The collapsible obituary paragraph animates only after user interaction.

### AI summary handling

`data/ai-summaries.json` is read at `src/app/stablecoin/[id]/page.tsx`. On freeze, the existing summary is **kept as-is** — the LLM has no signal of the freeze beyond what we feed it, and rewriting risks losing nuance. The obituary block lives in registry meta and is rendered by `<FrozenStateBanner>` independently of the AI summary. The runbook documents this explicitly.

### Telegram cemetery digest

`worker/src/lib/telegram-digest-appendices.ts` gains a second diff source: a new `frozen_snapshot` D1 cache key tracks the previously-known set of `FROZEN_IDS`. On daily digest run, the diff between the cached snapshot and the live `FROZEN_IDS` produces a "newly frozen" set. First detection seeds silently (mirrors the existing dead-stablecoins seeding pattern). Subsequent additions emit a cemetery appendix in the next daily digest, using each newly frozen coin's `obituary.epitaph` and a rotating editorial footer line consistent with the existing cemetery appendix format.

## Acceptance criteria

1. **No-new-data invariant.** A test run that simulates one full cron tick after USR is frozen produces zero new D1 INSERTs/UPDATEs whose `stablecoin_id = "usr-resolv"`. Verified by integration test against a fixture frozen coin.
2. **Hero card persistence.** With DefiLlama returning a payload that omits the frozen coin, `/api/stablecoins` still includes the frozen coin's row (sourced from `frozen-snapshots.json`). Detail page hero renders. Verified by unit test on `intake.ts`.
3. **No data destruction.** A test that runs `dex-liquidity/persistence.ts`, `dews/persistence.ts`, and time-based prune crons against a fixture frozen coin's preserved rows asserts row count is unchanged after the run.
4. **Cemetery + frozen merge.** `/cemetery/` renders a tombstone for the frozen coin with the "View archived data →" link; never-tracked tombstones do not have it. Cemetery dataset export contains both.
5. **Detail page banner + footer notes.** `/stablecoin/usr-resolv/` renders `<FrozenStateBanner>` above `<HeroCard>` and `<FrozenDataNote>` above each major chart section.
6. **OG image works.** `https://api.pharos.watch/api/og?stablecoin=usr-resolv` returns 200 with a frozen-themed image (or the live template; the gate is the only required change).
7. **Telegram digest fires.** First daily digest after the freeze includes a cemetery appendix entry for the new frozen coin.
8. **Compare URL accepts frozen.** `/compare/?coins=usr-resolv,usdc-circle` loads with USR present and badged as frozen; mcap chart renders from preserved `supply_history`; live-only metrics show "—".
9. **CI guards green.**
   - `check:frozen-invariants` (new) — registry validation, no membership-list leaks, no id collision with `dead-stablecoins.json`, snapshot row exists.
   - `check:cemetery-dataset` (extended) — merged dataset contains both legacy and frozen entries.
   - `check:doc-counts` (extended) — `ACTIVE_STABLECOINS.length` matches docs.
10. **PSI uncontaminated.** PSI snapshot for the day after the freeze has zero contributions from the frozen coin.

## Implementation outline (high-level)

The detailed plan is produced separately by the writing-plans skill. High-level phases:

1. **Type system + registry.** Add `"frozen"` to `STABLECOIN_STATUS_VALUES`. Add `frozenAt`, `obituary` to `StablecoinMeta`. Relocate `CauseOfDeath` to shared. Add `READABLE_*` and `FROZEN_*` exports. Redefine `ACTIVE_*` as `status === "active"`. Registry validation.
2. **Worker write-side audit.** For every cron in the implementation table above, switch to `ACTIVE_*` or add explicit `FROZEN_IDS` skip. Add `assertNotFrozen()` to backfill admin endpoints.
3. **Worker eviction-defensive widening.** Every `NOT IN (active)` widens to `NOT IN (tracked)`. Every time-based prune adds `AND stablecoin_id NOT IN frozen_ids`. `detect-depegs` orphan-close exempts `FROZEN_IDS`.
4. **Worker read-side widening.** API gates (`stablecoin-reserves`, `stress-signals`, `og`) switch to `READABLE_IDS`. `/api/stablecoins` payload exposes `frozen` + `frozenAt`. `report-cards-snapshot-finalize` includes frozen.
5. **Frozen snapshot mechanism.** New `frozen-snapshots.json` schema + Zod validation. `intake.ts` injection logic. Freeze script (`scripts/freeze-stablecoin.ts`) that reads D1 to compute `peakMcap` and capture the `peggedAssets` row.
6. **Telegram cemetery digest.** New diff source for `FROZEN_IDS` in `telegram-digest-appendices.ts`. New D1 cache key for previous-frozen-set seeding.
7. **Frontend components.** `<FrozenStateBanner>`, `<FrozenDataNote>`. Detail-page wiring. Metadata adjustment in `page-metadata.ts`.
8. **Frontend list-source switches.** Compare picker → READABLE. Static-compare-pages filter. Sitemap stays TRACKED. Command palette renders frozen badge + demotion. Comparison table chip + tooltip + null cells.
9. **Cemetery merge + dataset export.** `cemeteryEntries` merge in components. Dataset script extended.
10. **CI guards + invariants.** New `check:frozen-invariants`. Extend `check:cemetery-dataset`. Extend `check:doc-counts`.
11. **Docs + methodology.** `/about`, `/methodology` (v5.81 bump), `docs/architecture.md`, `docs/cemetery-and-compare.md`. Replace hardcoded "215" counts.
12. **Runbook.** `docs/freezing-stablecoins.md` — full step-by-step.
13. **PR #1 (system).** All of the above with a fixture frozen coin in tests, no real coin frozen.
14. **PR #2 (USR migration).** Single-coin diff. Run freeze script. Verify acceptance criteria 1–10 in production.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Independent membership lists silently keep collecting data for a frozen coin | Runbook checklist removes from each list; `check:frozen-invariants` asserts no leak |
| Time-based retention pruning eventually deletes frozen rows | Each prune cron extended with `AND stablecoin_id NOT IN frozen_ids` |
| DefiLlama drops `usr-resolv` from upstream → cache rebuild loses the row | `frozen-snapshots.json` injected during intake |
| Eviction crons (DEX, DEWS) wipe preserved rows on first run | Eviction preserve sets widen from ACTIVE to TRACKED |
| `detect-depegs` orphan-close falsifies preserved depeg history | Skip orphan-close for `FROZEN_IDS` |
| OG image 404s on shared frozen URLs | OG gate widens to READABLE |
| PSI contaminated by zero-mcap frozen coins | `PSI_ELIGIBLE_IDS` excludes `FROZEN_IDS` |
| Telegram cemetery digest auto-fire claim is unimplemented | Explicit new diff source in `telegram-digest-appendices.ts` |
| Detail-page metadata still says "Live data..." | Branch on `coin.status === "frozen"` in `buildStablecoinDetailMetadata` |
| Hardcoded "215" counts drift | Replace with computed counts in one-time pass; CI guard for renders |
| Operator runs a backfill admin endpoint on a frozen coin | `assertNotFrozen()` guard 403s |
| Cemetery id collision between legacy `dead-stablecoins.json` and `FROZEN_STABLECOINS` | `check:frozen-invariants` asserts disjoint id sets |
| Pinned stablecoins silently drop frozen pins | Documented behavior in runbook (decision D2=a) |
| Live compare URL with frozen id breaks | `use-compare-selection` accepts frozen ids; renders chart from preserved `supply_history` (decision D1=a) |
| Scrollspy mis-fires on initial mount due to banner animation | Banner has static height on mount; obituary paragraph only animates on user interaction |
| `peakMcap` drifts if entered manually | Freeze script computes from `supply_history` (`MAX(circulating_usd)`) |

## Decisions log

- **D1 (compare URL with frozen coin):** option (a) — keep frozen ids in the comparison, render with a frozen chip. Consistent with the picker decision.
- **D2 (pinned stablecoins on freeze):** option (a) — frozen coins drop silently from pinned. Existing behavior, documented.
- **D3 (methodology version):** v5.81 minor bump.
- **Data model (Q2):** approach A — single source of truth, `obituary` block on `StablecoinMeta`, cemetery merges from two sources at render time.
- **Visibility (Q3):** option B for compare picker — keep selectable with a "frozen" badge.
- **Hero data (Q4):** option 3 — stale-graceful, hero renders normally with banner + chart-footer notes; rolling-window decay accepted.
- **Banner anatomy (Q5):** B+C — rich top banner (cause badge, epitaph, collapsible obituary, source link, cemetery link, freeze date) plus persistent "data frozen on YYYY-MM-DD" footer above each chart section.

## Open questions

None blocking. Future considerations not in scope:

- Whether to capture additional freeze-time snapshots (rolling-window metrics) for richer historical UX. Defer to v2 if `<FrozenDataNote>` proves insufficient.
- A dedicated "Frozen archive" pinning category. Defer.
- Un-freezing procedure. Defer.
