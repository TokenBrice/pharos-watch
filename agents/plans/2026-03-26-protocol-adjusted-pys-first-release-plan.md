# Protocol-Adjusted PYS First-Release Plan

Date: 2026-03-26

## Executive Summary

The first release should be additive, conservative, and easy to unwind:

- keep the existing `pharosYieldScore` unchanged and keep it as the default ranking/sort metric
- add a new secondary metric, `protocolAdjustedPys`, computed from the existing PYS formula but with a protocol-capped effective safety input
- use `Exponential` as the sole external protocol-risk provider for v1
- compute protocol-adjusted values at `GET /api/yield-rankings` read time, not inside the hourly publisher
- persist first-class protocol identity now so future protocol-risk work does not depend on brittle re-derivation
- treat missing protocol coverage as `missing`, not as implied safety

This resolves the blindspot without turning the hourly yield pipeline into a second external-risk fetcher and without changing the headline Yield Intelligence methodology before coverage is good enough.

## Why This Shape Fits The Current Codebase

The current implementation already has the right seam for a low-risk v1:

- `worker/src/api/cache-handlers.ts` already rehydrates `safetyScore`, `safetyGrade`, `yieldToRisk`, and `pharosYieldScore` at API read time from live report-card inputs
- `shared/lib/yield-scoring.ts` centralizes the PYS math, so a second score variant can reuse the same formula
- `worker/src/cron/sync-yield-supplemental.ts` is already the slow-lane cache job for optional yield inputs, making it the right place to sync protocol-risk snapshots without blocking the hourly publisher
- `worker/src/cron/yield-sync/types.ts` already carries transient protocol hints via `ResolvedYield.project`, but that identity is dropped before persistence and publication

The weakest part of the current stack is identity, not scoring. The first release therefore needs to solve protocol identity and protocol-risk ingestion first, then score hydration on top.

## Recommended Product Scope For Release 1

### Goals

- expose protocol risk as a first-class concept on yield rows
- publish `protocolAdjustedPys` as a beta metric next to existing PYS
- show provenance, freshness, and coverage status for the protocol-risk input
- avoid manual Pharos protocol scoring
- fail open when protocol-risk data is unavailable

### Non-goals

- do not replace `pharosYieldScore`
- do not change default `/yield` sorting
- do not change `is_best` source arbitration
- do not change `yield_history` charts to a protocol-adjusted time series
- do not implement pool-level or tranche-level risk matching yet
- do not blend multiple external providers yet
- do not synthesize a house protocol score from audits / hacks / bounties / TVL

## External Source Decision

### Provider choice for v1

Use `Exponential` only.

Why:

- strongest semantic fit to the actual blindspot
- structured public protocol directory exists
- protocol detail pages expose protocol-level risk labels and pool cards
- entries include `defi_llama_id`, which is the cleanest join path into the current Pharos yield universe

### Explicit gate before implementation

Before merging the production integration, confirm one of:

- Exponential is comfortable with this use of its public data, or
- the team is willing to accept a public-site structured-data dependency for the beta release

If that gate fails, do not ship a disguised fallback. The next-best fallback is a smaller-scope `DeFiSafety` integration with curated mappings, not a Pharos-invented protocol score.

## Core Release Decision

### The score model

Release `protocolAdjustedPys` as:

```ts
effectiveSafetyScore = min(assetSafetyScore, mappedProtocolSafetyScore)

protocolAdjustedPys = computePYS({
  apy30d,
  safetyScore: effectiveSafetyScore,
  apyVarianceScore,
  scalingFactor,
})
```

Rationale:

- it preserves the existing PYS curve and scaling
- it is conservative
- it avoids inventing a weighted blend between unrelated methodologies
- it makes the interpretation obvious: a venue cannot make an asset look safer than the venue itself

### Behavior when protocol risk is missing

For v1:

- `protocolAdjustedPys = null`
- keep `pharosYieldScore` as-is
- expose `protocolRisk.status = "missing"` or equivalent coverage metadata

Do not silently fall back to base PYS under the `protocolAdjustedPys` field. That would erase the distinction between "covered and unchanged" versus "not covered."

## Recommended Data Model

### 1. Canonical protocol identity

Introduce a shared protocol identity object for yield rows.

Suggested shape:

```ts
interface YieldProtocolIdentity {
  key: string;
  name: string;
  defillamaSlug?: string | null;
  defillamaId?: number | null;
  identitySource: "defillama-project" | "yield-config" | "manual-map" | "derived";
}
```

Important decision:

