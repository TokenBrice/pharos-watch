# Other Fiat Stablecoins — Research Handover

Batch researched 2026-02-24. 12/13 coins complete (XSGD pending).
**Do not apply changes until the 3 open decisions below are resolved.**

---

## Open Decisions Required

1. **BRZ jurisdiction**: Issuer is Transfero Swiss AG → Switzerland/FINMA-VQF, but rwa.xyz + Twitter bio say Bahamas. Which to use?
2. **JPYC**: Old prepaid token (`geckoId: "jpy-coin"`, addr `0x431d5dff...`, ended Apr 2025) or new FSA-regulated stablecoin (`geckoId: "jpycoin"`, addr `0xe7c3d8c9...`, active Oct 2025+)?
3. **VNX proofOfReserves URL** (shared by VCHF + VGBP): `https://vnx.li/transparency/` returns 404. Remove field entirely, or keep type/provider and blank the URL?

---

## CEUR (52) — Celo Euro

**Current entry location:** `src/lib/stablecoins.ts`, id `"52"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"Mento Reserve holding sUSDS, EURC, CELO, stETH, USDT, USDC, and ETH; overcollateralized at 136%+ with 100% stable-asset backing mandate"` |
| `pegMechanism` | Update | `"Virtual AMM (BiPoolManager) pools on Celo enable arbitrageurs to mint/burn EURm against reserve assets at oracle-enforced EUR rates; trading limits enforced by on-chain circuit breaker"` |
| `jurisdiction` | **Remove** | Germany = Mento Labs dev company, not protocol issuer. Decentralized protocol — field should be absent. |
| `links` | Add all (currently missing) | `{ label: "Website", url: "https://www.mento.org/" }`, `{ label: "Twitter", url: "https://x.com/MentoLabs" }`, `{ label: "Docs", url: "https://docs.mento.org/mento" }`, `{ label: "GitHub", url: "https://github.com/mento-protocol" }` |
| `proofOfReserves` | Add | `{ type: "real-time", url: "https://reserve.mento.org/", provider: "Mento Reserve (on-chain, publicly verifiable)" }` |

