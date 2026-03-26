# CeFi-Dependent Borderline 6 Review

Date: 2026-03-25

## Scope

Reviewed:

- `uusd-youves`
- `usdd-tron-dao-reserve`
- `hollar-hydrated`
- `lisusd-lista`
- `ceur-celo`
- `cusd-celo`

Context:

- These were the remaining borderline names after the higher-priority reclassifications.
- `lisusd-lista` was already changed during the patch set and is included here to confirm whether that should stand.

## Verdicts

### 1. `lisusd-lista`

Verdict: keep `possible`

Why:

- Lista’s official docs describe a dedicated PSM that enables:
  - minting `lisUSD` with `USDT` or `USDC` at `1:1`
  - redeeming `lisUSD` back into centralized stablecoins, subject to reserve limits
- The docs explicitly frame centralized stablecoins as critical to peg maintenance.

Evidence:

- Lista PSM docs:
  - https://docs.bsc.lista.org/introduction/collateral-debt-position-lisusd/lisusd/stable-pool-price-stability-module-psm

Read:

- This is not enough to prove direct token blacklist/freeze.
- But it is stronger than a plain `No`.
- `possible` is the right label.

### 2. `usdd-tron-dao-reserve`

Verdict: keep `No`

Why:

- Current official USDD docs explicitly state the new USDD is:
  - `tamper-proof`
  - `cannot be frozen`
  - `freeze-free`
- USDDOLD docs separately say no organization or individual can freeze users’ `USDDOLD`.
- The architecture is still CeFi-dependent because of collateral mix, PSM rails, and governance dependence, but that is not enough on its own to make the token blacklistable under the current methodology.

Evidence:

- USDD intro:
  - https://docs.usdd.io/introduction
- USDD core features:
  - https://docs.usdd.io/introduction/core-features
- USDDOLD docs:
  - https://docs.usdd.io/introduction/what-is-usddold

Read:

- The direct source language is strong enough to keep `No`.

### 3. `uusd-youves`

Verdict: keep `No`

Why:

- The local metadata still reads like a CDP-style Tezos system:
  - overcollateralized vaults
  - liquidations
  - collateral includes `USDt`, but only `20%`
- I did not find evidence of token-level blacklist/freeze controls.
- This looks like a threshold-borderline collateral exposure case, not a clear blacklistability miss.

Evidence:

- Local metadata:
  - [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L6083)
- youves docs / contract references:
  - https://docs.youves.com/smartContracts/smartcontracts/

Read:

- Under a broader “centralized control risk” label, you could argue for `possible`.
- Under the current blacklistability definition, `No` still looks correct.

### 4. `hollar-hydrated`

Verdict: keep `No`

Why:

- Hydration docs describe HOLLAR as:
  - decentralized
  - overcollateralized
  - built on an Aave/GHO-style architecture
- The `HSM` uses stablecoin conversion capabilities, but that alone is not evidence of address-level blacklist/freeze.
- Reserve-linked centralized stablecoin share is only `15%`, below the inherited threshold.

Evidence:

- Hydration docs:
  - https://docs.hydration.net/products/hollar/

Read:

- This looks like a defensible `No`.

### 5. `ceur-celo`

Verdict: keep `No`

Why:

- `cEUR` is a Mento reserve / virtual-AMM style system with on-chain reserve mechanics, oracle pricing, and circuit breakers.
- The reserve includes some centralized stablecoins, but only a very small share (`3%` in current curated metadata).
- This is more of a reserve-composition issue than a blacklist-control issue.

Evidence:

- Local metadata:
  - [non-usd.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/non-usd.json#L1500)
- Mento reserve docs:
  - https://docs.mento.org/mento/overview/core-concepts/the-reserve

Read:

- No change recommended.

### 6. `cusd-celo`

Verdict: keep `No`

Why:

- Same reasoning as `cEUR`.
- Mento reserve composition is mostly on-chain / reserve-based and the linked centralized stablecoin share in current metadata is only `2%`.
- That is far below inherited-risk threshold and I found no evidence of token blacklist/freeze semantics.

Evidence:

- Local metadata:
  - [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L5399)
- Mento reserve docs:
  - https://docs.mento.org/mento/overview/core-concepts/the-reserve

Read:

- No change recommended.

## Final Recommendation

Keep current state:

- `lisusd-lista` → `possible`
- `usdd-tron-dao-reserve` → `No`
- `uusd-youves` → `No`
- `hollar-hydrated` → `No`
- `ceur-celo` → `No`
- `cusd-celo` → `No`

## Notes

- `USDD` is the only one here with strong direct official language on freeze-free behavior, which makes keeping `No` unusually well supported.
- `uUSD`, `HOLLAR`, `cEUR`, and `cUSD` are best understood as reserve-threshold or collateral-composition cases, not obvious blacklistability attribution mistakes.
