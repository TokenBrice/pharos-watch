# Blacklistability review: 19 suspicious `No` candidates

Date: 2026-03-25

Scope: verify the user-flagged set of coins that looked likeliest to be misclassified as `Blacklistable = No`, and only change metadata where official docs or clearly documented governance mutability justified it.

## Reclassifications applied

- `cusd-celo` -> `"possible"`
- `ceur-celo` -> `"possible"`
- `gbpm-mento` -> `"possible"`

Rationale:
- Mento's official governance docs describe governance control over core protocol contracts and stablecoin system upgrades.
- That is not the same as a documented issuer denylist, so `true` would overstate it.
- It is enough to move these assets out of `No` into `possible`, because the contract system is governance-mutable.

## Verified keep-as-`No`

- `usbd-bima`
  - Keep `No`.
  - Bima docs describe an overcollateralized BTC-backed system with permissionless borrowing/redemption mechanics.
  - I did not find source-backed evidence of an issuer-controlled freeze/denylist path.

- `btcusd-btcfi`
  - Keep `No`.
  - Project docs position it as a decentralized BTC-backed stablecoin design.
  - I did not find blacklist/freeze evidence from official materials.

- `dola-inverse-finance`
  - Keep `No`.
  - Inverse docs emphasize DOLA's onchain FiRM mint/repay and decentralized yield routing.
  - I did not find a documented blacklist or transfer denylist mechanism in the reviewed product docs.

- `dusd-dtrinity`
  - Keep `No`.
  - dTRINITY docs describe protocol controls around reserves and system operations.
  - I did not find evidence of direct address blacklist/freeze powers on the token itself.

- `fpi-frax`
  - Keep `No`.
  - The reviewed Frax docs frame FPI as a protocol stable asset / index token, but I did not find explicit denylist evidence.
  - Current metadata does not justify upgrading to `possible` from docs alone.

- `fxusd-f-x-protocol`
  - Keep `No`.
  - I did not find official documentation showing issuer blacklist/freeze controls.
  - This still looks more like protocol and reserve dependence than blacklistability.

- `gho-aave`
  - Keep `No`.
  - Official Aave/GHO materials explicitly characterize GHO as decentralized and non-custodial.
  - I did not find evidence of centralized transfer blocking; the Aave help copy is directionally consistent with `No`.

- `hollar-hydrated`
  - Keep `No`.
  - Hydration docs describe committee / protocol pause controls, but that is not the same as an address blacklist.
  - No source-backed denylist evidence found.

- `hyusd-hylo`
  - Keep `No`.
  - Hylo docs describe protocol-native collateral and yield mechanics.
  - I did not find issuer blacklist/freeze evidence from official docs.

- `isc-international-stable-currency`
  - Keep `No` for now.
  - This still feels suspicious because of the custody model, but I did not find enough direct official material proving blacklistability.
  - Worth revisiting if contract-level docs or token source become easier to verify.

- `meusd-mezo`
  - Keep `No`.
  - Mezo materials reviewed did not surface a documented denylist/freeze path.
  - Current evidence is not enough to move it.

- `reusd-resupply`
  - Keep `No`.
  - Resupply docs describe protocol mechanics, but I did not find an issuer blacklist signal.
  - No reclassification from docs alone.

- `satusd-river`
  - Keep `No`.
  - River stablecoin materials reviewed did not show explicit blacklist/freeze controls.
  - Current `No` remains defensible.

- `silk-shade-protocol`
  - Keep explicit `false`.
  - This remains reasonable from the current metadata and docs review, though Secret-side contract/admin validation is still lower confidence than EVM cases.

- `usdd-tron-dao-reserve`
  - Keep `No`.
  - Official docs around upgraded USDD describe a freeze-free / tamper-resistant token design.
  - That is strong enough evidence to avoid upgrading it to `possible`.

- `uusd-youves`
  - Keep `No`.
  - youves docs present uUSD as a synthetic overcollateralized stable token.
  - I did not find documented issuer blacklist/freeze controls.

## Sources used

- Mento governance scope: https://docs.mento.org/mento/governance-and-token/governance-scope
- Mento reserve / core concepts: https://docs.mento.org/mento/overview/core-concepts/the-reserve
- GHO docs hub: https://docs.gho.xyz/
- Aave help / GHO FAQ: https://aave.com/help/borrowing/what-is-gho
- USDD docs: https://docs.usdd.io/introduction
- Hydration Hollar docs: https://docs.hydration.net/products/hollar/
- youves stable token docs: https://docs.youves.com/syntheticAssets/stableTokens/Instances-of-Stable-Tokens/
- Hylo docs: https://docs.hylo.so/protocol-overview/earning-yield-with-hyUSD
- Inverse docs: https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola

## Net result

- This 19-coin verification produced 3 reclassifications, all in the Mento family.
- The rest still lack source-backed evidence of issuer blacklist controls.
- After these changes, the active `Blacklistable = No` set shrinks by 3.
