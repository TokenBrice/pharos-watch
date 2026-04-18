# Detail Page Blacklist Block — Design

**Date:** 2026-04-18
**Status:** Design approved, pending implementation plan
**Location of final spec:** `agents/plans/` per CLAUDE.md operating rules (overrides the default `docs/superpowers/specs/` from the brainstorming skill)

## Goal

Add a "Blacklist Activity" block to the stablecoin detail page (`src/app/stablecoin/[id]`) that surfaces per-coin blacklist data — frozen addresses, USD-frozen totals, quarterly event cadence, and a recent-events feed — for the 35 coins tracked in `BLACKLIST_STABLECOINS` that actually have events.

## Non-goals

- No new methodology (UI surfacing only). Methodology version is unchanged.
- No per-coin detail outside the detail page (main `/blacklist` page stays as-is).
- No freeze-ledger coverage expansion. Coins with events but no freeze-ledger snapshot render `$0` / `0` for the two "frozen" stats — honest about what we measure today. Coverage expansion is a separate piece of work.
- No new cron jobs. Data refresh cadence is unchanged (blacklist cron every 6h; summary endpoint cache 60 min).

## Gating

The block renders only when **both** conditions hold:

1. `BLACKLIST_STABLECOINS` includes the coin's symbol.
2. `summary.stats.perCoinTotalEvents[symbol] > 0`.

Consistent with the existing `hasFlows` data-presence pattern in `src/lib/stablecoin-detail-view-model.ts`. When gated out, nothing renders and no scrollspy pill is added.

## Placement

Inserted into the Activity Zone of `src/app/stablecoin/[id]/client.tsx`, after the existing `<FlowsSection>` and before the History Zone's `DepegHistory`.

Two sibling `<section>` tags (mirroring the `FlowsSection` pattern of `section#flows` + `section#flow-history`):

- `section#blacklist` — top card: header + stats row + chart
- `section#blacklist-history` — second card: 10-row event feed + "See all events →" link

Two separate sections give the scrollspy two anchors and keep each card at reasonable height.

New scrollspy entry `blacklist: { id: "blacklist", label: "Blacklist" }` added to `DETAIL_SECTION_DEFS`, conditionally included in the nav only when the block renders. Same pattern as `flows`.

## API change

One endpoint extension: `/api/blacklist-summary` response gains four new fields on `BlacklistSummaryResponse["stats"]`:

```typescript
perCoinFrozenAddressCount: Record<BlacklistStablecoin, number>;  // from blacklist_current_balances
perCoinFrozenTotal: Record<BlacklistStablecoin, number>;         // USD, from blacklist_current_balances
perCoinDestroyedTotal: Record<BlacklistStablecoin, number>;      // USD, from blacklist_events (event_type='destroy')
perCoinQuarterlyEventTypes: Record<
  BlacklistStablecoin,
  Array<{ quarter: string; blacklist: number; unblacklist: number; destroy: number }>
>;
```

Cache semantics unchanged — same endpoint, same hook, same 60-min `staleTime`, same freshness profile.

### SQL aggregations

Three new queries in the summary builder, all on tables with existing indexes:

**Frozen totals per coin** (from `blacklist_current_balances`):
```sql
SELECT stablecoin,
       COUNT(*) AS addr_count,
       COALESCE(SUM(balance_usd), 0) AS frozen_usd
  FROM blacklist_current_balances
 GROUP BY stablecoin;
```

**Destroyed totals per coin** (from `blacklist_events`):
```sql
SELECT stablecoin,
       COALESCE(SUM(amount_usd_at_event), 0) AS destroyed_usd
  FROM blacklist_events
 WHERE event_type = 'destroy'
   AND (suppression_reason IS NULL OR suppression_reason = '')
 GROUP BY stablecoin;
```

**Quarterly event types per coin** (from `blacklist_events`, bucket using the same quarter logic as the existing `summary.chart`):
```sql
SELECT stablecoin,
       <quarter_expr> AS quarter,
       event_type,
       COUNT(*) AS count
  FROM blacklist_events
 WHERE (suppression_reason IS NULL OR suppression_reason = '')
 GROUP BY stablecoin, quarter, event_type;
```

