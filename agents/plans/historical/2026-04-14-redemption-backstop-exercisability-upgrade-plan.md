# Redemption Backstop Exercisability Upgrade Plan - 2026-04-14

## Goal

Prevent the redemption backstop module from showing a strong par-exit backstop when live market/depeg evidence says that route is not currently broadly exercisable, without adding a USR-only score override.

The USR case should be fixed by the same general rule that would apply to any future severe active depeg with a stale/static redemption model.

## Non-Goals

- Do not lower `usr-resolv` by changing its static capacity ratio from `0.1`.
- Do not add a one-off `totalScoreCap` to `usr-resolv`.
- Do not add a D1 migration. Store new fields in `details_json` and keep old rows wire-compatible.
- Do not audit and reclassify every `stablecoin-redeem` route in this change. Add the model hooks and fail-safe gate first; route-by-route legal/access audits can follow with narrower evidence reviews.
- Do not make redemption cron fetch external web sources. Use existing D1 state and curated config only.

## Evidence Summary

Live Pharos production checks on 2026-04-14:

- `usr-resolv` redemption backstop: `score=82`, `effectiveExitScore=85`, `dexLiquidityScore=33`, `resolutionState=resolved`, `modelConfidence=medium`, `capacityConfidence=documented-bound`.
- `usr-resolv` peg summary: `activeDepeg=true`, `currentDeviationBps=-8332`, `pegScore=0`, with CoinGecko, DefiLlama list, Pyth, and DEX-promoted evidence agreeing.
- Active depeg row: started `2026-03-22 02:04:57 UTC`, peak deviation `-9025 bps`, peak price about `$0.0975`.
- Current severe active depegs with `abs(currentDeviationBps) >= 2500`: `usr-resolv` and `susd-synthetix`; only USR has a high medium-confidence redemption uplift.

Primary external checks:

- Resolv postmortem dated 2026-04-04 says the March 22 incident minted 80M illicit USR, extracted about $25M in ETH, paused most protocol operations, neutralized about 46M illicit USR, and limited 1:1 compensation language to pre-hack USR holders while evaluating others.
- Resolv site still displays an incident notice.
- Resolv Terms of Service say direct redemption requires verified RDAL customer status, may take several business days, and may be delayed or suspended.
- CoinGecko shows USR trading around `$0.16-$0.17` with an exploit notice.

## Root Cause

The current module scores static route capability. It does not model current exercisability.

For `usr-resolv`, `stablecoinRedeemBase` supplies:

- access `permissionless-onchain` -> `100`
- settlement `atomic` -> `100`
- execution `deterministic-onchain` -> `100`
- output `stable-single` -> `100`

The static 10% documented capacity ratio scores capacity at `53`, and unknown fee scores cost at `40`, so the weighted score is:

```text
100*0.20 + 100*0.15 + 100*0.15 + 53*0.25 + 100*0.15 + 40*0.10 = 82.25 -> 82
```

The effective-exit best-path formula then turns DEX `33` plus redemption `82` into `85`.

That is mechanically consistent with the current code, but wrong when a severe active depeg indicates that the route is not available to generic holders at par.

## Design Decision

Add a redemption-route exercisability layer and a severe-active-depeg contradiction gate.

For this implementation, a redemption route is treated as current-scoreable only when:

1. Static/runtime capacity and cost resolution still produce a normal score; and
2. The route is not currently impaired by a severe active depeg, unless it has strong live direct evidence of permissionless immediate redemption.

The severe threshold is `2500 bps`, matching the existing Safety Score F-cap threshold. This keeps the backstop module aligned with the already-documented definition of a severe active depeg.

### Strong Live-Direct Exception

Do not automatically impair a route during a severe active depeg when all of these are true:

- `capacityConfidence === "live-direct"`
- `sourceMode === "dynamic"`
- `accessModel === "permissionless-onchain"`
- `settlementModel === "atomic" || settlementModel === "immediate"`

Rationale: a genuinely live, direct, permissionless, immediate on-chain redemption route may still be useful during market dislocations. Static documented-bound routes, live-proxy routes, issuer/API routes, queue routes, and estimated supply-ratio routes should fail closed under severe active depeg contradiction.

