# 2026-04-03 Live Reserve Badge Assessment

## Question

Are Pharos "Live" reserve badges only shown for reserve compositions that are truly live under this rule?

- true live = reserve composition comes from a live API / dashboard / page feed, or from direct onchain monitoring of collateral-holding contracts
- not true live = reserve composition is still curated / reviewed baseline data, or only a liveness / supply proof, or only coarse attestation totals without a reserve-category mix

## Repo Findings

The current badge is over-broad.

- The detail page passes `isLive={!!reserves.liveAt}` into the treemap, so any authoritative stored snapshot gets the `Live` pill, regardless of provenance class.
- The API returns `mode: "live"` / `liveAt` for any valid stored snapshot, including `static-validated` and `weak-live-probe` feeds.
- The UI already knows about weaker provenance and renders explanatory notices for `static-validated` and `weak-live-probe`, but the headline badge still says `Live`.

Relevant code:

- `src/components/stablecoin-detail/overview-section.tsx:237-240`
- `src/components/stablecoin-detail/overview-section.tsx:138-160`
- `src/components/reserve-treemap.tsx:120-125`
- `worker/src/lib/live-reserves-store-view.ts:362-378`

## Adapter Classification

### Truly live by implementation in the checked-out repo

These families satisfy the stated rule because they consume a live reserve feed or read collateral state directly:

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

Count in local checked-out metadata: `45 / 119`

### Not truly live by implementation in the checked-out repo

These families should not get a plain `Live` reserve-composition badge:

- `curated-validated`
  - probes onchain total supply, then returns the curated `coin.reserves` array unchanged
  - see `worker/src/cron/reserve-adapters/curated-validated.ts:7-33`
- `single-asset`
  - `http-json` mode can degrade to a single-asset liveness probe
  - `onchain-evm` mode probes token total supply, not collateral holdings
  - see `worker/src/cron/reserve-adapters/single-asset.ts:68-125`
  - see `worker/src/cron/reserve-adapters/single-asset.ts:127-160`
- `frax`
  - fetches live totals, but still returns curated/static reserve slices
  - see `worker/src/cron/reserve-adapters/frax.ts:20-34`
- `tether`
  - returns a single 100% bucket with coarse attested totals and explicitly notes composition is undisclosed
  - see `worker/src/cron/reserve-adapters/tether.ts:39-56`

Count in local checked-out metadata: `74 / 119`

Breakdown:

- `single-asset`: `48`
- `curated-validated`: `23`
- `frax`: `2`
- `tether`: `1`

## Production Snapshot Check

Remote D1 on 2026-04-03 still stores `119` authoritative reserve snapshots.

Evidence-class split:

- `independent`: `42`
- `static-validated`: `28`
- `weak-live-probe`: `49`

Representative public API responses currently return `mode: "live"` even for non-true-live families:

- `lusd-liquity` -> `source: "single-asset"`, `evidenceClass: "weak-live-probe"`, `mode: "live"`
- `usdt-tether` -> `source: "tether"`, `evidenceClass: "weak-live-probe"`, `mode: "live"`
- `frax-frax` -> `source: "frax"`, `evidenceClass: "static-validated"`, `mode: "live"`
- `bold-liquity` -> `source: "evm-branch-balances"`, `evidenceClass: "independent"`, `mode: "live"`
- `usdd-tron-dao-reserve` -> `source: "usdd-data-platform"`, `evidenceClass: "static-validated"`, `mode: "live"`

Remote D1 caveat:

- the checked-out repo has USDAI moved to `usdai-proof-of-reserves`
- remote D1 on 2026-04-03 still shows `usdai-usd-ai` under `source = "curated-validated"`, so production has not reflected that change yet

## Conclusion

Today, "Live" on the reserve card means "we have a stored authoritative live-reserve snapshot row" rather than "this reserve composition is truly live under the stricter product definition."

If the badge must mean true live reserve composition, the current implementation is too permissive and should exclude at least:

- all `curated-validated`
- all `single-asset`
- `frax`
- `tether`

That would remove the plain `Live` badge from `74 / 119` locally configured reserve feeds, leaving `45 / 119` as truly live by implementation in the checked-out repo.
