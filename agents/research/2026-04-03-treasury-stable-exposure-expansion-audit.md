# Treasury Stable Exposure Expansion Audit

Date: 2026-04-03

## Current state

The feature is undercounting for two separate reasons:

1. The reviewed treasury seed registry is still a very small manual launch set.
2. The worker only ingested flat wallet balances, so DeFi positions such as LPs, vault wrappers, and lending receipts could sit inside `treasuryUsd` without contributing to the stable sleeve.

Current checked-in scope:

- reviewed seeds: `14`
- launch-eligible seeds: `13`
- launch owner-chain tuples: `42`
- largest held-out reviewed seed: `Aave` (`12` owner-chain tuples)

## Root-cause findings

### 1. Entity coverage is intentionally tiny

`shared/data/treasury-seeds.json` is built from a hard-coded manifest in `scripts/build-treasury-seeds.ts`.

That means the live treasury table is not yet "all parseable DefiLlama treasuries". It is a narrow reviewed subset.

### 2. Position coverage was structurally incomplete

The daily sync previously called only:

- Sim EVM balances
- Sim EVM balances with `asset_class=stablecoin`

That catches direct token balances, but it misses stable exposure locked inside supported DeFi positions unless the wrapper token itself is exposed as a stablecoin by the provider.

This is the main reason treasury rows can look obviously light even when the wallet still has real stable exposure in LPs or vaults.

### 3. The seed extractor was slightly narrower than DefiLlama's treasury helper contract

The local builder harvested only `owners` / `owner` fields and ignored `ownTokenOwners`.

That was not the main launch issue for the currently included seeds, but it is an avoidable blind spot for future expansion.

## Implemented in this pass

The worker snapshot now supplements the flat balance reads with Sim's DeFi positions endpoint and decomposes supported positions to underlying tracked stablecoins.

Implemented coverage additions:

- tokenized stable wrappers
- lending receipt / supply positions
- LP-style positions with stable legs
- wrapper de-duplication when the provider exposes both the wrapper token and the decomposed underlying view

The seed builder now also includes `ownTokenOwners` when present.

## Recommended next expansion steps

### Phase 1: broaden the reviewed launch set

Best next increment:

- review and enable `Aave` first
- then add more static-seeded protocols from the previously identified parseable DefiLlama treasury adapter set

Why:

- `Aave` is already present in the checked-in seed registry
- the adapter is static and reviewed
- it is the cleanest next entity add once the new runtime path has been observed in production

### Phase 2: scale beyond the current manual manifest

Move from a hand-picked manifest toward a broader reviewed registry built from parseable DefiLlama treasury adapters, with explicit statuses:

- `static-seeded`
- `custom-reviewed`
- `dynamic-unresolved`
- `missing`

That is the path to materially expanding from the current 14-seed surface toward the wider parseable treasury universe without overclaiming completeness.

### Phase 3: add protocol-specific supplements where Sim still misses positions

If specific treasuries remain understated after the DeFi-position supplement, the remaining gap is likely one of:

- unsupported position type in Sim
- treasury assets parked in contracts that are not simple owner wallets
- adapter-specific custom logic that cannot be recovered from static wallet extraction alone

Those should be handled with explicit per-protocol supplements, not loose heuristics.
