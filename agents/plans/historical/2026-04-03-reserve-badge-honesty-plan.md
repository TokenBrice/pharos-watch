# 2026-04-03 Reserve Badge Honesty Plan

## Goal

Make the reserve-card headline badge honest.

Current behavior:

- the badge says `Live` whenever the detail API returns any authoritative snapshot with `liveAt`
- that includes true live feeds, curated-validated baselines, and weak proof / liveness paths

Target behavior:

- show `Live` only when the reserve view is truly live under the product rule
- show a different badge for reviewed baselines kept fresh through validation
- show a different badge for proof / liveness style feeds that are not full live reserve composition

This plan is scoped to the stablecoin detail reserve card first.

## Recommended Semantics

### Keep transport freshness separate from display truth

Do **not** overload API `mode`.

- `mode: "live"` should keep meaning "authoritative snapshot exists and is fresh enough for live/live-stale serving"
- badge semantics should become a separate explicit field

Reason:

- `mode` is about snapshot availability + freshness
- the badge is about what kind of evidence the snapshot represents
- changing `mode` would create unnecessary API churn and break existing cache/polling assumptions

### Introduce an explicit badge class

Add a new shared enum for reserve badge display, for example:

- `live`
- `curated-validated`
- `proof`

Recommended user-facing labels:

- `Live`
- `Curated-Validated`
- `Proof`

Recommended meanings:

- `Live`: reserve composition is sourced from a real live feed or direct onchain reserve/accounting reads
- `Curated-Validated`: reserve composition is still a reviewed / curated baseline, but Pharos is validating it with live checks
- `Proof`: reserve view is backed by a live proof, supply probe, attestation total, or liveness path, but not a full live reserve composition feed

This keeps the headline compact while the existing provenance note below the chart can continue to explain the nuance.

## Classification Strategy

### Do not derive the badge from `evidenceClass` alone

`evidenceClass` is the wrong display primitive for this purpose.

Why:

- `static-validated` is not always "not live" for display
  - `usdd-data-platform`
  - `re-metrics`
- `independent` is not enough by itself if a family is only a proof-style single bucket
- the current scoring model and the desired user-facing honesty model are related but not identical

### Derive badge class from adapter display semantics

Add a new adapter-registry or shared-mapping property in `shared/lib/live-reserve-adapters.ts` or a dedicated shared helper, for example:

- `displayBadgeKind: "live" | "curated-validated" | "proof"`

Initial mapping:

- `live`
  - `accountable`
  - `asymmetry`
  - `btcfi`
  - `chainlink-nav`
  - `chainlink-por`
  - `circle-transparency`
  - `collateral-positions-api`
  - `crvusd`
  - `dola-inverse`
  - `erc4626-single-asset`
  - `ethena`
  - `evm-branch-balances`
  - `falcon`
  - `fdusd-transparency`
  - `fx`
  - `gho`
  - `infinifi`
  - `m0`
  - `mento`
  - `openeden-usdo`
  - `re-metrics`
  - `reservoir`
  - `sgforge-coinvertible`
  - `sky-makercore`
  - `usdai-proof-of-reserves`
  - `usdd-data-platform`
- `curated-validated`
  - `curated-validated`
  - `frax`
- `proof`
  - `single-asset`
  - `tether`

This is intentionally badge-focused, not scoring-focused.

## Implementation Steps

### 1. Add a shared reserve badge type

Files:

- `shared/types/live-reserves.ts`

Changes:

- add `ReserveDisplayBadgeKind`
- add a small API/view payload, for example:
  - `kind`
  - `label`
  - optional `description`

Recommended API shape:

```ts
interface ReserveDisplayBadgeView {
  kind: "live" | "curated-validated" | "proof";
  label: string;
}
```

Add this to `StablecoinReservesResponse`.

### 2. Extend the adapter registry with display semantics

Files:

- `shared/lib/live-reserve-adapters.ts`

Changes:

- add `displayBadgeKind` to `LIVE_RESERVE_ADAPTER_DEFINITIONS`
- keep this orthogonal to `sourceModel` and `evidenceClass`

Reason:

- one central source of truth
- avoids frontend-side allowlists
- keeps future adapter additions honest by construction

### 3. Build the badge view in the worker

Files:

- `worker/src/lib/live-reserves-store-parsing.ts`
- `worker/src/lib/live-reserves-store-view.ts`
- possibly `worker/src/api/stablecoin-reserves.ts`

Changes:

- derive a `displayBadge` from the stored snapshot source / adapter
- attach it only for authoritative `live` / `live-stale` responses
- keep fallback responses without a badge

