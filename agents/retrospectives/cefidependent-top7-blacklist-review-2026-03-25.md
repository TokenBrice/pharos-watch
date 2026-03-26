# CeFi-Dependent Top 7 Blacklist Review

Date: 2026-03-25

## Scope

Reviewed the seven highest-priority active stablecoins that were:

- `governance: centralized-dependent`
- resolving to `Blacklistable = No`
- architecturally most likely to be under-attributed

Coins reviewed:

- `usdu-unitas`
- `dusd-standx`
- `nusd-neutrl`
- `yzusd-yuzu`
- `reusd-re-protocol`
- `usp-pikudao`
- `usr-resolv`

## Verdicts

### 1. `nusd-neutrl`

Recommendation: change from `No` to `Yes`

Why:

- This is the strongest confirmed misclassification.
- An audit hosted on `docs.neutrl.fi` explicitly states:
  - `NUSD DENYLIST_MANAGER_ROLE can prevent arbitrary NUSD transfers`
  - `NUSD REDEEMER_ROLE can burn arbitrary NUSD amounts from arbitrary addresses`
  - `SNUSD BLACKLIST_MANAGER_ROLE can prevent arbitrary sNUSD transfers`
- That is direct blacklist / denylist capability, not just operational gating.

Evidence:

- Spearbit review hosted on Neutrl docs:
  - https://docs.neutrl.fi/pdf/report-cantinacode-neutrl-2407.pdf
  - See especially lines surfaced in [turn3view0]:
    - `NUSD DENYLIST_MANAGER_ROLE can prevent arbitrary NUSD transfers`
    - `NUSD REDEEMER_ROLE can burn arbitrary NUSD amounts from arbitrary addresses`
- Separate public audit contest report also discusses blacklisted-user bypass scenarios:
  - https://docs.neutrl.fi/pdf/2025.09.12%20-%20Final%20-%20Neutrl%20Public%20Audit%20Contest%20Report.pdf

Conclusion:

- `NUSD` should not be `No`.
- It meets the repo’s strongest blacklistability standard and should be `true`.

### 2. `usdu-unitas`

Recommendation: change from `No` to `Possible`

Why:

- Unitas docs describe USDu mint/redeem as permissioned:
  - only whitelisted addresses can mint or redeem
  - KYC/AML may be required and access may be refused, suspended, or terminated
- Unitas also relies on Copper / Ceffu off-exchange settlement and centralized operational controls for hedging and redemption liquidity.
- However, Unitas terms also say the protocol cannot unilaterally modify user balances.

Evidence:

- Unitas terms:
  - https://docs.unitas.so/resources/terms-of-service
  - states KYC/AML checks may be required and access may be suspended or terminated
  - also states Unipay cannot unilaterally modify user balances
- Unitas minting docs:
  - https://docs.unitas.so/solution-design/minting-usdu
  - says only whitelisted addresses may mint or redeem USDu
- Unitas custody docs:
  - https://docs.unitas.so/backing-custody-and-security/off-exchange-settlement-oes-in-unitas

Conclusion:

- I do not see evidence for `true`.
- But `No` looks too optimistic for a whitelisted, centrally managed, off-exchange-settlement architecture.
- `possible` is the best fit.

### 3. `dusd-standx`

Recommendation: change from `No` to `Possible`

Why:

- StandX docs show a centrally managed redemption flow:
  - users redeem DUSD for `USDT` / `USDC`
  - the StandX server validates orders
  - contract roles include `ADMIN`, `GATEKEEPER`, and `GATEWAY`
  - `GATEKEEPER` can pause redemptions in emergencies
  - docs mention emergency pause functionality and role-managed controls
- I did not find direct evidence of address-level blacklist/freeze on the token itself.

Evidence:

- StandX redemption docs:
  - https://docs.standx.com/docs/dusd-solutions/redeeming-dusd
- StandX FAQ / user guide:
  - https://docs.standx.com/docs/dusd-overview/product-faq
  - https://docs.standx.com/docs/dusd-overview/user-guide
- Risk / hedging overview:
  - https://docs.standx.com/docs/dusd-solutions/risks-hedging-system

Conclusion:

- `true` is not established.
- `possible` is more defensible than `No`.

### 4. `yzusd-yuzu`

Recommendation: change from `No` to `Possible`

Why:

- Yuzu docs explicitly say mint/redeem is gated:
  - only eligible investors
  - KYC/AML/KYB/SoF/SoW checks
  - Yuzu may deny, pause, or revoke mint/redeem access
