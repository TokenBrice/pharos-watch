# Borderline decentralized `Blacklistable = No` review

Date: 2026-03-25

Scope: review the two most borderline names left in the residual `Blacklistable = No` set after fixing the CeFi / CeFi-dependent methodology gap.

## Reviewed names

### `hyusd-hylo`

Verdict: keep `decentralized`, keep `Blacklistable = No`

Why:
- Hylo's docs describe the system as decentralized, permissionless, autonomous, and self-contained.
- The backing is a Solana LST basket, not custodial stablecoin reserves or issuer-held fiat assets.
- I did not find documentation for issuer freeze / denylist controls.

Relevant source signals:
- Hylo intro states the protocol is "Decentralized" and "Permissionless":
  https://docs.hylo.so/
- Hylo risk-management docs describe protocol-level mint/redeem controls and a stability pool, not issuer blacklist controls:
  https://docs.hylo.so/protocol-overview/risk-management
- Security section documents audits and onchain addresses, but the reviewed docs did not surface admin blacklist semantics:
  https://docs.hylo.so/security/audits
  https://docs.hylo.so/security/onchain-addresses

### `satusd-river`

Verdict: keep `decentralized`, keep `Blacklistable = No`

Why:
- River docs describe satUSD as an omni-CDP backed by BTC / ETH / BNB / LST collateral, not by custodial stablecoin reserves.
- The strongest governance signal I found cuts against reclassification: River states that "All core protocol contracts are immutable and non-upgradeable".
- River uses LayerZero OFT for cross-chain transport, but that alone is not evidence of issuer blacklist/freeze control.

Relevant source signals:
- River overview:
  https://docs.river.inc/
- River Omni-CDP docs:
  https://docs.river.inc/products/editor
- River bridge docs:
  https://docs.river.inc/basics/editor/bridge

## Conclusion

No metadata changes recommended from this pass.

The residual `Blacklistable = No` set still looks coherent:
- protocol-native decentralized systems
- plus a small number of explicit `false` overrides that were already reviewed separately