USR does not qualify for this exception: it is `documented-bound`, `estimated`, and `supply-ratio-model`.

## Data Model Changes

Update `shared/types/redemption.ts`:

1. Add `impaired` to `RedemptionResolutionStateSchema`.
   - Meaning: static route inputs were configured/resolved enough to know the route shape, but current route availability contradicts normal scoring.
   - `impaired` rows have `score = null`, `effectiveExitScore = null`, and `modelConfidence = "low"`.

2. Add `RedemptionRouteStatusSchema`:

```ts
z.enum(["open", "degraded", "paused", "cohort-limited", "unknown"])
```

3. Add `RedemptionRouteStatusSourceSchema`:

```ts
z.enum(["static-config", "market-implied", "operator-notice", "protocol-api", "onchain"])
```

4. Add `RedemptionHolderEligibilitySchema`:

```ts
z.enum([
  "any-holder",
  "verified-customer",
  "whitelisted-primary",
  "pre-incident-holder",
  "issuer-discretionary",
  "unknown",
])
```

5. Extend `RedemptionBackstopEntrySchema` with:

```ts
routeStatus: RedemptionRouteStatusSchema.optional().default("unknown")
routeStatusSource: RedemptionRouteStatusSourceSchema.optional().default("static-config")
routeStatusReason: z.string().optional()
routeStatusReviewedAt: z.string().optional()
holderEligibility: RedemptionHolderEligibilitySchema.optional().default("unknown")
```

Wire compatibility:

- Old D1 rows missing these fields parse as `routeStatus="unknown"` and `holderEligibility="unknown"`.
- New generated rows should set `routeStatus="open"` for normal resolved routes and `routeStatus="unknown"` for unresolved capacity failures.

## Config Changes

Update `shared/lib/redemption-backstop-configs/shared.ts`:

- Add optional config fields:

```ts
holderEligibility?: RedemptionHolderEligibility
routeStatus?: Extract<RedemptionRouteStatus, "open" | "unknown">
```

- Add helper `resolveDefaultHolderEligibility(config)`:
  - `permissionless-onchain` -> `any-holder`
  - `whitelisted-onchain` -> `whitelisted-primary`
  - `issuer-api` -> `verified-customer`
  - `manual` -> `issuer-discretionary`

No route-specific config edits are required for this first pass. USR is caught by the severe-active-depeg contradiction gate.

## Runtime Route Availability

Add `worker/src/lib/redemption-backstop-availability.ts`:

```ts
export const REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS = 2500;

export interface RedemptionRouteAvailability {
  routeStatus: "degraded";
  routeStatusSource: "market-implied";
  routeStatusReason: string;
  routeStatusReviewedAt: string; // YYYY-MM-DD UTC of sync time
  activeDepegBps: number;
  activeDepegStartedAt: number;
}

export async function loadSevereActiveDepegAvailabilityMap(
  db: D1Database,
  reviewedAt: string,
): Promise<Map<string, RedemptionRouteAvailability>>
```

Implementation detail:

- Query `depeg_events`:

```sql
SELECT stablecoin_id, peak_deviation_bps, started_at
FROM depeg_events
WHERE ended_at IS NULL
```

- In TypeScript, filter rows with `Math.abs(peak_deviation_bps) >= REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS`.
- Reason text:

```text
Active severe depeg of ${absBps} bps started ${YYYY-MM-DD}; static redemption route requires current live-open evidence before it can score.
```

Why peak deviation rather than current deviation in redemption cron:

- `depeg_events` is cheap and already in D1.
- `currentDeviationBps` is derived in peg analytics from live price cache; report cards will add a second current-deviation defense.
- Open severe rows should be retired by depeg recovery logic when recovered.

If the query fails:

- Do not silently continue as healthy.
- Throw on unexpected availability query failure. The table is baseline schema, so failure indicates a real runtime issue and stale previous rows are safer than fresh wrong rows.

## Redemption Entry Build Changes

Update `worker/src/lib/redemption-backstop-sources.ts`:

1. Extend `RedemptionBackstopBuildOptions`:

```ts
routeAvailability?: RedemptionRouteAvailability | null
```