Recommended rule:

- if response mode is `live` or `live-stale`, include `displayBadge`
- if response is `curated-fallback`, `template-fallback`, or `unavailable`, omit it

### 4. Update the detail-page badge rendering

Files:

- `src/components/stablecoin-detail/overview-section.tsx`
- `src/components/reserve-treemap.tsx`
- `src/hooks/use-stablecoin-reserves.ts`

Changes:

- replace `isLive={!!reserves.liveAt}` with a badge prop derived from `reserves.displayBadge`
- update the treemap header to render the label text from the API instead of a boolean `Live`
- keep the visual style consistent with the current pill treatment

Recommended component shape:

```ts
interface ReserveTreemapProps {
  reserves: ReserveSlice[];
  badge?: {
    label: string;
    kind: "live" | "curated-validated" | "proof";
  };
}
```

### 5. Harmonize nearby copy so the badge and the note do not contradict each other

Files:

- `src/components/stablecoin-detail/overview-section.tsx`

Changes:

- keep the provenance notice block
- review footer copy under the chart so it does not implicitly restate everything as live composition

Recommended copy direction:

- `Live`: `Updated Apr 3 ...`
- `Curated-Validated`: `Curated-validated as of Apr 3 ...`
- `Proof`: `Proof refreshed Apr 3 ...`

Minimal first pass:

- leave the footer timestamp wording unchanged
- only change the headline pill

Better first pass:

- change the timestamp prefix to match the badge class

### 6. Update docs

Files:

- `docs/live-reserves.md`
- `docs/api-reference.md`

Changes:

- document the new badge field and semantics
- explicitly clarify that:
  - `mode` is transport/freshness state
  - `displayBadge` is user-facing evidence labeling
- list the current badge classes and their meaning

Optional note:

- add one sentence to `docs/coverage-page.md` if we want to clarify that coverage-page `Live` remains a structural feature-coverage label and is not yet the stricter detail-page truth label

## Testing Plan

### API and worker

Files:

- `worker/src/api/__tests__/stablecoin-reserves.test.ts`
- `worker/src/lib/__tests__/live-reserves-store.test.ts`

Add cases for:

- independent live adapter returns `displayBadge.kind = "live"`
- curated-validated snapshot returns `displayBadge.kind = "curated-validated"`
- single-asset / tether snapshot returns `displayBadge.kind = "proof"`
- fallback responses omit `displayBadge`

### Frontend

Files:

- `src/components/__tests__/overview-section.test.tsx`
- `src/hooks/__tests__/use-stablecoin-reserves.test.tsx`
- add a small focused test for `src/components/reserve-treemap.tsx` if needed

Add cases for:

- `Live` pill renders for true live feeds
- `Curated-Validated` pill renders for curated-validated / frax
- `Proof` pill renders for single-asset / tether
- existing provenance notice still renders correctly underneath

## Validation Commands

For the implementation PR:

```bash
npm test -- worker/src/api/__tests__/stablecoin-reserves.test.ts
npm test -- worker/src/lib/__tests__/live-reserves-store.test.ts
npm test -- src/components/__tests__/overview-section.test.tsx
npm test -- src/hooks/__tests__/use-stablecoin-reserves.test.tsx
npm run lint
npm run build
npm test
npm run test:merge-gate
```

## Scope Recommendation

### In scope for the first pass

- detail-page reserve badge
- shared/API badge semantics
- docs and tests

### Out of scope for the first pass

- changing reserve scoring behavior
- changing `/status`
- changing coverage-page structural `Live Reserves Sync` headline logic
- changing stored D1 schema

No migration should be needed. This is a response-shape + frontend-display change.

## Risks

### Risk 1: future adapter additions regress into dishonest labels

Mitigation:

- make `displayBadgeKind` required in the registry
- add a small invariant test that every adapter definition has one

### Risk 2: badge and provenance note drift apart

Mitigation:

- keep both derived from the same authoritative worker response
- do not re-derive badge semantics in the frontend

### Risk 3: `single-asset` may eventually split into honest-live and proof-only subfamilies

Mitigation:

- keep the initial implementation adapter-level
- if a mixed family appears later, promote the rule to a small resolver function keyed by adapter + config

## Recommended Execution Order

1. Add shared badge types and adapter-registry metadata.
2. Build worker-side `displayBadge` derivation and API serialization.
3. Update frontend hook and reserve-card rendering.
4. Update docs.
5. Run targeted tests, then full validation.
