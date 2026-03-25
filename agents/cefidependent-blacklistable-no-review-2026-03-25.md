# CeFi-Dependent + Blacklistable No Review

Date: 2026-03-25

## Scope

Reviewed active stablecoins where:

- `flags.governance === "centralized-dependent"`
- resolved blacklistability is `false`

Current count after the `USDh -> possible` change: `28`.

## Framing

Under current Pharos methodology, `Blacklistable` is narrow:

- `true` for explicit blacklistable metadata or centralized governance fallback
- `possible` for explicit mutable-contract override
- `possible-inherited` only when at least `25%` of reserves are linked to first-order blacklistable stablecoins
- otherwise `false`

That means a coin can still resolve to `No` even if it has:

- KYC-gated issuance/redemption
- institutional or CEX custody
- strong operational dependence on USDC/USDT
- centralized upgrade/admin surface

So this review separates:

- **likely metadata mistakes or under-attributed cases**
- **borderline but explainable `No` outcomes under current methodology**

## Strongest Revisit Candidates

These are the names most likely to deserve reclassification from `No` to `possible`, or at minimum deeper contract review.

### 1. `usdu-unitas`

Why it stands out:

- KYC/KYB-gated mint/redeem via API
- explicit `1:1` mint/redeem with `USDC`
- institutional custody (`Copper/Ceffu`)
- dependency on `usdc-circle` already modeled at `0.8`
- still resolves `No` because reserve slices are modeled as `JLP` + short-perp margin rather than direct stablecoin holdings

Read:

- This is the clearest case where the current reserve modeling likely understates blacklistability dependence.
- Strong candidate for `possible`.

Metadata:

- [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L1872)

### 2. `dusd-standx`

Why it stands out:

- `custodyModel: "cex"`
- collateral starts from `USDT/USDC deposits`
- `1:1 USDT/USDC redemption`
- dependencies explicitly modeled as `0.5 USDT + 0.5 USDC`
- still resolves `No` because reserve slices abstract the stablecoin exposure into hedged spot/perp positions

Read:

- This is very similar to the `USDh` reasoning that justified moving from `false` to `possible`.
- Strong candidate for `possible`.

Metadata:

- [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L624)

### 3. `nusd-neutrl`

Why it stands out:

- mint/redeem uses `USDC`, `USDT`, or `USDe`
- institutional custody (`Fireblocks`, `Copper`, `Ceffu`)
- explicit real-time reserve dashboard
- already has `20%` direct stablecoin reserves linked to blacklistable coins, just below the inherited threshold

Read:

- Under current methodology this is still `No`, but it is one of the strongest cases for a manual `possible` override if we want centralized mutable architectures with stablecoin issuance rails to be treated more conservatively.

Metadata:

- [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L4995)

### 4. `reusd-re-protocol`

Why it stands out:

- BVI-regulated, native multichain issuance
- live transparency / reserve feeds
- explicit `20%` `USDC` redemption buffer
- large exposure to `USDe` / `sUSDe` basis-trade structure

Read:

- The current `No` is explainable under the reserve threshold rule, but operationally this feels more mutable and issuer-managed than a typical `No` coin.
- Candidate for `possible`, though weaker than `USDU` or `StandX DUSD`.

Metadata:

- [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L1356)

### 5. `yzusd-yuzu`

Why it stands out:

- accredited/institutional investors only
- KYC/AML required
- mint/redeem `1:1` with `USDT0`
- explicit stablecoin buffer (`10%`)

Read:

- This looks more like a permissioned product with mutable operational control than a clean `No`.
- Good `possible` candidate.

Metadata:

- [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L5094)

### 6. `usp-pikudao`

Why it stands out:

- KYC/KYB required for minting and redeeming
- institutional-regulated custody
- off-chain strategy management
- explicit `USDC/USDT` cash buffer

Read:

- Less direct than `USDU`, `DUSD`, `NUSD`, or `YZUSD`, but still a reasonable review candidate if we want blacklistability attribution to reflect centralized issuance controls more aggressively.

Metadata:

- [usd-minor.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json#L6753)

### 7. `usr-resolv`

Why it stands out:

- `1:1` redeemable
- Fireblocks off-exchange settlement
- institutional-regulated custody
- native cross-chain footprint
- some stablecoin reserve exposure (`10%`)

Read:

- More mixed than the names above because its core reserve base is crypto delta-neutral rather than direct stablecoin issuance.
- Still worth a deeper contract/admin review.

Metadata:

- [usd-major.json](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json#L3063)

## Borderline But Probably Fine Under Current Rules

These look like understandable `No` outcomes with the current methodology, even if they depend partly on centralized stablecoins.

### Near-threshold inherited exposure

- `uusd-youves` — `20%` USDt collateral, but otherwise CDP-like on Tezos
- `usdd-tron-dao-reserve` — `17%` USDT reserve share, still below threshold
- `hollar-hydrated` — `15%` USDT/USDC
- `lisusd-lista` — `15%` USDT/USDC/FDUSD via PSM
- `ceur-celo` — `3%` USDC/USDT
- `cusd-celo` — `2%` USDC/USDT

Read:

- These are more likely methodology-threshold choices than outright mistakes.
- If the inherited threshold changed from `25%` to something lower, several would flip.

### More protocol-like than issuer-like

- `gho-aave`
- `crvusd-curve`
- `dola-inverse-finance`
- `fxusd-f-x-protocol`
- `reusd-resupply`
- `nect-beraborrow`
- `meusd-mezo`

Read:

- These are CeFi-dependent mostly because collateral or wrappers introduce centralized dependencies, not because the token itself obviously looks blacklistable.

## Working Hypothesis

The likeliest misattributions are not “inherited threshold misses” alone.

They are cases where:

- issuance/redemption is permissioned or API-gated
- reserves depend directly on USDC/USDT rails
- custody is institutional or CEX-based
- the metadata lacks an explicit `canBeBlacklisted: "possible"` override

## Recommended Next Review Order

1. `usdu-unitas`
2. `dusd-standx`
3. `nusd-neutrl`
4. `yzusd-yuzu`
5. `reusd-re-protocol`
6. `usp-pikudao`
7. `usr-resolv`

## Suggested Policy Decision

If we want to keep the current narrow meaning of blacklistability, many of these can stay `No`.

If we want the badge to better reflect centralized mutable issuance/control risk, the cleanest path is:

- add more explicit `canBeBlacklisted: "possible"` overrides for permissioned / CEX-custodied / API-issued products
- keep `possible-inherited` for true reserve-linked inheritance only