### Notes
- Token rebranded from "Celo Euro (CEUR)" to "Mento Euro (EURm)". Name/symbol change in `stablecoins.ts` is a separate decision.
- Ethereum bridged address (`0xEE586e7Eaad39207F0549BC65f19e336942C992f`) has ~$126K supply only — do not add.
- Sources: [reserve.mento.org](https://reserve.mento.org/), [docs.mento.org](https://docs.mento.org/mento/protocol-concepts/reserve)

---

## GYEN (122) — GYEN

**Current entry location:** `src/lib/stablecoins.ts`, id `"122"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"Japanese yen reserves held in FDIC-insured financial institutions, government money-market funds, or U.S. Treasury bills (≤3 months to maturity) per NYDFS guidelines"` |
| `proofOfReserves.provider` | Add | `"The Network Firm"` |
| `links` | Add Docs | `{ label: "Docs", url: "https://stablecoin.z.com/what-are-gyen-and-zusd/" }` |
| `contracts` | Add Arbitrum | `{ chain: "arbitrum", address: "0x589d35656641d6ab57a545f08cf473ecd9b6d5f7", decimals: 6 }` (~1.06B GYEN, 979 holders) |

### Notes
- BSC (`0xb7B6092C16B9012022DC54b6eeB8a60cfeD891a1`) and Polygon (`0x482bc619eE7662759CDc0685B4E78f464Da39C73`) found in older sources but could not be verified — do not add.
- Optimism has same address as Arbitrum but near-zero supply (101 GYEN) — do not add.
- Sources: [stablecoin.z.com/attestation](https://stablecoin.z.com/attestation/), [arbiscan.io](https://arbiscan.io/token/0x589d35656641d6ab57a545f08cf473ecd9b6d5f7)

---

## CADC (145) — CAD Coin

**Current entry location:** `src/lib/stablecoins.ts`, id `"145"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"Canadian dollars and cash equivalents (liquid securities with original maturity ≤ 90 days) held 1:1 in a segregated account at a Canadian financial institution, in trust for CADC holders"` |
| `pegMechanism` | Update | `"Direct 1:1 redemption for CAD through Loon (FINTRAC-registered MSB, formerly issued by PayTrie); CADC is burned on redemption and minted on deposit"` |
| `jurisdiction.license` | Add | `"C10001420"` (Loon Payments Inc., acquired CADC Oct 2025) |
| `links` | Replace + add | Website → `https://loon.finance/`, add `{ label: "Twitter", url: "https://x.com/LoonFinance" }`, add `{ label: "Docs", url: "https://faq.paytrie.com/col/cadc-faqs" }` |
| `proofOfReserves` | Add | `{ type: "self-reported", url: "https://dune.com/cadc/stablecoin", provider: "Loon (on-chain Dune dashboard)" }` |
| `contracts` | Add 4 chains | `{ chain: "ethereum", address: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef", decimals: 18 }`, `{ chain: "polygon", address: "0x9de41aff9f55219d5bf4359f167d1d0c772a396d", decimals: 18 }`, `{ chain: "arbitrum", address: "0x2b28e826b55e399f4d4699b85f68666ac51e6f70", decimals: 18 }`, `{ chain: "base", address: "0x043eb4b75d0805c43d7c834902e335621983cf03", decimals: 18 }` |

### Notes
- ⚠️ Base contract decimals unconfirmed (BaseScan blocked during research). High-confidence 18 based on identical codebase — verify before merging.
- Issuer changed from PayTrie AB Inc. (FINTRAC M19690633) to Loon Payments Inc. (C10001420) in Oct 2025.
- Sources: [loon.finance](https://loon.finance/), [prnewswire Loon acquisition](https://www.prnewswire.com/news-releases/loon-raises-3-million-to-build-canadas-regulated-digital-dollar-acquires-cadc-stablecoin-302594051.html)

---

## VCHF (157) — VNX Swiss Franc

**Current entry location:** `src/lib/stablecoins.ts`, id `"157"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"CHF held 1:1 in bank and custody accounts of VNX Commodities AG in Switzerland and Liechtenstein, independently audited by Areva General Auditing and Trust Company Limited"` |
| `pegMechanism` | Update | `"Direct 1:1 redemption through VNX Commodities AG; tokens minted on demand for verified customers depositing equivalent CHF value"` |
| `jurisdiction.license` | Update | `"Blockchain Act"` → `"TVTG (Blockchain Act)"` |
| `links.Website` | ⚠️ Verify | `https://vnx.li/vchf/` returned 404 during research. Replace with `https://vnx.li/` if dead. |
| `links` | Add Docs | `{ label: "Docs", url: "https://vnx.gitbook.io/vnx-platform/" }` |
| `proofOfReserves` | ⚠️ Dead URL — see decision #3 | Current URL `https://vnx.li/transparency/` returns 404. Provider is `"Areva General Auditing and Trust Company Limited"`. |
| `contracts` | Add 3 chains | `{ chain: "base", address: "0x1fca74d9ef54a6ac80ffe7d3b14e76c4330fd5d8", decimals: 18 }` (dominant chain ~177K VCHF), `{ chain: "arbitrum", address: "0x02cea97794d2cfb5f560e1ff4e9c59d1bec75969", decimals: 18 }` (verified Arbiscan), `{ chain: "avalanche", address: "0x228a48df6819ccc2eca01e2192ebafffdad56c19", decimals: 18 }` (~549K VCHF on SnowScan) |

### Notes
- Polygon (`0xcdb3867...`) and Celo (`0xc5ebea99...`) contracts exist but supply data insufficient — excluded.
- Sources: [arbiscan VCHF](https://arbiscan.io/token/0x02cea97794d2cfb5f560e1ff4e9c59d1bec75969), [messari VNX report](https://messari.io/report/vnx-a-regulatory-grade-issuance-layer-for-non-usd-stablecoins)

---

## AUDD (165) — AUDD

**Current entry location:** `src/lib/stablecoins.ts`, id `"165"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"Australian dollar cash and cash equivalents, including Treasury bills and notes, held in segregated accounts at Australian Authorised Deposit-taking Institutions by AUDC Pty Ltd"` |
| `pegMechanism` | Update | `"Direct 1:1 redemption for AUD through AUDC Pty Ltd (AFSL No. 700123, Novatti subsidiary), with monthly independent reserve attestations by William Buck"` |
| `jurisdiction.license` | Update | `"AFSL"` → `"AFSL No. 700123"` |
| `proofOfReserves.url` | Fix | `https://www.audd.digital/` → `https://www.audd.digital/transparency/` |
| `proofOfReserves.provider` | Fix | `"William Buck Audit"` → `"William Buck"` |
| `links` | Add | `{ label: "Docs", url: "https://www.audd.digital/wp-content/uploads/2024/05/AUDD-Whitepaper_MAY2024.pdf" }`, `{ label: "Proof of Reserve", url: "https://www.audd.digital/transparency/" }` |
| `contracts` | Add Base | `{ chain: "base", address: "0x449b3317a6d1efb1bc3ba0700c9eaa4ffff4ae65", decimals: 6 }` |

### Notes
- Sources: [audd.digital/faq](https://www.audd.digital/faq/), [audd.digital/transparency](https://www.audd.digital/transparency/), [AFSL announcement](https://www.audd.digital/audc-granted-afsl-by-asic-for-non-cash-payment-facilities/)

---

## BRZ (249) — Brazilian Digital

**Current entry location:** `src/lib/stablecoins.ts`, id `"249"`

### Changes

| Field | Action | Value |
|---|---|---|
| `contracts[ethereum]` | ⚠️ Fix deprecated | `0x420412e765bfa6d85aaac94b4f7b708c89be2e2b` (4 dec, deprecated) → `0x01d33fd36ec67c6ada32cf36b31e88ee190b1839`, decimals: **18** |
| `contracts` | Add 5 chains | `{ chain: "polygon", address: "0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc", decimals: 18 }`, `{ chain: "bsc", address: "0x71be881e9c5d4465b3fff61e89c6f3651e69b5bb", decimals: 4 }`, `{ chain: "gnosis", address: "0x0a06c8354a6cc1a07549a38701eac205942e3ac6", decimals: 18 }`, `{ chain: "base", address: "0xe9185ee218cae427af7b9764a011bb89fea761b4", decimals: 18 }`, `{ chain: "arbitrum", address: "0xa8940698fda5a07abaef4a5ccdf2f1bb525b47a2", decimals: 18 }` |
| `collateral` | Update | `"Brazilian real (BRL) cash reserves held at a financial institution authorized by the Central Bank of Brazil"` |
| `pegMechanism` | Update | `"1:1 mint and redemption at Transfero for BRL; KYC verification required; redemption incurs a 1% fee in Brazil"` |
| `jurisdiction` | ⚠️ See decision #1 | Current Brazil/BACEN is incorrect (describes custodian, not issuer). Options: Switzerland/FINMA-VQF (Transfero Swiss AG) or Bahamas (rwa.xyz + Twitter bio). |
| `links` | Add Docs | `{ label: "Docs", url: "https://docs.transfero.com/" }` |
| `proofOfReserves` | Add | `{ type: "self-reported", url: "https://transfero.com/wp-content/uploads/2024/12/daily-report.pdf", provider: "Transfero" }` — note: PDF was last updated Dec 2024, may be stale |

### Notes
- Gnosis has ~133M BRL — the largest chain by supply. BSC uses 4 decimals (same as old ETH contract).
- Sources: [Etherscan migration notice](https://etherscan.io/token/0x420412e765bfa6d85aaac94b4f7b708c89be2e2b), [Gnosis Blockscout](https://gnosis.blockscout.com/tokens?q=BRZ), [rwa.xyz BRZ](https://app.rwa.xyz/assets/BRZ)

---

## VGBP (292) — VNX British Pound

**Current entry location:** `src/lib/stablecoins.ts`, id `"292"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"GBP deposits held in bank accounts in Switzerland and Liechtenstein, confirmed 1:1 by Areva General Auditing and Trust Company Limited (December 2024)"` |
| `links.Website` | ⚠️ Dead | `https://vnx.li/vgbp/` returns 404 → replace with `https://vnx.li/` |
| `proofOfReserves` | ⚠️ Dead URL — see decision #3 | Add `provider: "Areva General Auditing and Trust Company Limited"`. URL `https://vnx.li/transparency/` is dead. |
| `contracts[ethereum]` | Remove | `0x34c9c643...` has zero supply since Nov 2024 (migrated off Ethereum) |
| `contracts` | Add Base + Celo | `{ chain: "base", address: "0xaeb4bb7debd1e5e82266f7c3b5cff56b3a7bf411", decimals: 18 }` (~54K VGBP), `{ chain: "celo", address: "0x7ae4265ecfc1f31bc0e112dfcfe3d78e01f4bb7f", decimals: 18 }` (~10K VGBP) |

### Notes
- Solana has most supply (~61K) but is not in chains.ts.
- The dead PoR URL and dead website are shared with VCHF — systemic VNX site restructure.
- Sources: [basescan VGBP](https://basescan.org/token/0xaeb4bb7debd1e5e82266f7c3b5cff56b3a7bf411), [vnx.gitbook.io VGBP token details](https://vnx.gitbook.io/vnx-platform/vnx-british-pound/token-details)

---

## PHT (299) — PHT Stablecoin

**Current entry location:** `src/lib/stablecoins.ts`, id `"299"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"apcxUSDT (1:1 USDT-backed custodial token) in overcollateralized CDP vaults; future phases to add USDC, USDT, and other approved stablecoins as collateral types"` |
| `pegMechanism` | Update | `"Overcollateralized CDP vaults (MakerDAO MCD fork): users deposit apcxUSDT as collateral to mint PHT; undercollateralized vaults liquidated via Dutch auction; Chainlink PHP/USD oracle; LayerZero OFT for cross-chain bridging"` |
| `jurisdiction` | Add | `{ country: "Singapore" }` |
| `links` | Add | `{ label: "Twitter", url: "https://x.com/apacx_io" }`, `{ label: "Docs", url: "https://docs.apacx.io/" }`, `{ label: "Audit", url: "https://docs.apacx.io/technical-references/smart-contract-audits" }` |
| `contracts` | Add ETH | `{ chain: "ethereum", address: "0xbe370ad45d44eb45174c4ec60b88839fef32c077", decimals: 18 }` |

### Notes
- Tron has ~44.5M PHP supply but full address unverifiable — do not add.
- Polygon address `0xe75220cB014Dfb2D354bb59be26d7458bB8d0706` is an Authority/admin contract, NOT the token — do not add.
- Audit DocSend links are dead; the audit page itself (`docs.apacx.io/...audits`) is live.
- Sources: [docs.apacx.io](https://docs.apacx.io/what-is-pht/pht-overview)

---

## TRYB (300) — BiLira

**Current entry location:** `src/lib/stablecoins.ts`, id `"300"`

### Changes

| Field | Action | Value |
|---|---|---|
| `collateral` | Update | `"Turkish lira cash reserves held in Turkish bank accounts; independently audited with reports published regularly"` |
| `links` | Add | `{ label: "Audit Reports", url: "https://www.bilira.co/en/audit-reports" }`, `{ label: "Proof of Reserve", url: "https://dune.com/biliraofficial/bilira-official" }` |
| `proofOfReserves` | Add | `{ type: "independent-audit", url: "https://www.bilira.co/en/audit-reports" }` — provider omitted (historical: RSM 2022, JPA 2021; current firm unconfirmed) |
| `contracts` | Add 4 chains | `{ chain: "bsc", address: "0xc1fdbed7dac39cae2ccc0748f7a80dc446f6a594", decimals: 6 }`, `{ chain: "avalanche", address: "0x564a341df6c126f90cf3ecb92120fd7190acb401", decimals: 6 }`, `{ chain: "polygon", address: "0x4fb71290ac171e1d144f7221d882becac7196eb5", decimals: 6 }`, `{ chain: "base", address: "0xfb8718a69aed7726afb3f04d2bd4bfde1bdcb294", decimals: 6 }` |

### Notes
- All new chain decimals inferred as 6 (matches Ethereum + consistent across all known deployments). Block explorer API verification blocked; addresses sourced from official bilira.co/en/use-tryb page.
- Sources: [bilira.co/en/use-tryb](https://www.bilira.co/en/use-tryb), [bilira.co/en/audit-reports](https://www.bilira.co/en/audit-reports)

---

## tGBP (317) — Tokenised GBP

**Current entry location:** `src/lib/stablecoins.ts`, id `"317"`

### Changes

| Field | Action | Value |
|---|---|---|
| `contracts[ethereum]` | ⚠️ Critical fix — wrong token | Current `0x00000000441378008ea67f4284a57932b1c000a5` is **TrueGBP by a different issuer**. Correct: `0x27f6c8289550fce67f6b50bed1f519966afe5287`, decimals: 18 |
| `contracts` | Add 4 chains | Base, BSC, Polygon, Avalanche — all at same address `0x27f6c8289550fce67f6b50bed1f519966afe5287`, decimals: 18 (LayerZero OFT, confirmed by RWA.xyz + DefiLlama) |
| `collateral` | Update | `"Cash and short-term UK government bonds (zero-coupon gilts) held in a segregated account at a UK-regulated financial institution, custodied by Enumis Limited"` |
| `pegMechanism` | Update | `"Direct 1:1 redemption through BCP Technologies Ltd; clients deposit GBP off-chain and receive minted tGBP on-chain; redemption burns tokens and triggers fiat withdrawal"` |
| `jurisdiction.license` | Add | `"Cryptoasset AML Registration (FRN: 928840)"` |
| `links` | Add | `{ label: "Twitter", url: "https://x.com/tokenGBP" }`, `{ label: "Audit", url: "https://www.openzeppelin.com/news/tgbp-audit" }` |

### Notes
- proofOfReserves not added — only available audit is an OpenZeppelin smart contract audit, not a reserve attestation.
- DefiLlama supply: ETH ~1.9M, Base ~797K, BSC ~300K, Polygon ~157K, Avalanche ~16K.
- Sources: [etherscan tGBP](https://etherscan.io/token/0x27f6c8289550fce67f6b50bed1f519966afe5287), [rwa.xyz tGBP](https://app.rwa.xyz/assets/tGBP), [OpenZeppelin audit](https://www.openzeppelin.com/news/tgbp-audit)

---

## JPYC (cg-jpyc) — JPY Coin

**Current entry location:** `src/lib/stablecoins.ts`, id `"cg-jpyc"`

### ⚠️ Decision Required — See Decision #2

Two separate JPYC tokens exist:

| | Old (current entry) | New (FSA-regulated) |
|---|---|---|
| geckoId | `jpy-coin` | `jpycoin` |
| ETH address | `0x431d5dff03120afa4bdf332c61a6e1766ef37bdb` | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` |
| Classification | Prepaid Payment Instrument | Electronic Payment Instrument |
| Status | Bridge ended Apr 2025 | FSA-approved Oct 2025, active |
| Supply | 2.63B (still circulating) | 553M (active) |

### Changes if updating to new regulated token:

| Field | Action | Value |
|---|---|---|
| `geckoId` | Update | `"jpy-coin"` → `"jpycoin"` |
| `contracts[ethereum]` | Update | `0x431d5dff...` → `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`, decimals: 18 |
| `contracts` | Add Polygon + Avalanche | Both at `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`, decimals: 18 |
| `pegMechanism` | Update | `"Direct 1:1 redemption for JPY through JPYC Inc. via the JPYC EX platform; issuance and redemption via bank transfer after KYC; JPYC Inc. holds a Type II Funds Transfer Service Provider license under Japan's Payment Services Act"` |
| `jurisdiction.license` | Add | `"Type II Funds Transfer Service Provider (Payment Services Act)"` |
| `links.Website` | Update | `https://corporate.jpyc.co.jp/en` → `https://jpyc.co.jp/` |
| `links` | Add | `{ label: "Twitter", url: "https://x.com/jpyc_official" }`, `{ label: "GitHub", url: "https://github.com/jpycoin" }` |

### Changes if keeping old prepaid token (no geckoId/contract change):

| Field | Action | Value |
|---|---|---|
| `jurisdiction.license` | Add | `"Type II Funds Transfer Service Provider (Payment Services Act)"` |
| `links` | Add Twitter + GitHub | `https://x.com/jpy_coin`, `https://github.com/jpycoin` |

---

## ZARP (cg-zarp) — ZARP Stablecoin

**Current entry location:** `src/lib/stablecoins.ts`, id `"cg-zarp"`

### Changes

| Field | Action | Value |
|---|---|---|
| `links.Website` | ⚠️ Critical fix — wrong domain | `https://zarp.co.za/` is a South African **seed company**. Correct: `https://www.zarpstablecoin.com/` |
| `collateral` | Update | `"South African rand cash reserves held 1:1 in a treasury managed by Old Mutual Wealth, independently audited by Kempen Audit"` |
| `pegMechanism` | Update | `"Mint/burn 1:1 with ZAR through ZARP Stablecoin (Pty) Ltd issuing partners; reserves may not be used for any purpose other than redemption"` |
| `jurisdiction` | Update | Add `regulator: "FSCA"`, `license: "CASP license pending"` |
| `links` | Add | `{ label: "Twitter", url: "https://x.com/ZARP_Stablecoin" }`, `{ label: "Docs", url: "https://docs.zarpstablecoin.com/zarp-stablecoin" }`, `{ label: "GitHub", url: "https://github.com/venox-digital-assets/zarp.contract" }` |
| `contracts` | Add Base + Polygon | Both at `0xb755506531786c8ac63b756bab1ac387bacb0c04`, decimals: 18 (same address as Ethereum — LayerZero/EVM nonce-matched deployment) |
| `proofOfReserves` | Add | `{ type: "independent-audit", url: "https://kempengroup.co.za/wp-content/uploads/2025/09/ZARP-Stablecoin-Pty-Ltd-Agreed-upon-procedures-report-2025-09-04-1757061801998.pdf", provider: "Kempen Audit" }` |

### Notes
- Sources: [zarpstablecoin.com/transparency](https://www.zarpstablecoin.com/transparency/), [Kempen attestation Sep 2025](https://kempengroup.co.za/wp-content/uploads/2025/09/ZARP-Stablecoin-Pty-Ltd-Agreed-upon-procedures-report-2025-09-04-1757061801998.pdf)

---

## Summary of Critical Data Errors Found

| Coin | Issue |
|---|---|
| tGBP | Wrong contract address — current entry points to a different token (TrueGBP) |
| BRZ | Deprecated Ethereum contract with wrong decimals (4 → 18) |
| ZARP | Website links to a South African seed company |
| CADC | Issuer changed (PayTrie → Loon, Oct 2025) — entire entry stale |
| VGBP | Ethereum contract has zero supply since Nov 2024 |
| VCHF + VGBP | proofOfReserves and website URLs dead (VNX site restructure) |
