# Treasury Stable Exposure Review

Date: 2026-04-04

## Scope

- Reviewed feature contract and docs:
  - `docs/api-reference.md`
  - `docs/portfolio-page.md`
- Reviewed runtime:
  - `shared/lib/treasury-stable-exposure.ts`
  - `worker/src/lib/sim-balances.ts`
  - `worker/src/cron/sync-treasury-stable-exposure.ts`
  - `worker/src/api/treasury-stable-exposure.ts`
  - `src/components/treasury-stable-exposure-table.tsx`
- Checked live production snapshot:
  - `https://api.pharos.watch/api/treasury-stable-exposure`
- Checked source seed for Liquity:
  - `https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/treasury/liquity-treasury.js`

## Top findings

### 1. `% of treasury` is mathematically invalid once DeFi-position balances are included

Live production currently publishes:

- Liquity `treasuryUsd = 316,586.03`
- Liquity `stablecoinSleeveUsd = 2,168,292.56`
- Liquity `trackedStablePctOfTreasury = 684.9%`
- Liquity `decentralizedStablePctOfTreasury = 283.48%`

Root cause in code:

- `treasuryUsd` sums only `wallet.treasuryBalances`
- `stablecoinSleeveUsd` sums `wallet.stablecoinBalances` plus `wallet.derivedStablecoinBalances`

That means the denominator excludes DeFi positions while the stable sleeve includes them. The feature contract says `% treasury` uses the full treasury denominator, but the implementation no longer matches that contract after the DeFi-position supplement landed.

Impact:

- the headline ranking is currently wrong
- the default sort can put invalid rows at the top
- the UI can present impossible percentages as high-confidence output

### 2. Derived DeFi stable exposure only counts tracked stablecoins and silently drops unresolved stable legs

`normalizeTrackedStableBalance()` returns `null` unless the underlying token resolves to a Pharos-tracked stablecoin. Those unresolved derived legs do not increment:

- `stablecoinSleeveUsd`
- `untrackedStableUsd`
- any warning counter

So the feature can overstate coverage by showing:

- `Tracked 100.0% of stable sleeve`

even when the DeFi-position supplement may have omitted real stable exposure that could not be mapped.

### 3. The API validates schema shape only, not invariants

The API accepts and serves rows where:

- `stablecoinSleeveUsd > treasuryUsd`
- a holding `pctOfTreasury > 100`
- `trackedStablePctOfTreasury > 100`

There is no runtime rejection, downgrade, or warning state for impossible rows.

### 4. The UI amplifies bad rows instead of surfacing them as suspect

Current table behavior:

- default sort is raw decentralized stable dollars
- the top summary counts protocols with `>= 5%` decentralized stable share of treasury
- the row badge also uses the same raw percentage
- collapsed coverage only shows `Tracked X% of stable sleeve`

So the exact Liquity anomaly is rewarded with:

- top placement
- a positive badge
- a “fully tracked” coverage summary

instead of a low-confidence / invalid-data state.

### 5. Live debugging is harder than it should be because snapshots are cache-only

The daily sync writes only the current snapshot payload into cache. `cron_runs` keeps only aggregate metadata like entity count and owner-chain tuples.

Result:

- no per-entity history
- no row-level diffing across runs
- no way to see when a treasury first became partial or impossible

This makes production review much harder once the feature is live.

### 6. Seed coverage is still intentionally small and manual

The reviewed registry is a hard-coded manifest in `scripts/build-treasury-seeds.ts`:

- reviewed seeds: `14`
- live launch set: `13`

This is materially narrower than the broader parseable DefiLlama treasury surface, so the feature is still a curated beta rather than a broad market view.

### 7. Partiality signals exist, but they are easy to miss

Rows with known incompleteness currently only expose it in notes, for example:

- `Skipped unsupported or non-EVM chain "arbitrum_nova" from arbitrum-dao.js.`
- `Skipped unsupported or non-EVM chain "solana" from lido.js.`

Collapsed rows do not visibly distinguish:

- full vs partial owner-chain coverage
- direct-balance-only vs DeFi-supplemented rows
- invalid treasury denominator rows

### 8. Zero-dollar holdings leak into the UI

Because holdings are rounded after accumulation and not filtered again, rows can render holdings like:

- `FRAX $0`
- `DAI $0`

This makes the table look noisier and less trustworthy.

## Improvement priorities

### P0

- Fix the denominator contract. Either:
  - compute a true total treasury that includes supported DeFi positions, or
  - stop publishing `% of treasury` whenever the denominator is only direct balances.
- Add invariant guards before cache write and before API serve:
  - reject or mark invalid when `stablecoinSleeveUsd > treasuryUsd`
  - reject or mark invalid when holding-level `% of treasury > 100`
- Add a visible `invalid / partial denominator` UI state and suppress ranking badges for affected rows.

### P1

- Preserve unresolved derived stable legs as explicit `untrackedStableUsd` instead of dropping them.
- Surface coverage quality in the collapsed row:
  - covered owner-chain tuples
  - skipped chains
  - direct-only vs supplemented
  - invalid denominator flag
- Store daily per-entity snapshots or diffs so run-to-run review is possible.

### P2

- Expand the reviewed seed registry beyond the current manual launch set.
- Add protocol-specific supplements where Sim still under-models treasury positions.
- Filter rounded-zero holdings out of the holdings list.
- Add tests for:
  - derived sleeve exceeding treasury
  - unresolved derived stable legs
  - suspect-row UI treatment
  - mixed partial-coverage rows

## Verification

Ran targeted tests:

- `shared/lib/__tests__/treasury-stable-exposure.test.ts`
- `worker/src/lib/__tests__/sim-balances.test.ts`
- `worker/src/cron/__tests__/sync-treasury-stable-exposure.test.ts`
- `src/components/__tests__/treasury-stable-exposure-table.test.tsx`

All passed, which confirms the current suite does not cover the live failure mode.