- use a Pharos canonical `protocol.key`
- prefer the DeFiLlama slug when known
- also carry `defillamaId` when known because Exponential matching is strongest on that field

### 2. Protocol-risk payload

Suggested read-time field on yield rows:

```ts
interface YieldProtocolRisk {
  provider: "exponential";
  providerLabel: string | null;
  mappedSafetyScore: number | null;
  mappedSafetyGrade: ReportCardGrade | null;
  coverageMode: "exact-id" | "exact-key" | "alias" | "manual-map" | "missing";
  sourceUrl: string | null;
  observedAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
}
```

### 3. Protocol-adjusted score payload

Suggested row field:

```ts
interface YieldProtocolAdjustedScore {
  effectiveSafetyScore: number | null;
  effectiveSafetyGrade: ReportCardGrade | null;
  protocolAdjustedPys: number | null;
  protocolAdjustedYieldToRisk: number | null;
}
```

Notes:

- keep `safetyScore` and `safetyGrade` as asset-level issuer safety only
- do not overload those fields with protocol-adjusted values
- `protocolAdjustedYieldToRisk` is optional for UI v1, but worth returning for consistency with the existing model

## Schema Changes

### D1 migration

Create a new migration after `0080_live_reserve_attempt_fencing.sql`.

Recommended migration name:

- `0081_yield_protocol_identity.sql`

Recommended columns on `yield_data`:

- `protocol_key TEXT`
- `protocol_name TEXT`
- `protocol_defillama_slug TEXT`
- `protocol_defillama_id INTEGER`
- `protocol_identity_source TEXT`

Recommended columns on `yield_history`:

- `protocol_key TEXT`
- `protocol_name TEXT`
- `protocol_defillama_slug TEXT`
- `protocol_defillama_id INTEGER`
- `protocol_identity_source TEXT`

Why both tables now:

- `yield_data` is required for the current API
- `yield_history` is not required for v1 scoring, but adding the identity now prevents a second schema migration when protocol-aware history or audits arrive later

Backfill expectations:

- no special history backfill required for v1
- current rows will repopulate within one hourly yield sync
- historical rows remain null before deployment time, which is acceptable because protocol-adjusted history is out of scope

## Identity Plumbing Plan

### 1. Extend runtime types

Files:

- `worker/src/cron/yield-sync/types.ts`
- `shared/types/yield.ts`

Actions:

- add `protocol` to `ResolvedYield`
- add `protocol` to published ranking rows
- optionally add `protocol` to `AltYieldSource` so alt sources can be compared later without another response-shape change

### 2. Populate identity from source families

#### DeFiLlama and DeFiLlama-auto sources

Use existing DL project metadata:

- `ResolvedYield.project` already exists
- map `project` slug to human label via existing `LENDING_PROTOCOL_LABELS` when available
- enrich with `defillamaId` using a small protocol-directory lookup during the protocol-risk sync

#### Protocol API sources

Extend source builders and config to emit explicit protocol identity.

Examples:

- BIMA savings -> `bima`
- Hashnote -> `hashnote`
- Ondo USDY / OUSG adapters -> `ondo-finance`
- Morpho API -> `morpho`
- Pendle API -> `pendle`

#### Deterministic on-chain sources

Explicitly configure protocol identity in `yield-config.ts`.

Examples:

- `sdai-maker` -> `makerdao` or `spark-savings`, depending on the actual yield venue represented by the source row
- vault wrappers should identify the protocol realizing the yield, not merely the issuer symbol

#### Price-derived and rate-derived sources

Treat these carefully.

Recommendation for v1:

- allow protocol identity only where there is an obvious issuer/protocol target and a realistic external match
- otherwise leave protocol identity null and let `protocolAdjustedPys` remain null

This avoids pretending that a benchmark-derived treasury proxy has an externally scored protocol venue when it does not.

### 3. Centralize mapping config

Do not scatter protocol identities across random helpers.

Recommended new shared config surface:

- `worker/src/cron/yield-protocol-risk/config.ts`

Suggested responsibilities:

- canonical protocol identities for non-DL sources
- alias map from Pharos protocol keys to Exponential protocol slugs or IDs
- raw provider-label to Pharos numeric-score mapping

## Protocol-Risk Snapshot Architecture

### Cache key

Add a new cache entry:

- `yield:protocol-risk:v1`

Do not overload `yield:supplemental-sources:v1`.

Reason:

- different schema
- different consumers
- easier cache validation and independent degradation handling

### Owning cron

Use `sync-yield-supplemental` to write the new snapshot.

Reason:

