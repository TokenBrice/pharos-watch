# Redeemable Assets and Liquidity Scoring

Date: 2026-03-12

## Question

How should Pharos handle assets that have weak onchain secondary-market liquidity but strong direct redemption paths, such as `cusd-cap` and `iusd-infinifi`?

## Current Pharos Behavior

Pharos currently treats liquidity as a DEX liquidity question.

- `docs/dex-liquidity.md`: liquidity score is a 0-100 composite built from DEX TVL depth, volume, pool quality, durability, and pair diversity.
- `docs/report-cards.md`: the report card passes through `liquidityScore` directly, and applies an additional no-liquidity penalty when liquidity is NR.

As of 2026-03-12, public API output shows:

- `cusd-cap`: liquidity score `29`, grade `F`, `1` pool, `1` chain, HHI `1.00`
- `iusd-infinifi`: liquidity score `47`, grade `D`, `8` pools, `2` chains

This is internally consistent with the current methodology, but it conflates:

1. market exit liquidity
2. protocol redemption liquidity

Those are not the same thing.

## Candidate Universe From The Tracked Base

A broad keyword scan over `shared/lib/stablecoins.ts` surfaces many redemption-like mechanisms, but only a subset are good first-class candidates for a `redemptionBackstopScore`.

### High-priority onchain / protocol-native candidates

These are the best fit for an initial implementation because the backstop is protocol-enforced and usually queryable onchain or from a protocol API.

- `cusd-cap`
- `iusd-infinifi`
- `lusd-liquity`
- `bold-liquity`
- `feusd-felix`
- `usdaf-asymmetry`
- `usnd-nerite`
- `ebusd-ebisu`
- `nect-beraborrow`
- `meusd-mezo`
- `alusd-alchemix`
- `fxusd-f-x-protocol`
- `buck-bucket-protocol`
- `eura-angle`
- `gho-aave`
- `dai-makerdao`
- `dola-inverse-finance`
- `hollar-hydrated`
- `gyd-gyroscope`
- `dusd-dtrinity`

### Conditional / queue-based candidates

These have a meaningful redemption backstop, but the quality depends on liquid reserve buffers, queue duration, or settlement windows.

- `iusd-infinifi`
- `reusd-re-protocol`
- `cgusd-cygnus-finance`
- `uty-xsy`
- `usp-pikudao`
- `aznd-mu-digital`
- `avusd-avant`
- `usdu-unitas`
- `yzusd-yuzu`

### Centralized issuer-redemption candidates

These are valid candidates in principle, but the data is mostly static / policy-driven rather than onchain. They are better suited to a second phase.

- `usdc-circle`
- `usdt-tether`
- `pyusd-paypal`
- `fdusd-first-digital`
- `rlusd-ripple`
- `eurc-circle`
- `usdp-paxos`
- `gusd-gemini`
- `usdg-paxos`
- `usdx-hex-trust`
- `xusd-straitsx`
- `xsgd-straitsx`
- `euri-banking-circle`
- `eurq-quantoz`
- `usdq-quantoz`
- many of the other fiat / regional issuer coins

### Lower-priority / phase-later cases

These mention redemption, but they should probably not be in the first implementation wave:

- NAV-accreting tokens and fund-share wrappers (`ousg-ondo-finance`, `ustb-superstate`, `mtbill-midas`, `buidl-blackrock`, etc.)
- commodity tokens where redemption is for physical metal rather than a stable peg
- tokens whose redemption path is mostly offchain, highly permissioned, or only weakly related to immediate dollar exit

## Explicit answer on LUSD and BOLD

Yes, both should be considered candidates.

- `lusd-liquity`: strong candidate
- `bold-liquity`: strong candidate

Why:

- both have protocol-native direct redemption
- both are permissionless and onchain
- both redeem against collateral at a peg-defined dollar value
- both are exactly the kind of assets where DEX liquidity alone can understate exit quality

How they differ from cUSD / iUSD:

- They do not redeem into a stablecoin reserve.
- They redeem into underlying collateral (for example ETH or branch collateral).
- That still qualifies as a backstop, but the score should include a haircut for collateral-type and the user still needs a secondary swap if they want dollars immediately.

## Primary-Source Research

### Cap cUSD

Official Cap docs indicate:

- cUSD is redeemable against whitelisted reserve assets via mint / burn / redeem flows
- the Vault acts as a Peg Stability Module
- cUSD can be redeemed for a proportional basket, or burned into a chosen reserve asset
- Cap states redemptions are guaranteed, but notes delays are possible if reserves become fully utilized; dynamic rates are meant to avoid full utilization

Useful pages:

- https://docs.cap.app/protocol-overview/cusd-mechanics
- https://docs.cap.app/concepts/vault
- https://docs.cap.app/concepts/vault/minter
- https://docs.cap.app/risks
- https://docs.cap.app/overview

Implication:

- cUSD has a strong onchain redemption backstop
- but its redemption semantics are not identical to deep spot liquidity
- there is basket risk / socialized depeg risk and utilization risk

### infiniFi iUSD

Official infiniFi materials indicate:

- iUSD is minted / redeemed 1:1 against USDC with no fees
- the system is explicitly fractional reserve
- the liquid portion supports instant withdrawals
- redemptions queue when liquid reserves are insufficient
- docs emphasize liquid and illiquid tranches and bank-run handling

Useful pages:

- https://docs.infinifi.xyz/
- https://docs.infinifi.xyz/Whitepaper-1f244c414f3680638480da26b5c47895?pvs=25
- https://docs.infinifi.xyz/risks

Relevant local code context:

- `shared/lib/stablecoins.ts` already describes iUSD as fractional-reserve with queued redemptions
- `worker/src/cron/reserve-adapters/infinifi.ts` already classifies farms into `LIQUID` and `ILLIQUID`