2. Build the normal `baseScore` as today.

3. Determine default route metadata:

```ts
const holderEligibility =
  config.holderEligibility ?? resolveDefaultHolderEligibility(config);
const defaultRouteStatus =
  resolutionState === "resolved" ? (config.routeStatus ?? "open") : "unknown";
const defaultRouteStatusSource = "static-config";
```

4. Apply severe-depeg impairment after the normal score is computed:

```ts
const hasStrongLiveDirectRoute =
  capacity.capacityConfidence === "live-direct" &&
  capacity.sourceMode === "dynamic" &&
  config.accessModel === "permissionless-onchain" &&
  (config.settlementModel === "atomic" || config.settlementModel === "immediate");

const availability = options.routeAvailability;
const routeImpaired =
  resolutionState === "resolved" &&
  availability != null &&
  !hasStrongLiveDirectRoute;
```

5. If `routeImpaired`:

- `score = null`
- `effectiveExitScore = null`
- `resolutionState = "impaired"`
- `routeStatus = availability.routeStatus` (`degraded`)
- `routeStatusSource = "market-implied"`
- `routeStatusReason = availability.routeStatusReason`
- `routeStatusReviewedAt = availability.routeStatusReviewedAt`
- `modelConfidence = "low"`
- Append note with the same reason text
- Append cap `market-implied-depeg-impairment`

6. If not impaired:

- Preserve current scoring.
- Set `routeStatus` and `holderEligibility` as above.

## Redemption Cron Changes

Update `worker/src/cron/sync-redemption-backstops.ts`:

- Before the loop, call `loadSevereActiveDepegAvailabilityMap(db, todayUtc)`.
- Pass `routeAvailability: availabilityMap.get(stablecoinId) ?? null` into both `resolveRedemptionBackstopEntry` and `buildRedemptionBackstopEntry`.
- Add cron metadata:

```json
{
  "availabilityDegraded": <count>,
  "availabilityDegradedIds": ["usr-resolv"],
  "severeActiveDepegThresholdBps": 2500
}
```

- `availabilityDegraded` and `availabilityDegradedIds` are derived from built snapshots where `resolutionState === "impaired"`, not merely from the active-depeg availability input map. This prevents a strong live-direct exception from reporting a degradation it did not apply.
- `impaired` counts as unresolved for `coverageRatio`, because it is not a usable current score.
- Cron status should be `degraded` when `availabilityDegraded > 0`. This is intentional: the module is publishing current data, but at least one configured route is impaired by market evidence.

## Store/API Changes

Update `worker/src/lib/redemption-backstops-store.ts`:

- Extend `RedemptionBackstopDetails` with:
  - `routeStatus`
  - `routeStatusSource`
  - `routeStatusReason`
  - `routeStatusReviewedAt`
  - `holderEligibility`
- `pickValidDetails()` should accept only strings for these fields.
- `toEntry()` defaults:
  - `routeStatus = details.routeStatus ?? "unknown"`
  - `routeStatusSource = details.routeStatusSource ?? "static-config"`
  - `holderEligibility = details.holderEligibility ?? "unknown"`
- `buildDetailsJson()` writes all new fields.

No SQL column changes.

## Report-Card Liquidity Changes

Update `shared/lib/report-card-peg-liquidity.ts`:

1. Export helper:

```ts
export function isRedemptionEligibleForLiquidity(
  redemption: Pick<
    RedemptionBackstopEntry,
    | "score"
    | "resolutionState"
    | "modelConfidence"
    | "routeStatus"
    | "capacityConfidence"
    | "sourceMode"
    | "accessModel"
    | "settlementModel"
  > | undefined,
  options?: { activeDepegBps?: number | null },
): boolean
```

2. Normal eligibility:

- `resolutionState === "resolved"`
- `score !== null`
- `modelConfidence !== "low"`
- `routeStatus !== "degraded" && routeStatus !== "paused" && routeStatus !== "cohort-limited"`

3. Severe active depeg defense:

If `activeDepegBps >= 2500`, eligibility is false unless the redemption route has the same strong live-direct attributes:

- `capacityConfidence === "live-direct"`
- `sourceMode === "dynamic"`
- `accessModel === "permissionless-onchain"`
- `settlementModel === "atomic" || "immediate"`