- it already runs on the slower optional-input lane
- protocol risk is not an hourly freshness dependency
- it keeps the main publisher isolated from provider fetch failures

### Suggested snapshot shape

```ts
interface YieldProtocolRiskSnapshot {
  provider: "exponential";
  updatedAt: number;
  providerUpdatedAt?: number | null;
  protocols: Record<string, {
    protocolKey: string;
    protocolName: string;
    defillamaSlug?: string | null;
    defillamaId?: number | null;
    providerProtocolSlug?: string | null;
    providerProtocolId?: string | null;
    providerLabel: string | null;
    mappedSafetyScore: number | null;
    mappedSafetyGrade: ReportCardGrade | null;
    sourceUrl: string | null;
    observedAt: number | null;
    coverageMode: "exact-id" | "exact-key" | "alias" | "manual-map";
  }>;
  coverage: {
    matchedProtocols: number;
    exactIdMatches: number;
    aliasMatches: number;
    totalKnownProtocols: number;
    reason: string | null;
  };
}
```

### Fetch sequence

Recommended v1 fetch flow:

1. fetch Exponential protocol directory
2. build a matched protocol set against the currently active Pharos yield protocol universe
3. fetch detail JSON only for matched protocols to read protocol-level risk labels
4. normalize into the snapshot cache
5. retain the previous snapshot when the new fetch is malformed or empty

Reason for detail fetches:

- the directory appears to carry identity and metadata
- protocol-level risk labels live on the detail page payloads
- fetching only matched protocols limits budget and reduces provider stress

### Freshness policy

Recommended freshness thresholds:

- refresh every 4 hours via the existing supplemental cron cadence
- treat `> 24h` as stale in API metadata
- continue serving last-known-good snapshot until `48h`
- after `48h`, keep serving it but mark top-level provenance as degraded and row-level `protocolRisk.stale = true`

Missing or stale protocol-risk data must not block `/api/yield-rankings`.

## Exponential Normalization Strategy

### Raw-to-Pharos mapping

Do not hardcode score math inline in the fetcher.

Use a config map from raw Exponential protocol label to a conservative Pharos-equivalent floor score, then derive the grade via shared grade helpers.

Recommended initial policy:

- map to the lower bound of the analogous Pharos grade band, not the midpoint
- keep the raw provider label on the row for transparency
- store the mapping in config so it can be adjusted without another schema change

Illustrative starting point:

- `Best -> 87`
- `Good -> 80`
- `Average -> 65`
- `Low -> 50`
- `Poor -> 40`

This exact table should be finalized only after a live label census across the matched set, but the policy should be conservative floors, not optimistic midpoints.

### Why not use pool-level risk in v1

Do not use Exponential pool grades in the first release.

Reasons:

- Pharos source rows currently identify pools via DeFiLlama pool UUIDs or protocol-specific source keys, not Exponential pool IDs
- the mapping problem is harder than protocol-level matching
- pool-level matching increases the chance of false precision on launch

Protocol-level risk already closes the biggest blindspot.

## Read-Time Hydration Plan

### Where to compute the new fields

Implement in `worker/src/api/cache-handlers.ts`, alongside the existing live safety hydration.

Suggested flow for `handleYieldRankings`:

1. read cached `yield-rankings`
2. validate against `YieldRankingsResponseSchema`
3. build live report-card snapshot
4. load `yield:protocol-risk:v1`
5. for each row:
   - hydrate live asset safety as today
   - attach `protocol` identity from cached row
   - look up protocol-risk snapshot by `defillamaId`, then `protocol.key`, then alias map
   - compute `protocolAdjustedPys` when a mapped protocol score exists
   - compute `protocolAdjustedYieldToRisk` from the same effective safety input
6. attach top-level protocol-risk snapshot provenance
7. return the enriched payload

### Why read-time instead of write-time

Read-time is better because:

- protocol-risk freshness is not tied to the hourly yield run
- a protocol-risk provider failure cannot poison the published rankings cache
- the same live-hydration pattern already exists for safety
- methodology iteration is easier because cached APY inputs stay stable

### Important sorting decision

For v1:

- do not re-sort rankings by `protocolAdjustedPys` in the API
- keep existing order semantics tied to `pharosYieldScore`

The frontend can optionally expose adjusted-score sorting later, but the first release should not silently reorder the product around a beta metric.

## API Surface Changes

### Shared types

Update `shared/types/yield.ts`:

- add `protocol?: YieldProtocolIdentity | null`
- add `protocolRisk?: YieldProtocolRisk | null`
- add `protocolAdjusted?: YieldProtocolAdjustedScore | null`
- add matching optional fields to `AltYieldSource` if we want API symmetry now
- add top-level provenance block for protocol-risk snapshot freshness and coverage

