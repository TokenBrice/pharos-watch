# Liquity V2 / BOLD Fork Coverage Assessment

Date: 2026-03-24

## Scope

Assess which Liquity V2 / BOLD-friendly forks are already supported in Pharos, which missing forks look like low-effort additions, and which Pharos features each class could realistically support with the current codebase.

Primary external sources reviewed:

- Liquity forks page: https://www.liquity.org/forks
- Liquity Friendly Fork Program docs: https://docs.liquity.org/v2-documentation/friendly-fork-program
- Forqty fork dashboard: https://www.forqty.com/
- CoinGecko search / coin pages for current token discovery
- DefiLlama stablecoins endpoint for current stablecoin discovery

Relevant repo surfaces reviewed:

- `shared/data/stablecoins/*.json`
- `shared/lib/live-reserve-adapters.ts`
- `worker/src/cron/reserve-adapters/*`
- `shared/lib/redemption-backstop-configs/collateral-redeem.ts`
- `src/lib/coverage.ts`
- `docs/live-reserves.md`

## Executive Summary

The repo already supports several Liquity-family assets and most of the reusable pieces are in place:

- reusable reserve adapters for Liquity-style collateral systems:
  - `evm-branch-balances`
  - `single-asset`
  - `curated-validated`
- reusable redemption-backstop modeling for `collateral-redeem`
- generic DEX discovery / DEX liquidity / depeg monitoring for tracked contracts on supported chains

The actual bottleneck is not protocol similarity. It is source discoverability:

- Do we have a stable canonical symbol / ticker?
- Is the asset already visible in DefiLlama and/or CoinGecko?
- Do we have token contracts and enough branch-holder / collateral-account addresses to use `evm-branch-balances`?

## Already Supported

These forks are already in the tracked stablecoin registry:

- `feusd-felix`
- `usdaf-asymmetry`
- `usnd-nerite`
- `ebusd-ebisu`
- `nect-beraborrow`

Notes:

- `feusd-felix` already uses `curated-validated`.
- `usdaf-asymmetry` already uses a dedicated `asymmetry` adapter.
- `usnd-nerite` already uses `evm-branch-balances`.
- `ebusd-ebisu` and `nect-beraborrow` are already tracked as coins, though they do not yet have the same reserve-depth support as the best-covered forks.
- On 2026-03-24, Liquity’s public forks page still labels Beraborrow as `Q4`, but the repo already tracks `nect-beraborrow`. That page is not a reliable source of current Pharos coverage state.

## Best Missing Additions

### 1. Quill USDQ on Scroll

Status:

- Liquity forks page: `Live`
- Forqty: `USDQ`, 4 collaterals, launched on Scroll
- DefiLlama: present as `Quill USD` / `USDQ` (`id=228`)
- CoinGecko: present as `quill-usdq`

Why it is a strong candidate:

- Cleanest missing fork from a data-source perspective.
- Scroll is EVM, so it fits the existing contract, DEX, and reserve-adapter paths.
- Liquity-style collateral redemption can reuse the existing `collateral-redeem` backstop template with minimal changes.

Likely Pharos feature support:

- `Price & Depeg`: yes
- `DEX Price / Liquidity`: yes
- `Safety Score / Report Cards`: yes
- `Dependency Map`: yes, once reserve metadata is curated
- `Redemption Backstop`: yes, strong fit for existing `collateral-redeem` model
- `Live Reserves`: likely yes via `evm-branch-balances` if Quill exposes per-collateral holder addresses; fallback is `curated-validated`
- `Yield`: maybe later, only if there is a distinct yield venue or wrapper we can source
- `Mint/Burn Flows`: no, not with current Ethereum-only mint/burn scope
- `Blacklist`: no

Implementation guess:

- Low effort

### 2. Orki USDK on Swell

Status:

- Liquity forks page: `Live`
- Forqty: `USDK`, 5 collaterals, launched on Swell
- DefiLlama: present as `Orki USD` / `USDK` (`id=265`)
- CoinGecko: no clean token hit found during this pass

Why it is still attractive:

- Swell is EVM-compatible enough for the current onchain adapter pattern.
- Protocol design matches the same reserve / redemption modeling we already use for BOLD, Nerite, and similar forks.

Likely Pharos feature support:

- `Price & Depeg`: likely yes, but with less redundancy if CoinGecko is still missing
- `DEX Price / Liquidity`: likely yes
- `Safety Score / Report Cards`: yes
- `Dependency Map`: yes
- `Redemption Backstop`: yes
- `Live Reserves`: likely yes via `evm-branch-balances` if collateral-account mapping is public; otherwise `curated-validated`
- `Yield`: maybe later
- `Mint/Burn Flows`: no
- `Blacklist`: no

Implementation guess:

- Low-to-medium effort
- Main risk is weaker price-source redundancy than Quill

## Medium-Effort Candidates

### 3. Aesyx

Status:

- Liquity forks page: `Live`
- Forqty currently shows stablecoin `USXY`
- CoinGecko search currently finds `Aexys Dollar` / `AXD`
- No clean DefiLlama stablecoin hit found by current public name

Assessment:

