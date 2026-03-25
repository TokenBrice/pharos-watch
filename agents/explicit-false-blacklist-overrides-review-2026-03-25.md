# Explicit `canBeBlacklisted: false` Override Review

Date: 2026-03-25

## Scope

Reviewed the five active stablecoins with an explicit `canBeBlacklisted: false` override:

- `usdh-hermetica`
- `gbpm-mento`
- `rai-reflexer`
- `silk-shade-protocol`
- `cjpy-yamato`

Goal: determine whether the explicit `false` looks justified or whether it may be masking blacklist/freeze capability.

## Baseline

In Pharos, blacklistability means address-level blacklist/freeze capability, not generic governance power or emergency pause rights.

Important consequence:

- Explicit `canBeBlacklisted: false` overrides the normal centralized-governance fallback.
- That makes `false` a strong claim and it should only be used when we have confidence the token itself is not blacklistable.

## Coin-by-Coin

### 1. `rai-reflexer`

Verdict: keep `false`

Why:

- Metadata is internally coherent:
  - `governance: "decentralized"`
  - `custodyModel: "onchain"`
  - reserves: `100% ETH`
- This is a Reflexer CDP-style ETH-backed system, not an issuer-managed fiat token.
- Nothing in local metadata suggests address-freeze controls.

Evidence:

- Local metadata: `shared/data/stablecoins/non-usd.json`
- Reflexer positioning in metadata: ETH-only overcollateralized Safes with redemption controller.

### 2. `cjpy-yamato`

Verdict: keep `false`

Why:

- Metadata is internally coherent:
  - `governance: "decentralized"`
  - `custodyModel: "onchain"`
  - reserves: `100% ETH`
- Official Yamato docs describe CJPY as an ETH-collateralized CDP-style system with on-chain redemption mechanics, not an issuer-freezable token.
- No local or official source found indicating blacklist/freeze controls.

Evidence:

- Local metadata: `shared/data/stablecoins/non-usd.json`
- Yamato docs describe permissionless use and ETH-backed issuance/redeem mechanics:
  - https://docs.yamato.fi/
  - https://docs.yamato.fi/readme/kontorakutoadoresu

### 3. `silk-shade-protocol`

Verdict: keep `false`, but low-confidence note

Why:

- Metadata is mostly coherent with a decentralized protocol:
  - `governance: "decentralized"`
  - `custodyModel: "onchain"`
- SILK is described locally as a vault/redemption-pool/bond-backed system rather than an issuer-managed token.
- The reserve mix includes stablecoins like USDC, but there are no `coinId` links on those reserve slices, so inherited blacklistability is not currently computed from them.
- I did not find local evidence of address blacklist/freeze capability.

Concern:

- Because SILK runs on Secret and uses a custom token stack, this override is harder to validate from local metadata alone than RAI/CJPY.
- Still, based on the repo’s definition of blacklistability, `false` is plausible.

Evidence:

- Local metadata: `shared/data/stablecoins/non-usd.json`
- Official repo surfaced by search:
  - https://github.com/securesecrets/shade

### 4. `gbpm-mento`

Verdict: keep `false`

Why:

- Local metadata says GBPm is a Mento CDP-style asset backed by USDm and governed by Mento’s on-chain reserve mechanism.
- Official Mento docs describe the reserve as transparent and on-chain, with minting/redemption against reserve collateral rather than issuer-controlled address freezes.
- This is governance-dependent and upgradeable, but that is not the same as blacklistability under our methodology.

Concern:

- The override is not strictly necessary from the current heuristic output; the coin already resolves to `false` in practice.
- But it is not obviously wrong.

Evidence:

- Local metadata: `shared/data/stablecoins/non-usd.json`
- Mento docs:
  - https://docs.mento.org/mento/overview/core-concepts/the-reserve
  - https://docs.mento.org/mento/protocol-concepts/governance
  - https://docs.mento.org/mento/mento-protocol/what-why-who-mento

### 5. `usdh-hermetica`

Verdict: suspicious; needs stronger evidence before keeping explicit `false`

Why:

- This is the only reviewed coin with:
  - `governance: "centralized"`
  - `custodyModel: "cex"`
  - KYC-gated mint/redeem in metadata
- Under normal heuristics, centralized governance would default to `true`.
- The explicit `false` therefore suppresses a strong default assumption.
- Hermetica docs show a controller-heavy architecture on Stacks with dedicated minting, redeeming, controller, and emergency-recovery contracts, which increases upgrade/admin surface even if it does not prove blacklisting.
- I did not find direct proof of address blacklist/freeze in the sources reviewed, but I also did not find enough direct evidence to justify overriding centralized fallback to `false`.

Practical read:

- `false` may be correct if the token contract genuinely lacks blacklist/freeze functions.
- But the current repo evidence is not strong enough for that override standard.
- If we keep an override here, `possible` is easier to defend than `false`.
- If we want the most conservative path without fresh contract verification, remove the explicit override and let centralized fallback classify it as `true`.

Evidence:

- Local metadata: `shared/data/stablecoins/usd-minor.json`
- Hermetica docs:
  - https://docs.hermetica.fi/
  - https://docs.hermetica.fi/usdh/how-it-works/technical-primitives
  - https://docs.hermetica.fi/usdh/audits
  - Hiro contract page for `usdh-token-v1`:
    https://explorer.hiro.so/txid/SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1?chain=mainnet

## Recommendation

High confidence:

- Keep `false` for `rai-reflexer`
- Keep `false` for `cjpy-yamato`
- Keep `false` for `gbpm-mento`

Medium confidence:

- Keep `false` for `silk-shade-protocol`

Needs follow-up:

- `usdh-hermetica`

## Suggested Next Step For `usdh-hermetica`

Before changing data, verify the token contract or official technical docs for any of:

- freeze / blacklist
- admin-controlled transfer restriction
- pausability at token-transfer level
- mutable token-controller path that could reasonably justify `possible`

If that verification is not available quickly, the current explicit `false` is weaker than the repo’s own fallback logic and should be reconsidered.