Suggested top-level provenance extension:

```ts
protocolRiskSnapshot?: {
  provider: "exponential";
  kind: "ok" | "degraded" | "missing";
  coverageRatio: number;
  coveredCount: number;
  trackedCount: number;
  updatedAt: number | null;
  ageSeconds: number | null;
  reason: string | null;
}
```

### Response semantics

Important contract decisions:

- `pharosYieldScore` remains the canonical current PYS
- `protocolAdjusted.protocolAdjustedPys` is beta and nullable
- `safetyScore` remains asset-level safety only
- `protocolRisk` is provider-derived and may be stale or missing

## Frontend Release Plan

### First-release UI recommendation

Keep the UI additive and explicit.

Recommended surfaces:

#### Yield leaderboard

- keep the visible `PYS` column unchanged
- add protocol-risk information in the expanded row, not a new always-visible wide column
- optionally show a compact `Adj. PYS (beta)` line inside the expanded section when available
- optionally add a protocol-risk badge or label next to the source block in the expanded row

Reason:

- the leaderboard is already width-constrained
- a beta metric should not dominate the default scan path

#### Stablecoin detail page

- add a new `Adj. PYS (beta)` stat card
- add a `Protocol Risk` stat or source-panel row with provider label and freshness
- show the explanation directly: "effective safety capped by protocol risk"

This is the best place to educate without cluttering the main table.

#### Tooltips / breakdowns

Extend the current PYS breakdown component pattern rather than inventing a new display system.

For adjusted PYS, show:

- base asset safety input
- protocol risk mapped input
- effective safety input used
- adjusted risk penalty
- final adjusted PYS

### Explicit beta language

Use consistent copy:

- `Adj. PYS (beta)`
- `Protocol risk from Exponential`
- `Coverage incomplete; rows without protocol coverage remain unrated`

This reduces the pressure to overfit the first version.

## What Should Not Change In Release 1

### Do not change best-source arbitration

Current `is_best` selection is still useful for choosing the best observed current yield source under the existing confidence-weighted model.

Changing it now would introduce a second methodology change:

- source selection would become protocol-risk-aware
- some coins could switch displayed primary source even if APY data did not change

That should be a future phase after observing protocol-adjusted coverage and deltas.

### Do not change `yield_history`

The history endpoint should remain APY history only.

Reasons:

- protocol-risk history is not yet collected as a time series
- historical adjusted-PYS reconstruction would imply storing historical protocol-risk snapshots or recomputing against the present, both of which are misleading

### Do not change benchmark logic

The benchmark registry and `excessYield` are independent from the protocol-risk problem. Keep them untouched.

## Implementation Breakdown

### Phase 0. Pre-implementation decision gate

- confirm Exponential usage posture or accept the public-data dependency
- finalize the v1 label-to-score normalization table
- decide which non-DL deterministic/protocol-api sources get explicit protocol identities on day 1

### Phase 1. Identity plumbing

Files:

- `worker/src/cron/yield-sync/types.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-sync/publication.ts`
- `shared/types/yield.ts`
- `worker/migrations/0081_yield_protocol_identity.sql`

Deliverables:

- source rows emit protocol identity
- protocol identity is persisted to `yield_data` and `yield_history`
- rankings cache rows include protocol identity

### Phase 2. Protocol-risk snapshot sync

Files:

- `worker/src/cron/sync-yield-supplemental.ts`
- new `worker/src/cron/yield-protocol-risk/{types,config,fetch,normalize}.ts`

Deliverables:

- fetch Exponential directory + matched protocol detail pages
- build `yield:protocol-risk:v1`
- retain last-known-good snapshot on malformed or failed refresh
- return coverage stats in cron metadata

### Phase 3. Read-time hydration

Files:

- `worker/src/api/cache-handlers.ts`
- `shared/lib/yield-scoring.ts` or new `shared/lib/protocol-adjusted-yield.ts`

Deliverables:

- load protocol-risk snapshot at `/api/yield-rankings` read time
- compute per-row `protocolRisk` and `protocolAdjusted`
- attach top-level `protocolRiskSnapshot` provenance

### Phase 4. Frontend beta surfaces

Files:

- `src/components/yield-leaderboard.tsx`
- `src/components/yield-detail-section.tsx`
- `src/components/yield-table-logic.ts`
- `src/lib/yield-constants.ts`
- `src/app/yield/client.tsx`

Deliverables:

