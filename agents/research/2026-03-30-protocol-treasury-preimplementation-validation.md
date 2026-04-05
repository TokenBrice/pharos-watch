# Protocol Treasury Pre-Implementation Validation

Date: 2026-03-30

## Question

Can the protocol treasury stable-exposure feature move from planning to implementation with high confidence across:

- provider capability
- normalization against Pharos metadata
- worker/cache/API integration
- launch-scope/runtime safety

## Bottom line

Yes, with one important refinement to the original plan:

- the feature is implementable on the current architecture
- the main launch constraint is **reviewed owner-chain tuple budget**, not protocol count
- after validating that point, the remaining dimensions are low risk

That refinement is now folded back into the implementation plan.

## 1. Provider capability is sufficient

Preferred provider remains Sim by Dune Balances.

What the official docs confirm:

- `GET /v1/evm/balances/{address}` returns wallet balances with:
  - `chain`
  - `chain_id`
  - token `address`
  - `symbol`
  - `decimals`
  - `price_usd`
  - `value_usd`
- the endpoint is explicitly for native + ERC20 token balances on supported EVM chains
- CU cost is chain-dependent and equals the number of chains processed via `chain_ids`
- Sim recommends passing explicit `chain_ids` to keep cost predictable

Sources:

- https://docs.sim.dune.com/evm/balances
- https://docs.sim.dune.com/compute-units
- https://docs.sim.dune.com/evm/build-a-realtime-chat-agent

Why this is enough for v1:

- `value_usd` gives the treasury denominator we need for `% of treasury`
- `chain` / `chain_id` plus token `address` is enough for deterministic contract matching
- the endpoint already exposes the exact shape needed for stable-sleeve extraction and treasury total aggregation

## 2. Pharos already has the normalization substrate

Tracked stablecoin metadata already carries chain-qualified contract deployments in shared metadata:

- `StablecoinMeta.contracts?: ContractDeployment[]`
- each deployment includes `chain`, `address`, and `decimals`

Relevant code:

- `shared/types/core.ts`
- `shared/lib/stablecoins/index.ts`
- `shared/lib/tracked-stablecoin-utils.ts`
- `worker/src/cron/dex-liquidity/token-resolution.ts`

Important existing fit:

- contract matching already prefers `chain + address` identity
- the repo already normalizes token addresses to lowercase before matching
- `CHAIN_META` already stores canonical EVM chain IDs and names for the chains Pharos uses

This means treasury normalization does **not** need a new identity system. It can reuse the same chain-address matching discipline already used elsewhere in the repo.

## 3. EVM-first coverage is materially good enough

I checked the tracked stablecoin metadata directly from the checked-in JSON corpus.

Current counts:

- active tracked stablecoins: `176`
- active tracked stablecoins with any contract metadata: `173`
- active tracked stablecoins with at least one EVM-style `0x...` deployment: `160`
- decentralized active stablecoins: `15`
- decentralized active stablecoins with at least one EVM deployment: `13`

Interpretation:

- EVM-first does not cover everything, but it covers the large majority of tracked assets
- more importantly for this feature, it covers most of the decentralized stablecoins that matter for the comparative treasury view

## 4. Worker/API integration is straightforward

This feature fits the repo’s existing cache-backed endpoint pattern cleanly.

Why:

- the Worker already supports cache-backed public endpoints via `createCacheHandler(...)`
- freshness headers and `_meta` are already standardized
- the generic `cache` table already stores arbitrary JSON snapshots

Relevant code:

- `worker/src/lib/db-cache.ts`
- `worker/src/lib/api-utils.ts`
- `worker/src/api/cache-handlers.ts`
- `worker/src/api/__tests__/cache-passthrough.test.ts`
- `src/hooks/use-api-query.ts`
- `shared/lib/api-endpoints.ts`
- `worker/src/route-registry.ts`

Practical implication:

- v1 can ship without a D1 migration if it stays snapshot-in-cache
- a new table is only needed later if we want treasury history, audit trails, or row-level persistence

## 5. `/portfolio/` remains the right UI home

The existing route contract still supports this feature shape well:

- `/portfolio/` is already a noindex, experimental workspace
- there is no `/api/portfolio` endpoint today
- personal holdings remain client-side
- adding a separate fetched treasury section avoids mixing user state with public treasury data

Relevant docs/code:

- `docs/portfolio-page.md`
- `src/app/portfolio/client.tsx`
- `src/hooks/use-portfolio.ts`
- `src/lib/portfolio-analysis.ts`

Conclusion:

- the treasury feature should remain a separate section below the personal portfolio workspace
- the treasury data should stay stateless and server-fetched

## 6. The real launch constraint is wallet surface area

This was the last meaningful implementation risk.

I cloned the public DefiLlama treasury adapter repo again and did a sizing pass over referenced treasury files using EVM address-literal counts as an upper-bound proxy for owner-chain tuples.

Findings from that sizing pass:

- median detected EVM address literals per referenced treasury file: `3`
- p75: `6`
- p90: `14`
- only `20` referenced files were above `20`
- only `4` referenced files were above `50`

Upper-bound stress view:

- the `top 50` address-heaviest treasury files summed to roughly `1327` unique EVM address literals

Important caveat:

- that `1327` figure is an overcount proxy, not a true owner count
- it counts all EVM address literals in the file, not only treasury owners
- some repeated cross-chain ownership may collapse into fewer Sim requests if the same wallet can be queried with multiple explicit chains

But it is still enough to invalidate one earlier assumption:

- `top 50 protocols` is **not** a safe runtime bound by itself

Why:

- provider calls scale with the reviewed wallet surface area, not with protocol count
- two allowlists with the same number of protocols can have very different request volume

So the corrected launch rule is:

- cap v1 by reviewed owner-chain tuple budget first
- let the resulting protocol count fall where it falls

## 7. Cron/runtime fit is now clear

The repo’s worker constraints are explicit:

- `30000 ms` CPU cap per invocation
- 6 concurrent fetch connections per trigger
- new fetch-heavy jobs should come with explicit throttle/budget decisions

Relevant docs:

- `docs/worker-and-api-limits.md`
- `docs/worker-infrastructure.md`
- `shared/lib/cron-jobs.ts`
- `worker/src/handlers/scheduled.ts`

What this means for treasury sync:

- a treasury sync can fit the current architecture
- but it should launch with an allowlist sized to a measured runtime budget
- if the provider proof shows many sequential requests, an isolated daily trigger is the safer choice
- if the measured owner-chain tuple budget is small enough, the existing 08:00 UTC daily slot has connection headroom and could host it

## 8. Confidence assessment by dimension

Provider capability:

- high confidence

Normalization against Pharos metadata:

- high confidence

Worker/cache/API integration:

- high confidence

UI placement and product shape:

- high confidence

Launch-scope/runtime safety:

- high confidence **after** replacing `top 50` with owner-chain tuple budgeting

## Final recommendation

Implementation can start.

The correct sequence is now:

1. build `treasury-seeds.json`
2. compute reviewed owner-chain tuple counts for the intended launch allowlist
3. run the Sim proof-of-concept against that bounded allowlist
4. lock the v1 launch set
5. build snapshot + API
6. add `/portfolio/` UI

There are no remaining medium issues with the implementation path after the plan correction above.