This catches stale old redemption rows even before the next redemption cron writes `routeStatus="degraded"`.

4. Update `scoreLiquidity(liq, redemption, options)` to use the helper.

5. Add detail text:

- If excluded by `routeStatus`: `not used for Safety Score uplift (route currently ${routeStatus})`
- If excluded by severe depeg contradiction: `not used for Safety Score uplift (active severe depeg requires live-open redemption evidence)`
- If excluded by low confidence: keep existing low-confidence copy.
- If the redemption route is configured and `resolutionState === "impaired"` while DEX liquidity still provides a score, append `Redemption route configured but currently impaired` plus the route-status reason when present. This keeps the liquidity detail from silently omitting the impaired backstop after `score` becomes `null`.

Update `worker/src/lib/report-cards-snapshot.ts`:

- Use `isRedemptionEligibleForLiquidity(redemption, { activeDepegBps })` for `rawInputs.redemptionUsedForLiquidity`.
- Pass `{ activeDepegBps }` to `scoreLiquidity`.
- Leave `RawDimensionInputs` unchanged in this pass, so dead-card raw inputs do not need new fields.

Do not add new report-card raw inputs in this pass. `redemptionUsedForLiquidity` plus detail text is enough.

## Frontend Changes

Update `src/components/stablecoin-detail/redemption-backstop-card.tsx`:

- `formatResolutionState()` handles `"impaired"`.
- Add `formatRouteStatus()`:
  - `open` -> `open`
  - `degraded` -> `degraded`
  - `paused` -> `paused`
  - `cohort-limited` -> `cohort limited`
  - `unknown` -> `status unknown`
- Show a status badge when `entry.routeStatus !== "open"`.
- `getResolutionSummary()` for `impaired`:

```text
This route is configured, but current market or route-availability evidence contradicts broad par redemption. Pharos excludes it from current redemption scoring until live-open evidence returns.
```

- If `routeStatusReason` exists, show it in the summary/notes area.
- The hero badge should already show `NR` when `score === null`.

Update `src/components/report-card.tsx`:

- Existing `(not used)` suffix only appears for low confidence. Change to append `(not used)` whenever `!redemptionUsedForLiquidity`, and rely on dimension detail for why.

Update coverage:

- `src/lib/coverage.ts` should treat entries with `resolutionState === "impaired"` or `routeStatus` in `degraded|paused|cohort-limited` as unavailable coverage, not strong redemption coverage.

## Methodology + Docs Changes

Update docs because this changes redemption backstop and report-card liquidity behavior.

1. `shared/lib/redemption-backstop-version.ts`
   - bump `currentVersion` from `3.7` to `3.8`
   - use `effectiveAt: 1776124800` (`2026-04-14T00:00:00Z`)
   - add entry:
     - title: `Active-depeg exercisability gate`
     - date: `2026-04-14`
     - impact:
       - severe active depegs (`>=2500 bps`) now mark static/non-live-direct redemption routes as impaired
       - impaired routes keep their route metadata visible but do not publish a current score/effective-exit uplift
       - live-direct permissionless immediate routes can remain scoreable during depegs

2. `docs/redemption-backstops.md`
   - current version to `v3.8`
   - add route availability/exercisability section
   - document `routeStatus`, `holderEligibility`, `impaired`, and the `2500 bps` severe active depeg gate
   - document that impaired rows are not usable coverage and push cron to degraded status

3. `shared/lib/safety-score-version-data.ts`
   - bump Safety Score from `6.95` to `6.96`
   - use `effectiveAt: 1776124800` (`2026-04-14T00:00:00Z`)
   - add entry for redemption uplift severe-depeg gate

4. `docs/report-cards.md`
   - current version to `v6.96`
   - update Liquidity / Exit Details:
     - redemption uplift needs resolved, non-low-confidence, non-impaired route
     - severe active depegs require live-direct permissionless immediate evidence before redemption can uplift liquidity

5. `docs/report-cards-timeline.md`
   - add `v6.96` entry.

6. `src/app/methodology/sections/core/safety-scores-section.tsx`
   - update the redemption/effective-exit paragraph to mention the active-depeg exercisability gate.

