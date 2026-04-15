# pmUSD Custody Recheck

Date: 2026-04-15

Scope: re-audit `pmusd-precious-metals` after RAAC/pmUSD challenged the Resilience custody label.

## Question

Should pmUSD's report-card `custodyModel` move from `institutional-unregulated` to `onchain` because the RAAC RWf(x) Treasury holds TB and the TokenBlender contract holds ION.au on Ethereum?

## Sources Checked

- Existing Pharos pmUSD audit: `agents/research/2026-04-14-pmusd-rwfx-audit.md`
- Existing Pharos reserve-composition and live-reserve research:
  - `agents/tasks/done/reserve-composition-tracker-findings.md`
  - `agents/research/2026-03-14-live-reserve-data-source-survey.md`
  - `agents/audits/2026-03-21-live-reserve-sync-expansion-audit.md`
- Pharos scoring docs/code:
  - `docs/report-cards.md`
  - `src/app/methodology/sections/core/safety-scores-section.tsx`
  - `shared/lib/report-card-resilience.ts`
- RAAC docs:
  - https://docs.raac.io/rw-fx/
  - https://docs.raac.io/deployment-rwfx/
  - https://docs.raac.io/audits-rwfx/
  - https://docs.raac.io/whitepaper-q1.pdf
- RAAC audit repository:
  - https://github.com/RegnumAurumAcquisitionCorp/audits
  - Pashov RWf(x) V1, V2, and V3 reports
- I-ON Digital sources:
  - https://iondigitalcorp.com/
  - https://iondigitalcorp.com/ionau-collateral-framework-for-pmusd-ionau/
  - I-ON SEC/OTC filings linked from the I-ON site
- DefiLlama stablecoin API: https://stablecoins.llama.fi/stablecoin/332
- CoinGecko coin API: https://api.coingecko.com/api/v3/coins/precious-metals-usd
- Etherscan / on-chain RPC checks for:
  - pmUSD: `0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf`
  - TB: `0x7a7f847fb60b0000e24cce07298dc73df8b8e56a`
  - ION.au: `0xd051c326c9aef673428e6f01eb65d2c52de95d30`
  - RWf(x) Treasury: `0x51c4348af0c6066a2fd31bd968bc0c039fe27342`

## Verified On-Chain Facts

Public RPC reads on 2026-04-15:

| Asset | Address | Name / symbol | Total supply | Relevant balance |
| --- | --- | --- | ---: | ---: |
| pmUSD | `0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf` | Precious Metals USD / pmUSD | `100201203.622222222222222208` | Treasury pmUSD balance: `0` |
| TB | `0x7a7f847fb60b0000e24cce07298dc73df8b8e56a` | TokenBlender / TB | `26531.98` | Treasury TB balance: `26528.794649492399075576` |
| ION.au | `0xd051c326c9aef673428e6f01eb65d2c52de95d30` | Ion Digital / ION.au | `59549.0398` | TB contract ION.au balance: `26531.98` |

Treasury config reads:

- `owner = 0xCa3144AAD1f75557E68B16C8C7e893112418f13C`
- owner is a 2-of-3 Safe-like multisig (`getThreshold() = 2`)
- `market = 0x4E8ef157762F0B8a7aD0d9fF45f86B203A0658CC`
- `baseToken = 0x7A7f847fb60B0000E24cCe07298dC73dF8b8e56A`
- `fToken = 0xC0c17dD08263C16f6b64E772fB9B723Bf1344DdF`
- `xToken = 0x75939CEb9FBa27A545fE27d1CBd228c29123687c`
- `strategy = 0x0000000000000000000000000000000000000000`
- `totalBaseToken = 26528.794649492399075576`

Conclusion: RAAC/pmUSD are right about the immediate token path. The RWf(x) Treasury holds TB on-chain, and TB is backed by ION.au held in the TokenBlender contract.

## Contract Source Facts

Sourcify has verified implementation source for the TB proxy, ION.au implementation, Treasury implementation, and Market implementation.

TokenBlender implementation (`0xd38d289dc319311015e6526f56c15da078e41aae`):

- Header says the system is designed to run in a centralized, admin-controlled manner and suggests a multisig.
- `deposit()`, `withdraw()`, and `swap()` are `onlyRole(MANAGER_ROLE)`.
- `emergencyWithdraw()` is `onlyRole(EMERGENCY_ROLE)`.
- Admins can add/remove supported tokens, update token ratios, pause/unpause, and manage roles.

ION.au implementation (`0xf7832ab9dcea2e3c853b4a110b353c9718db3534`):

- Represents fractional ownership of real-world assets.
- Minting is `onlyRole(MINTER_ROLE)` and constrained by NAV/proof-of-reserves limits.
- The base ERC20 layer is upgradeable, pausable, capped, and role-administered.

RWf(x) Market implementation (`0x11b21afa735e24683f0912d9f6f8a8bfabbeb10e`):

- All mint/redeem actions are gated by `onlyManager()`.
- The manager transfers base token from the caller into Treasury before Treasury mints pmUSD/xPM.
- Manager roles are granted/revoked by admin functions.

RWf(x) Treasury implementation (`0x5fe0f17975819a2c40791e7cf8148c23b902c1d9`):

- Holds/accounting-tracks the base token.
- `redeem()` can return base token, but only through Market.
- Owner controls price oracle, rate provider, settle whitelist, beta, strategy, and base-token cap.

## External Source Facts

- RAAC deployment docs list TB as the mainnet pmUSD BaseToken and list the Market, FractionalToken, LeverageToken, and Treasury addresses.
- RAAC RWf(x) docs state all Market actions are manager-only, authorized Silo managers are multisigs with RAAC as a necessary signatory, no reservePool/registry are used, and liquidation/self-liquidation mechanisms are disabled.
- RAAC whitepaper says RWf(x) silos are backed by an RWA token deployed into the silo treasury, and pmUSD is backed by tokenized in-situ gold reserves through I-ON Digital.
- Pashov RWf(x) audit reports describe RWf(x) as an RWA tokenization protocol using RWA-backed tokens like fractionalized gold as collateral.
- I-ON Digital describes ION.au as a gold-backed digital security / asset-backed security representing fractional ownership of gold reserves, and says the structure uses Article 8 control agreements with institutional custody.
- The I-ON site also names Fireblocks MPC wallet custody/treasury key management and "world-class tier-one custodial partnerships", but I did not verify a specific named regulated custodian, license, or audited custody account that would meet Pharos's `institutional-regulated` or `institutional-top` tier.

## Classification Decision

Keep `custodyModel: "institutional-unregulated"`.

Reasoning:

1. The immediate ERC-20 collateral path is on-chain, but the economic backing is not native on-chain collateral like ETH, WETH, LUSD collateral, or Maker-style crypto collateral.
2. ION.au is a tokenized RWA/security claim. The value of the pmUSD base collateral ultimately depends on I-ON's legal/custody framework, reserve attestations, token-admin controls, and enforceability of the in-situ gold collateral.
3. Pharos already treats tokenized RWA wrappers this way elsewhere: holding BUIDL, USTB, M0/M, or similar tokenized RWA wrappers in a smart contract does not automatically make the custody model `onchain`.
4. `institutional-regulated` is not justified from the evidence checked. I-ON makes regulatory/compliance claims, but I did not verify the specific regulated custodian/license evidence required for the stronger tier.

The implementation change from this recheck is a clarification only:

- pmUSD metadata now explicitly states the on-chain TB/ION.au token path.
- Report-card docs and the public methodology now clarify that tokenized RWA collateral is scored by the ultimate reserve/legal custody layer, not only by wrapper-token location.

No numeric scoring change was made.