- That is not the same as token blacklist capability, but it is a strong centralized control surface around issuance/redemption.

Evidence:

- Yuzu stablecoin docs:
  - https://yuzu-money.gitbook.io/yuzu-money/defi-suite/yuzu-stablecoin-yzusd
- yzPP docs:
  - https://yuzu-money.gitbook.io/yuzu-money/yuzu-stablecoin/yuzu-protection-pool-yzpp

Conclusion:

- No evidence for direct token freeze/denylist.
- `possible` is a better representation than `No`.

### 5. `usp-pikudao`

Recommendation: change from `No` to `Possible`

Why:

- Piku docs explicitly require KYC/KYB and wallet whitelisting for mint/redeem.
- USP minting uses `USDC`; redemption returns `USDC`.
- This is a tightly controlled issuer/platform flow, even if I did not find direct token blacklist language.

Evidence:

- Minting and redemption:
  - https://docs.piku.co/piku/piku/minting-and-redemption
- Mint USP:
  - https://docs.piku.co/piku/piku/minting-and-redemption/how-to-mint-usp
- Redeem USP:
  - https://docs.piku.co/piku/piku/minting-and-redemption/how-to-redeem-usp
- KYC/KYB verification and wallet whitelisting:
  - https://docs.piku.co/piku/piku-platform/kyc-kyb-verifications

Conclusion:

- `No` undersells the centralized control surface.
- `possible` is the better label.

### 6. `usr-resolv`

Recommendation: change from `No` to `Possible`

Why:

- Resolv docs say supply operations require whitelisting before interacting with the contracts.
- Docs also describe KYC/AML requirements, MPC-managed critical controls, and control over redemptions config / access manager / custodian manager.
- I did not find direct evidence that the token itself can blacklist arbitrary holders.

Evidence:

- Token supply operations:
  - https://docs.resolv.xyz/litepaper/for-developers/token-supply-operations
  - says interacting addresses must be whitelisted
- USR overview:
  - https://docs.resolv.xyz/litepaper/overview/usr
- FAQ / access controls:
  - https://docs.re.xyz/
  - notes KYC/AML mandatory and critical controls run via MPC multisig

Conclusion:

- This looks more like a `possible` than a clean `No`.

### 7. `reusd-re-protocol`

Recommendation: change from `No` to `Possible`

Why:

- Re Protocol docs require KYC/AML and restrict eligibility by jurisdiction.
- Critical controls are explicitly run through MPC multisig wallets, including:
  - oracle config
  - redemptions config
  - access manager
  - custodian manager
- reUSD redemption is centrally managed via instant buffer / queue / actuarial release logic.
- I did not find direct evidence of token-level denylist/freeze.

Evidence:

- FAQ / protocol docs:
  - https://docs.re.xyz/
- Disclaimers:
  - https://docs.re.xyz/disclaimers
- reUSD overview:
  - https://docs.re.xyz/insurance-capital-layers/what-is-reusd
- Redemption process:
  - https://docs.re.xyz/protocol/redemption-process-and-liquidity

Conclusion:

- `No` is too weak for the amount of centrally operated control and eligibility gating described.
- `possible` is more defensible.

## Summary Table

- `nusd-neutrl` → `true`
- `usdu-unitas` → `possible`
- `dusd-standx` → `possible`
- `yzusd-yuzu` → `possible`
- `usp-pikudao` → `possible`
- `usr-resolv` → `possible`
- `reusd-re-protocol` → `possible`

## Confidence

Highest confidence:

- `nusd-neutrl` → `true`

High confidence:

- `usdu-unitas` → `possible`
- `dusd-standx` → `possible`
- `yzusd-yuzu` → `possible`
- `usp-pikudao` → `possible`

Medium confidence:

- `usr-resolv` → `possible`
- `reusd-re-protocol` → `possible`

## Suggested Next Step

If we want to align the blacklist badge with actual centralized control risk rather than only direct token denylist proof, the next metadata patch should be:

- set `nusd-neutrl.canBeBlacklisted = true`
- set `usdu-unitas.canBeBlacklisted = "possible"`
- set `dusd-standx.canBeBlacklisted = "possible"`
- set `yzusd-yuzu.canBeBlacklisted = "possible"`
- set `usp-pikudao.canBeBlacklisted = "possible"`
- set `usr-resolv.canBeBlacklisted = "possible"`
- set `reusd-re-protocol.canBeBlacklisted = "possible"`