- show protocol-risk badge / metadata in row detail
- show `Adj. PYS (beta)` on detail page
- optionally allow adjusted-score sort only if clearly labeled and opt-in

### Phase 5. Documentation and methodology

Files:

- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `docs/api-reference.md`
- `docs/yield-intelligence-operations.md`
- `src/app/methodology/sections/monitoring-sections.tsx`
- `src/app/about/page.tsx`
- possibly `docs/about-page.md`
- `shared/lib/yield-methodology-version.ts`

Deliverables:

- document protocol identity fields, protocol-risk provider, and adjusted-score semantics
- explain that base PYS remains unchanged in v1
- add the new external source to the About page source inventory
- bump Yield Intelligence methodology version, likely to `v5.7`

## Testing Plan

### Unit tests

Add or extend tests for:

- protocol label normalization -> mapped score / grade
- protocol identity derivation for each source family
- snapshot matching precedence: exact ID, exact key, alias, missing
- `protocolAdjustedPys` computation
- nullable / stale / missing protocol coverage behavior

Likely files:

- `shared/lib/__tests__/yield-scoring.test.ts`
- new `worker/src/cron/__tests__/yield-protocol-risk*.test.ts`
- `worker/src/api/__tests__/yield-rankings.test.ts`

### Integration-style worker tests

Add coverage for:

- supplemental cron writes `yield:protocol-risk:v1`
- malformed provider payload retains prior snapshot
- API hydrates protocol-adjusted fields without altering base PYS
- stale snapshot marks provenance degraded but still serves rankings

### Frontend tests

Add or update tests for:

- detail page renders adjusted PYS when present
- detail page renders missing-coverage state cleanly
- leaderboard expanded row shows protocol metadata without breaking existing layout

### Full verification before push

Run:

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

## Rollout Strategy

### Stage 1. Backend shadow fields

Ship API fields and docs first if needed:

- protocol identity
- protocol risk
- adjusted score

No default-ranking changes.

### Stage 2. Beta UI exposure

Expose:

- `Adj. PYS (beta)` on the detail page
- protocol-risk provenance on detail and row expansion

Keep the leaderboard default on base PYS.

### Stage 3. Observation window

Monitor for at least several days:

- protocol coverage ratio across best-source rows
- percent of rows with `protocolAdjustedPys`
- top score deltas between base PYS and adjusted PYS
- stale snapshot incidents
- mapping misses by protocol key

Only after that should the team decide whether:

- adjusted score gets its own leaderboard sort mode
- adjusted score replaces base PYS in the default experience
- source arbitration becomes protocol-risk-aware

## Operational Metrics To Track

Add to cron metadata and logs:

- matched protocol count
- exact ID match count
- alias match count
- unmatched protocol keys
- rows with protocol-adjusted coverage
- snapshot age
- provider fetch failures

Useful API-level observability:

- top-level `protocolRiskSnapshot.coverageRatio`
- top-level `protocolRiskSnapshot.ageSeconds`
- number of returned rows with non-null `protocolAdjustedPys`

## Main Risks And Mitigations

### Risk: provider dependency is brittle

Mitigation:

- isolate in the supplemental cron
- keep last-known-good snapshot
- mark coverage / freshness explicitly
- do not make public rankings availability depend on it

### Risk: protocol identity is inconsistent across source families

Mitigation:

- centralize canonical protocol identity config
- prefer DeFiLlama slug + ID when available
- record `identitySource`

### Risk: false precision from aggressive mapping

Mitigation:

- use protocol-level only in v1
- use conservative floor mappings
- keep raw provider label visible
- keep metric beta and additive

### Risk: users misread adjusted score as replacing issuer safety

Mitigation:

- keep asset `safetyScore` separate
- label adjusted score as protocol-capped
- show both inputs in the breakdown

## Open Decisions That Need Explicit Answers

- Is the team comfortable shipping a beta integration against Exponential's public structured site data before formal API access exists?
- Which deterministic and rate-derived source families should have protocol identity on day 1 versus stay null?
- Should alt sources receive `protocolRisk` and `protocolAdjusted` fields immediately, or only the best row in v1?
- Do we want an opt-in adjusted-score sort mode in the leaderboard on release day, or only detail-surface exposure?

## Recommended Final Call

Ship v1 as:

- Exponential-backed
- additive
- protocol-level only
- read-time hydrated
- detail-page visible
- leaderboard-default-neutral

That gives Pharos a real protocol-risk answer quickly, keeps the hourly yield pipeline stable, and creates the identity and provenance foundation needed for a later full migration from base PYS to protocol-adjusted PYS.