- Chain fit is good because Avalanche is EVM and the Liquity-style reserve/redemption pieces should reuse cleanly.
- But the market identity is currently inconsistent across public sources.
- Before adding, we need to reconcile whether the live stablecoin is `AXD`, `USXY`, or a rebrand / migration.

Likely Pharos feature support once identity is clear:

- `Price & Depeg`: probably yes
- `DEX Price / Liquidity`: probably yes
- `Safety Score / Report Cards`: yes
- `Dependency Map`: yes
- `Redemption Backstop`: yes
- `Live Reserves`: likely yes via `evm-branch-balances` or `curated-validated`
- `Yield`: maybe later
- `Mint/Burn Flows`: no
- `Blacklist`: no

Implementation guess:

- Medium effort because source reconciliation comes first

### 4. DeFi Dollar USDFI

Status:

- Liquity forks page: `Live`
- Forqty: `USDFI`, 10 collaterals, launched on Ethereum
- CoinGecko: present as `defi-dollar`
- DefiLlama stablecoin list did not show a clean hit in this pass

Assessment:

- Ethereum mainnet is favorable for Pharos coverage.
- Docs clearly describe a Liquity-style system with user-set rates, Stability Pools, and redemptions.
- The missing piece is supply-source confidence. Pharos prefers DefiLlama first, with the existing fallback path only.

Likely Pharos feature support if supply/pricing source is acceptable:

- `Price & Depeg`: yes
- `DEX Price / Liquidity`: yes
- `Safety Score / Report Cards`: yes
- `Dependency Map`: yes
- `Redemption Backstop`: yes
- `Live Reserves`: likely yes if collateral branch addresses are public
- `Mint/Burn Flows`: yes, because this is Ethereum and fits the existing mint/burn scope
- `Yield`: maybe later
- `Blacklist`: no

Implementation guess:

- Medium effort
- Strong upside because it is the only missing launched fork here that could also slot into Ethereum mint/burn tracking

### 5. Soneta ONE

Status:

- Liquity forks page: `Live`
- Forqty: `ONE`, 4 collaterals, launched on Sonic
- Soneta docs describe `ONE` as the stablecoin on Sonic
- No clean DefiLlama or CoinGecko stablecoin discovery found in this pass

Assessment:

- Sonic is EVM, and the protocol shape is compatible.
- The ticker `ONE` is very collision-prone, which makes discovery and canonicalization harder.
- Without a clean market-data identifier and verified contracts, this is not yet a low-risk quick win.

Likely Pharos feature support after canonicalization:

- `Price & Depeg`: likely yes
- `DEX Price / Liquidity`: likely yes
- `Safety Score / Report Cards`: yes
- `Dependency Map`: yes
- `Redemption Backstop`: yes
- `Live Reserves`: likely yes
- `Yield`: maybe later
- `Mint/Burn Flows`: no
- `Blacklist`: no

Implementation guess:

- Medium-to-high effort right now because naming / source resolution is weak

## Not Easy Wins Right Now

### Mustang Finance

- Forqty shows `MUST` on Saga, but status is still `Scheduled`
- DefiLlama has a `Mustang Finance` stablecoin entry, but the public fork dashboards still do not present it as fully launched
- I would wait until launch state and contract set are clearly public

### Enosys Loans

- Forqty shows stablecoin name `CDP Dollar`
- Liquity page currently marks it `Live`, but Forqty still shows `Scheduled`
- Public market identifiers were not easy to confirm in this pass
- This is not yet a low-friction add

### Alpen / Bitcoin Dollar

- Still scheduled
- No reason to spend integration effort yet

## Reusable Adapter Paths

Best existing building blocks for future Liquity-family forks:

- `evm-branch-balances`
  - Best fit when the protocol has one ActivePool / collateral holder per branch and those addresses are public
  - This is the strongest path for Quill, Orki, Aesyx, Soneta, and possibly DeFi Dollar

- `single-asset`
  - Only useful for single-collateral forks

- `curated-validated`
  - Good fallback when we have researched reserve composition but not enough public branch-account data
  - Lower-quality reserve evidence than a real dynamic mix, but still useful for detail coverage

- `collateral-redeem` redemption backstop config
  - Already used for Liquity-style designs
  - Easy to extend to new forks once docs and token IDs are in place

## Feature Matrix Heuristic

For a new Liquity V2 fork on a supported EVM chain, assuming contracts and at least one reliable price/supply source are available:

- Immediate / likely:
  - listing + detail page
  - price / depeg tracking
  - DEX liquidity / DEX price
  - safety scores / report cards
  - dependency map
  - redemption backstop

- Often available with modest extra work:
  - live reserves

- Usually not immediate:
  - yield intelligence
  - Ethereum mint/burn flows unless the asset is on Ethereum mainnet
  - blacklist tracking

## Recommended Order

1. Quill USDQ
2. Orki USDK
3. DeFi Dollar USDFI
4. Aesyx, after ticker/source reconciliation
5. Soneta ONE, after canonical market-data resolution

## Bottom Line

The strongest actual easy wins are:

- Quill USDQ
- Orki USDK

The best next-tier additions, but with real source risk, are:

- DeFi Dollar USDFI
- Aesyx
- Soneta

If the goal is maximum coverage with minimum engineering risk, Quill should be first.