The exact `<quarter_expr>` follows whatever the existing summary builder uses for `summary.chart` quarterly bucketing — do not invent a new bucketing scheme.

### Filter policy

All four aggregations exclude `suppression_reason` rows (Circle's USDC→EURC zero-balance mirrors), matching the policy the public `/api/blacklist` endpoint already enforces.

### USD conversion

`blacklist_current_balances.balance_usd` and `blacklist_events.amount_usd_at_event` are already USD-converted by the cron (gold-price logic in `shared/lib/blacklist.ts`, forex for non-USD pegs). The new aggregations inherit this — no special casing in the API.

### Index check

During the plan, verify `blacklist_current_balances(stablecoin)` and `blacklist_events(stablecoin, event_type)` have index coverage. If not, add a covering migration. Fallback: table scans at summary-refresh time (~every 60 min with cache hits) are acceptable given current row counts.

## Component breakdown

Four new files under `src/components/stablecoin-detail/blacklist-section/`:

### `blacklist-section.tsx` (orchestrator)

```typescript
interface Props {
  stablecoinId: string;
  symbol: string;
}
```

Responsibilities:
- Pre-fetch gate: `BLACKLIST_STABLECOINS.includes(symbol)` → else return null.
- Calls `useBlacklistSummary()`.
- Post-fetch gate: `!isLoading && summary.stats.perCoinTotalEvents[symbol] === 0` → return null.
- Loading state: renders skeleton matching final shape.
- Ready state: renders the two sibling sections with their cards.
- On summary error: returns null (silent failure; blacklist is not load-bearing for the detail page).

### `blacklist-detail-stats.tsx`

Three `MetricStatCard`s in a row:

- **Frozen addresses** — value: `summary.stats.perCoinFrozenAddressCount[symbol]`, left border: emerald.
- **Frozen total** — value: `formatCurrency(summary.stats.perCoinFrozenTotal[symbol])`, left border: amber.
- **Destroyed total** — value: `formatCurrency(summary.stats.perCoinDestroyedTotal[symbol])`, left border: red.

Uses the same `MetricStatCard` component + border-color pattern as the main-page `BlacklistStats` for visual consistency. Loading-state skeletons match shape (three cards).

### `blacklist-detail-chart.tsx`

Quarterly stacked bar for a single coin, three series (blacklist / unblacklist / destroy).

Data source: `summary.stats.perCoinQuarterlyEventTypes[symbol]`. Series colors match the main-page chart's event-type palette if one exists, else defined alongside `BLACKLIST_CHART_COLORS` in `shared/lib/classification.ts`.

Handles the degenerate case where the coin has only one event type present — all three series are always plotted, zero-valued bars just aren't visible.

### `blacklist-event-feed.tsx`

10-row compact event list mirroring `FlowEventFeed`'s visual rhythm (since it sits directly below the Mint & Burn Flow History). Row format:

- Event-type colored dot + label (Blacklist / Unblacklist / Destroy)
- Truncated address with link to explorer (`explorerAddressUrl` from the event)
- Amount — native value, plus USD in parens when they differ (gold, non-USD pegs). Shows `—` when `amountStatus` is unresolved.
- Chain name
- Relative timestamp (e.g., "2d ago")

Data source: `useBlacklistEventsPage({ stablecoin: symbol, limit: 10, offset: 0 })`.

Footer: `<Link href={`/blacklist?stablecoin=${symbol}`}>See all events →</Link>`.

**To verify during the plan:** confirm `/blacklist` reads `stablecoin` from URL params and hydrates the filter accordingly. If not, wire this in as part of the implementation (small change to the existing filter/URL-sync logic on the main page).

## Detail page wiring

In `src/app/stablecoin/[id]/client.tsx`:

1. Import `BlacklistSection` from the new directory.
2. Add `<BlacklistSection stablecoinId={id} symbol={coin.symbol} />` immediately after `<FlowsSection stablecoinId={id} hasFlows={hasFlows} />` (around line 337).
3. Add `blacklist: { id: "blacklist", label: "Blacklist" }` to `DETAIL_SECTION_DEFS` (around lines 86–97).

In `src/lib/stablecoin-detail-view-model.ts`:

- Call `useBlacklistSummary()`.
- Compute `hasBlacklist = BLACKLIST_STABLECOINS.includes(coin.symbol as BlacklistStablecoin) && (isLoadingSummary || summary.stats.perCoinTotalEvents[coin.symbol] > 0)`.
- Return `hasBlacklist` alongside `hasFlows`; the scrollspy consumes it to filter the Blacklist pill.

## Edge cases

- **Gold coins (PAXG, XAUT, XAUM)**: already USD-converted in stored columns. No special API casing. Event feed shows native (e.g., ounces) alongside USD.
- **Non-USD pegs (EURC, BRZ, EURI, TGBP, EURCV, JPYC, AEUR, USDA)**: same — USD conversion baked in. Event rows show native + USD where they differ.
- **EURC mirror suppression**: all four aggregations filter `suppression_reason` rows. EURC's per-coin stats reflect real events only.
- **Coin in list but zero real events**: gate 2 hides the block and the scrollspy pill.
- **Freeze-ledger gap** (coin has events but no `blacklist_current_balances` rows): stats degrade to `0` / `$0`. Chosen strategy is to render as-is — honest about measurement coverage. No UI branching, no coverage flag. Revisit only if this confuses readers.
- **Amount-recovery pending events**: event rows show `—` for USD; totals only sum resolved amounts (unchanged from current cron behavior).
- **Tron USDT**: covered by existing freeze-ledger seed. No Tron-specific work.

## Testing

### API layer (Worker / D1)

- Seed fixture into `blacklist_events` + `blacklist_current_balances` across 3 coins (one USD, one gold, one non-USD peg), verify all four new aggregations.
- `suppression_reason` filter test: one suppressed row, confirm excluded from all four.
- Empty case: coin with zero events returns `0` / `[]` (not `undefined`), so client code doesn't need presence checks.
- Prefer extending the existing summary handler test file; only add a new file if one doesn't exist.

### Shared types

- Type-level assertion that `BlacklistSummaryResponse["stats"]` includes all four new fields with the correct `Record<BlacklistStablecoin, ...>` shapes.

### Frontend components

- `BlacklistSection`: three render paths — gated out (non-supported), gated out (zero events), ready — each against a fixture summary.
- `BlacklistDetailStats`: renders three `MetricStatCard`s with correct values; renders skeletons when `isLoading`.
- `BlacklistDetailChart`: renders three stacked series; handles a coin with only one event type present.
- `BlacklistEventFeed`: renders 10 rows; shows `—` for unresolved amounts; footer link has `href="/blacklist?stablecoin={symbol}"`.

### Integration

- Detail page renders section for USDC (has events), doesn't render for USDD (not in `BLACKLIST_STABLECOINS`), doesn't render for a supported-but-zero-events coin.
- Scrollspy pill "Blacklist" appears only when the section renders.

### Pre-push

- `npm run test:merge-gate` picks up Worker type-check and Pages build coverage on deploy-impacting diff automatically.

## Docs to update

- `docs/blacklist-tracker.md` — add a "Detail-page block" subsection under the Frontend section documenting the component tree and the four new API fields.
- `docs/api-reference.md` — update the `/api/blacklist-summary` response shape.

## Methodology version

Unchanged. This is a UI surfacing change, not a methodology change.

## Open items for the plan

Three small verifications to resolve during planning:

1. Exact file path of the blacklist summary handler in `worker/src/api/`.
2. Whether `blacklist_current_balances(stablecoin)` and `blacklist_events(stablecoin, event_type)` have covering indexes.
3. Whether `/blacklist` hydrates filter state from the `stablecoin` URL param; if not, wire it in as part of this work.
