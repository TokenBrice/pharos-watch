# Protocol Treasury Feature Plan

Date: 2026-03-30

## Goal

Add a new `/portfolio/` section that ranks protocol / organization treasuries by stablecoin exposure and lets users inspect:

- stablecoin composition by issuer / coin
- decentralized stablecoin exposure in dollars
- decentralized stablecoin exposure as `% of treasury`
- decentralized stablecoin exposure as `% of stablecoin sleeve`
- weighted Pharos Safety Score for the stablecoin sleeve

## Product decision

### Phase 1 should be descriptive, not methodological

Do **not** introduce a new proprietary "treasury decentralization score" in v1.

Instead, v1 should use:

- existing stablecoin governance buckets (`CeFi`, `CeFi-Dependent`, `DeFi`)
- existing report-card Safety Scores
- explicit denominator metrics

This avoids creating a new methodology surface before the data coverage is trustworthy enough.

## Scope cut for MVP

### Included

- public DefiLlama GitHub treasury adapter extraction as the seed list
- EVM-first treasury balance coverage
- launch-gated treasury allowlist, bounded by reviewed owner-chain tuple budget rather than protocol count alone
- stablecoin-only treasury sleeve analysis
- leaderboard plus per-row holdings breakdown
- explicit coverage metadata

### Excluded

- full non-EVM coverage in v1
- historical treasury time series
- alerts
- a new treasury-specific scoring framework
- trying to perfectly match DefiLlama treasury totals

## Why this cut

The public DefiLlama GitHub treasury surface is usable enough for a seed registry, but not complete enough to support a "fully comprehensive cross-chain treasury analytics" claim out of the gate.

The parseability survey suggests roughly:

- `~330` referenced treasury adapters are good candidates for static wallet extraction
- `~40-50` require custom/manual review or should be marked unresolved

That is enough for an MVP if the feature is framed honestly as:

- onchain treasury stable exposure
- EVM-first
- best-effort public-wallet coverage

## Architecture

### 1. Seed registry

Add a checked-in treasury seed registry derived from DefiLlama public repos plus manual review.

Suggested file:

- `data/treasury-seeds.json`

Suggested builder:

- `scripts/build-treasury-seeds.ts`

Suggested schema:

```ts
interface TreasurySeed {
  protocolId: string;
  slug: string;
  name: string;
  category: string | null;
  launchEligible: boolean;
  launchPriority?: number;
  source: "defillama-github";
  adapterFile: string | null;
  extractionMode: "static-seeded" | "custom-reviewed" | "dynamic-unresolved" | "missing";
  chains: string[];
  owners: Array<{
    chain: string;
    address: string;
    label?: string;
  }>;
  notes?: string[];
}
```

Rules:

- only persist extracted wallet owners, not adapter execution results
- preserve chain prefixes
- keep unresolved protocols in the registry with status instead of silently dropping them

### 2. Balance source

Preferred MVP source:

- Sim by Dune `Balances API` for full EVM wallet balances with USD values

Why:

- supports the actual denominator we need for `% of treasury`, because it returns full native + ERC-20 wallet balances rather than stablecoin-only balances
- avoids implementing broad chain-by-chain token balance crawling inside the Worker
- lets us focus on the treasury seed list and Pharos-specific normalization

Required v1 provider contract:

- one request per wallet address
- chain-qualified token contract + symbol metadata
- per-balance USD valuation
- enough response detail to derive:
  - `treasuryUsd`
  - `trackedStableUsd`
  - `decentralizedStableUsd`

Fallback:

- if the chosen provider only returns stablecoin balances, do **not** ship `% of treasury` in v1
- in that reduced mode, ship only:
  - `Decentralized Stable $`
  - `Decentralized Stable % of Stable Sleeve`
  - coverage metadata

Secondary fallback:

- direct onchain reads for a very small allowlisted set of top protocols if provider integration proves awkward

### 3. Normalization layer

Add shared normalization that maps:

- `chain + token contract + wallet balance`

into:

- `coinId + usd amount`

using existing tracked stablecoin contract metadata.

Suggested shared module:

- `shared/lib/treasury-stable-exposure.ts`