Implication:

- iUSD has a real redemption backstop
- but it is capacity-constrained and time-dependent
- using total reserves as a liquidity substitute would materially overstate exit quality

## Main Ways To Address This

### 1. Keep DEX Liquidity Pure, Add A Separate Redemption Backstop Metric

Definition:

- leave `liquidityScore` exactly as a DEX / market-liquidity measure
- add a second metric for direct redemption / protocol exit quality

Pros:

- preserves the meaning of the current liquidity methodology
- easiest to explain on the liquidity page
- avoids inflating DEX depth for assets with weak market trading
- generalizes to more assets cleanly

Cons:

- requires a new metric and UI surface
- report cards must decide how to combine the two

Best use:

- long-term architecture

### 2. Create A Blended "Exit Liquidity" Score

Definition:

- compute two sub-scores:
  - market exit score (current DEX liquidity)
  - redemption exit score (protocol / issuer redemption)
- blend them into a new score used for risk surfaces

Pros:

- closer to how users actually think about "can I get out?"
- generalizes across multiple exit routes
- can reflect assets with poor DEX depth but excellent protocol redemption

Cons:

- changes the meaning of the current liquidity score
- risks hiding genuine secondary-market fragility
- requires careful weighting and tiering

Best use:

- report cards and risk summaries, not necessarily the `/liquidity` page

### 3. Add A Redemption-Based Floor To Liquidity Score

Definition:

- keep the current DEX calculation
- if a coin qualifies for verified redemption support, apply a floor or uplift

Pros:

- simple to implement
- quickly fixes harsh penalties for redeemable assets

Cons:

- semantically muddy: a DEX liquidity score stops being a DEX liquidity score
- easy to overrate queue-based or KYC-gated assets
- hard to explain when users see poor pool depth but a high liquidity score

Best use:

- short-term patch only

### 4. Leave Liquidity Alone, Change Report-Card Consumption

Definition:

- keep liquidity score unchanged
- modify report cards so verified redeemability reduces the liquidity penalty or no-liquidity penalty

Pros:

- minimal disruption to methodology and UI
- keeps `/liquidity` honest as a market-depth surface
- solves the "hammered in grades" problem first

Cons:

- does not solve the underlying modeling gap
- users still see low liquidity scores without enough context

Best use:

- near-term mitigation

### 5. Add Context Only: Coverage / Backstop Badges

Definition:

- no score changes
- add badges like `Redeemable`, `Queue Risk`, `Basket Redeem`, `Issuer Redeem`, `Liquid Buffer`

Pros:

- low risk
- easy to ship

Cons:

- purely descriptive
- does not change rankings or grades

Best use:

- should accompany any scoring approach, but not sufficient alone

## What A Generalizable Redemption Backstop Should Measure

Any general solution should score redemption quality on more than just "redeemable: yes/no".

Suggested factors:

1. Access
   - permissionless onchain
   - permissioned / whitelisted
   - offchain / KYC / business-hours

2. Latency
   - atomic / same-tx
   - same-day / short delay
   - queued / maturity-based

3. Capacity
   - immediately redeemable liquid reserves
   - not total reserves
   - for fractional-reserve systems, use liquid buffer only

4. Price certainty
   - deterministic quote
   - basket redemption
   - NAV / delayed settlement

5. Fee / slippage drag
   - direct quote haircut
   - fixed redemption fee
   - dynamic fee schedule

6. Redemption asset quality
   - redeem into USDC / cash equivalents
   - redeem into mixed basket
   - redeem into potentially impaired / volatile collateral

## Suggested Tiering

Illustrative tiers:

- Tier A: atomic, deterministic, permissionless single-asset redemption with ample liquid reserves
- Tier B: atomic or near-atomic redemption, but basket-based or dynamically fee-shaped
- Tier C: redeemable, but queue-based / liquid-buffer constrained
- Tier D: redeemable only via offchain issuer workflow / KYC / settlement window
- Tier E: no reliable redemption path

Mapped examples:

- `cusd-cap`: Tier B
- `iusd-infinifi`: Tier C

## Recommended Direction For Pharos

Best durable approach:

1. Keep the current DEX liquidity score as a pure market-liquidity measure.
2. Add a new redemption / exit-backstop metric.
3. Use both in report cards and risk surfaces via a blended or max-capped "effective exit" interpretation.
4. Keep `/liquidity` explicitly market-focused, but add redemption backstop context there.

Why this is the best fit:

- avoids redefining the existing liquidity score
- generalizes across cUSD, iUSD, and future redeemable assets
- allows different treatment for atomic vs queued redemption systems
- uses infrastructure Pharos already has or is close to having:
  - authoritative redemption quotes for cUSD
  - live reserve composition for infiniFi with liquid/illiquid split

## Practical Implementation Path

### Phase 1: Low-risk improvement

- keep `liquidityScore` unchanged
- add `redemptionBackstop` metadata / badge
- remove or soften report-card liquidity penalties when a coin has a verified backstop

### Phase 2: Structured scoring

- add `redemptionBackstopScore`
- compute from access + latency + capacity + fee + asset-quality factors
- for fractional reserve systems, cap by liquid reserves only

### Phase 3: Blended risk output

- add an `effectiveExitScore` for report cards and safety surfaces
- do not overwrite the raw DEX liquidity score

## Things To Avoid

- Do not replace DEX liquidity with total reserves for fractional-reserve products.
- Do not award high "liquidity" scores to queued / KYC / delayed redemption systems without strong haircuts.
- Do not use manual per-coin exceptions as the long-term model; use tiered provider-backed redemption metadata.