7. `src/app/methodology/scoring-changelog/content-v7-0.tsx`
   - add `ScoringChangelogV696Entry`.
   - Import/render it before v6.95 in `content-v6.tsx`.

8. `src/app/methodology/page.tsx`
   - Update the Safety Score FAQ answer so it no longer implies that any non-low-confidence redemption backstop can always contribute to Liquidity / Exit. Add a short clause that severe active depegs can disable redemption uplift unless live-open redemption evidence exists.

9. `docs/api-reference.md`
   - Add a concise paragraph under the `/api/redemption-backstops` endpoint section documenting the new `routeStatus`, `routeStatusSource`, `routeStatusReason`, `routeStatusReviewedAt`, and `holderEligibility` fields.

## Tests

Add/update tests:

1. `shared/lib/__tests__/report-cards.test.ts`
   - severe active depeg + medium static redemption -> DEX-only score and detail says not used due active severe depeg.
   - severe active depeg + live-direct permissionless atomic redemption -> redemption can still uplift.
   - routeStatus degraded -> no redemption uplift.
   - routeStatus unknown + no severe depeg -> current behavior preserved.

2. `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
   - routeAvailability severe active depeg turns a static documented route into `resolutionState="impaired"`, `score=null`, `effectiveExitScore=null`, `routeStatus="degraded"`, `modelConfidence="low"`, and note/cap present.
   - strong live-direct route is not impaired.

3. `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
   - active severe depeg map is loaded and passed to entry builders.
   - cron metadata includes `availabilityDegraded` and status `degraded` when an impaired entry is produced.

4. `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
   - round-trip new details fields.
   - malformed/missing details defaults remain wire-compatible.

5. `src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`
   - impaired route renders `NR`, degraded badge/reason, and impairment summary.

6. `src/lib/__tests__/coverage.test.ts`
   - impaired route does not count as strong redemption coverage.

## Validation Commands

Targeted first:

```bash
npm test -- --run redemption-backstop
npm test -- --run report-cards
npm test -- --run coverage
npm test -- --run redemption-backstop-card
npm run check:redemption-backstops
npm run check:doc-sync
```

Then run:

```bash
npm run lint
npm test
```

Because worker files are part of this plan, run:

```bash
cd worker && npx tsc --noEmit
```

Final validation for this turn:

```bash
npm run test:merge-gate
```

If the merge gate is blocked by an unrelated pre-existing issue, capture the failing command and reason in the final response instead of claiming full validation. Do not skip merge-gate for time reasons.

## Plan Review Loop

- Pass 1 findings: removed speculative availability-query fallback wording; replaced an ellipsis in the report-card helper contract with the exact `Pick` field list; clarified that cron degradation is based on actually impaired rows; required liquidity detail text for impaired routes whose score is null; fixed methodology version effective timestamps; made the methodology FAQ update explicit; required merge-gate validation or a concrete blocker report.
- Pass 2 findings: removed the remaining conditional API-doc and validation wording; locked report-card raw inputs as unchanged for this pass; made worker typecheck and merge-gate mandatory unless blocked by a concrete unrelated failure.

## Expected Production Behavior After Next Cron

For `usr-resolv` while the severe active depeg remains open:

- `/api/redemption-backstops.coins["usr-resolv"].resolutionState` -> `impaired`
- `score` -> `null`
- `effectiveExitScore` -> `null`
- `routeStatus` -> `degraded`
- `routeStatusSource` -> `market-implied`
- `modelConfidence` -> `low`
- Stablecoin detail Redemption Backstop card shows `NR` plus a degraded/impaired explanation.
- Report-card Liquidity / Exit uses DEX liquidity only (`33`, subject to normal DEX availability), not the prior redemption `82`.
- Overall grade remains `F` because peg score is already `0`, but the misleading `A` liquidity sub-dimension disappears.

For non-severely-depegged assets:

- Normal redemption backstop scoring is unchanged except for additional metadata fields.

For a future severely-depegged asset with strong live-direct permissionless immediate redemption evidence:

- The route can remain scoreable, but the burden shifts to live direct evidence rather than static docs.