Core outputs:

- `treasuryUsd`
- tracked stable holdings
- `stableTrackedUsd`
- `decentralizedStableUsd`
- `decentralizedStablePctOfTreasury`
- `decentralizedStablePctOfStableSleeve`
- weighted safety grade / score
- coverage stats

### 4. Worker snapshot

Add a Worker-owned snapshot flow that computes the normalized treasury dataset and writes it to D1 `cache`.

Suggested cache key:

- `treasury-stable-exposure`

Suggested cadence:

- `daily` for first release

Reason:

- balance changes matter, but this feature does not need 15-minute freshness initially
- daily cadence reduces operational risk and upstream/API spend
- the initial launch scope should stay small enough to fit one bounded daily job

Runtime guardrails:

- do **not** assume the full `~330` static-seeded set is safe for the first cron implementation
- publish from a checked-in launch allowlist (`launchEligible: true`) capped by reviewed owner-chain tuple budget until latency and spend are proven
- treat protocol count as a secondary outcome; the launch set may be below `50` entities if the reviewed wallet surface is too large
- prefer a dedicated isolated daily trigger for the treasury sync if the provider proof-of-concept requires many sequential wallet requests
- add a dedicated circuit-breaker source and timeout budget before shipping the fetch loop

### 5. Public API

Add:

- `GET /api/treasury-stable-exposure`

Phase 1 response should return the full snapshot, with the client handling sorting/filtering.

Suggested response:

```ts
interface TreasuryStableExposureResponse {
  entities: TreasuryStableExposureEntity[];
  updatedAt: number;
  coverage: {
    entityCount: number;
    staticSeededCount: number;
    unresolvedCount: number;
    evmOnly: boolean;
  };
}
```

### 6. Frontend

Append a separate section to `/portfolio/`, not mixed into the personal holdings editor.

Suggested section title:

- `Protocol Treasury Stable Exposure`

Suggested v1 UI:

- leaderboard table
- sort by:
  - `Decentralized Stable $`
  - `Decentralized Stable % of Treasury`
  - `Decentralized Stable % of Stable Sleeve`
  - `Tracked Stable Sleeve $`
  - `Weighted Stable Grade`
- row expansion or inline detail for top holdings
- coverage badge per protocol
- global note:
  - onchain-only
  - EVM-first
  - best-effort public-wallet coverage

## File touchpoints

### New runtime

- `data/treasury-seeds.json`
- `scripts/build-treasury-seeds.ts`
- `shared/types/treasury-stable-exposure.ts`
- `shared/lib/treasury-stable-exposure.ts`
- `worker/src/cron/sync-treasury-stable-exposure.ts`
- `worker/src/api/treasury-stable-exposure.ts`
- `src/hooks/use-treasury-stable-exposure.ts`
- `src/components/treasury-stable-exposure-table.tsx`

### Existing files likely touched

- `shared/lib/api-endpoints.ts`
- `shared/lib/cron-jobs.ts`
- `worker/src/route-registry.ts`
- `src/app/portfolio/client.tsx`
- `docs/portfolio-page.md`
- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/worker-and-api-limits.md`
- `docs/about-page.md`

## Implementation phases

### Phase 1: Seed registry and normalization spike

Deliverables:

- builder script for treasury seeds
- checked-in `treasury-seeds.json`
- extraction status tiers
- normalization library that converts stablecoin holdings into Pharos metrics

Exit criteria:

- top referenced treasury adapters can be represented as normalized wallet seeds
- unresolved protocols are explicitly flagged
- launch allowlist exists, is intentionally smaller than the raw seed corpus, and has a measured owner-chain tuple count

### Phase 2: Worker snapshot + API

Deliverables:

- balance fetch integration
- snapshot writer to cache
- public API endpoint
- tests for handler and normalization

Exit criteria:

- endpoint returns stable JSON payload with freshness metadata
- snapshot degrades safely when upstream balance fetch fails
- provider proof confirms we can derive full `treasuryUsd`; otherwise `% of treasury` is removed from the initial UI/API contract
- provider proof confirms the reviewed allowlist fits a bounded daily runtime budget; otherwise reduce the launch allowlist before UI work starts

### Phase 3: Portfolio page UI

Deliverables:

- treasury leaderboard section
- sorting and filter controls
- coverage badges and explanatory copy

Exit criteria:

- page remains coherent with existing portfolio UX
- users can answer the core questions:
  - who has the most decentralized stablecoins
  - who exceeds 5%
  - who has the safest stable sleeve

### Phase 4: Review and coverage tightening

Deliverables:

- manual review of high-traffic unresolved protocols
- additional address overrides
- optional Solana/non-EVM expansion plan

## Ranking semantics

We should expose all three of these separately:

1. `Decentralized Stable $`
2. `Decentralized Stable % of Treasury`
3. `Decentralized Stable % of Stable Sleeve`

Do not collapse them into one headline metric.

Definitions:

- `Treasury` = full onchain wallet balance value represented by the same balance snapshot used for stablecoin extraction
- `Stable Sleeve` = tracked stablecoin balances only
- `Decentralized Stable` = holdings where `flags.governance === "decentralized"`

### Important nuance

`CeFi-Dependent` should remain separate from `CeFi`.

The feature becomes much less valuable if those are merged.

## Coverage model

Every entity should disclose:

- `treasuryUsd`
- `trackedStableUsd`
- `untrackedStableUsd` if measurable
- `stableTrackedPctOfTreasury`
- coverage tier:
  - `static-seeded`
  - `custom-reviewed`
  - `dynamic-unresolved`
  - `missing`

This is mandatory. Without it, users will treat partial coverage as complete coverage.

## Operational concerns

### Freshness

For v1:

- `staleTime = daily cron interval`
- `refetchInterval = 2x daily cron interval`

### Failure mode

If the balance source fails:

- keep serving the last successful snapshot
- mark freshness as stale
- do not zero out the dataset

### Runtime scope

Keep the first balance source narrow.

Preferred first cut:

- EVM chains only
- stablecoin contracts already mapped in Pharos
- launch allowlist only, not every parseable treasury adapter on day one
- launch scope determined by owner-chain tuple budget, not by protocol count headline

## Testing

Add:

- unit tests for treasury seed extraction
- unit tests for normalization and percentage math
- API handler contract test
- UI rendering / sorting smoke test if a dedicated table component is added

Validation commands for implementation PR:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Documentation requirements

When implementation starts, update:

- `docs/portfolio-page.md`
- `docs/about-page.md` because this introduces a new externally visible data source / feature
- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/worker-and-api-limits.md` if a new cron or external fetch budget is added

If a treasury-specific score or threshold methodology is introduced later, add dedicated methodology documentation at that time instead of hiding it inside portfolio docs.

## Open questions

1. Do we want v1 to be strictly EVM-only, or do we want a small Solana manual lane too?
2. Do we want the first UI as a table only, or table + row expansion for holdings breakdown?

## Validation pass

The plan was re-checked against the current repo constraints on 2026-03-30.

Resolved medium issues:

1. `% of treasury` had an under-specified denominator.
   Resolution: the plan now requires a full wallet-balance provider for v1, or else drops that metric from the launch contract.
2. The balance provider dependency was too vague.
   Resolution: the plan now names Sim Balances as the preferred provider because it exposes full EVM wallet balances with USD values, while keeping a smaller fallback path.
3. The runtime scope was too large for an initial daily cron.
   Resolution: the plan now requires a launch allowlist plus explicit cron/circuit budgets instead of assuming the whole parseable DefiLlama corpus can ship at once.
4. A `top 50` headline was not a safe runtime bound.
   Resolution: the plan now caps launch by reviewed owner-chain tuple budget instead of protocol count alone, because provider calls scale with wallet surface area.

Residual low-risk items:

- optional Solana/manual expansion remains intentionally deferred
- row-expansion UX is still a product choice, not a blocker

## Recommendation

Greenlight implementation with this order:

1. seed-registry builder
2. EVM balance-source proof of concept
3. snapshot + API
4. `/portfolio/` leaderboard UI

Do not start with the UI first. The core risk is data normalization and coverage honesty, not rendering.
