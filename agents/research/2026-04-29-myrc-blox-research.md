# MYRC (Blox) Research Packet

**Date:** 2026-04-29
**Author:** research subagent
**Goal:** Gather every metadata field Pharos needs to add MYRC, the Malaysian-Ringgit-pegged stablecoin issued by Blox Blockchain Sdn Bhd.

---

## Headline Findings

- Canonical Pharos ID recommended: **`myrc-blox`**
- Active deployments verified on **4 chains**: Ethereum, Arbitrum, Base, Solana
- **Blocker:** `MYR` is not in `PEG_CURRENCY_VALUES` (`shared/types/core.ts`). Adding MYRC requires extending the enum.
- Not present in DefiLlama stablecoins list (`stablecoins.llama.fi/stablecoins`) — must run via `detailProvider: "coingecko"`.
- CoinGecko ID `blox-myrc` confirmed (~$1.33M cap, ~5.31M MYRC).
- Issuer is unlicensed by both SC Malaysia and Bank Negara — operates in a regulatory grey zone.

---

## 1. Identity

| Field | Value | Source |
|---|---|---|
| Pharos canonical ID | `myrc-blox` | repo convention `ticker-issuer` |
| `name` | `MYRC` | CoinGecko, Etherscan, Basescan, Arbiscan |
| `symbol` | `MYRC` | All chain explorers |
| `geckoId` | `blox-myrc` | https://www.coingecko.com/en/coins/blox-myrc |
| `cmcSlug` | Unverified — no CMC stablecoin page found in research | — |
| `llamaId` | **Not in DefiLlama** (queried full `peggedAssets` list, no match) | https://stablecoins.llama.fi/stablecoins |
| `protocolSlug` | Not applicable (not a DefiLlama protocol) | — |
| `detailProvider` | Recommend `coingecko` (DefiLlama path unavailable) | per `adding-a-stablecoin.md` Phase 4 |
| Issuer legal entity | **Blox Blockchain Sdn Bhd** | The Edge Malaysia interview, theedgemalaysia.com/node/787125 |
| Country | Malaysia | issuer site, multiple sources |
| Regulator | None — Securities Commission Malaysia disclaimed jurisdiction (not a security); Bank Negara Malaysia has no stablecoin framework yet | The Edge Malaysia, Cointrust |
| License | None held; not in any sandbox | The Edge Malaysia |

---

## 2. Contracts

All four chains exist as keys in `shared/lib/chains.ts` (verified): `ethereum`, `arbitrum`, `base`, `solana`.

| Chain | Address | Decimals | Verification |
|---|---|---|---|
| `ethereum` | `0xbed7d999f1d71ac70c263f64c7c7e009d691be2e` | 18 | Etherscan: contract verified, "MYRC", 18 decimals, restrictAddress + MINTER_ROLE / POLICE_ROLE / ADMIN. Admin/minter/police all `0xCCa0793222422E8aC1dD48DB1Aa691f9D360A1c2`. |
| `arbitrum` | `0x3ed03e95dd894235090b3d4a49e0c3239edce59e` | 18 | Arbiscan: contract verified, "MYRC", 18 decimals, restrictAddress + role-based access (DEFAULT_ADMIN / MINTER / POLICE), ERC20Permit. |
| `base` | `0x3ed03e95dd894235090b3d4a49e0c3239edce59e` | 18 | Basescan: contract verified, "MYRC", 18 decimals, restrictAddress + same role architecture. |
| `solana` | `myrcAs6bpP2g5oGHZ3qpgrfZQAFkbo9KUHdqYDXMjGv` | 6 | Solana mainnet RPC `getAccountInfo` jsonParsed: `decimals: 6`, `freezeAuthority` and `mintAuthority` both `Df8T8pvEx7WmC4RjBmzcDqLfuKDLf9wWxSzMvQ95Ln4z`. Mint is owned by SPL Token program. |

**Important:** EVM addresses must be saved lowercase (per Phase 2 quality rules). Solana mint stays in its mixed-case base58 native form. Note Arbitrum and Base share an identical address (deterministic deploy, common pattern).

EVM contracts include `restrictAddress(account, restricted)` callable by `POLICE_ROLE` — this is a working blacklist surface. The Solana mint has both `freezeAuthority` and `mintAuthority` set. Therefore `canBeBlacklisted: true`.

---

## 3. Peg + Collateral

| Field | Value | Source |
|---|---|---|
| `flags.backing` | `rwa-backed` | 1:1 fiat MYR reserves |
| `flags.pegCurrency` | `MYR` | issuer pages, CoinGecko description |
| `flags.governance` | `centralized` | single admin/minter EOA on EVM, single mint+freeze authority on Solana |
| `flags.yieldBearing` | `false` | no yield disclosed |
| `flags.rwa` | `true` | fiat cash deposits = RWA |
| `flags.navToken` | `false` | not a NAV/wrapper |

**`MYR` is NOT in `PEG_CURRENCY_VALUES`** (currently: USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, CNH, PHP, MXN, UAH, ARS, GOLD, SILVER, VAR, OTHER). Adding MYRC requires either:
- extending the enum to add `"MYR"` (preferred, FX-plumbing-aware), or
- using `"OTHER"` as a placeholder (loses semantic value, breaks future MYR FX work).

The 2026-04-21 sweep already flagged this as the blocker for MYRC.

### Collateral (prose)

> Malaysian Ringgit cash deposits held in a ring-fenced bank account at Maybank (Malayan Banking Berhad), under custody and trustee services of Universal Trustee (Malaysia) Bhd (UTMB). Account is jointly titled in the name of UTMB and Blox. Reserve account previously held at CIMB Bank; transitioning to Maybank/UTMB structure (announced by Blox CFO Ashwin Chockalingam, per The Edge Malaysia 2026 reporting).

### Peg mechanism (prose)

> 1:1 mint/redeem against Malaysian Ringgit. Users deposit MYR via Malaysian payment rails (FPX) or bank transfer to mint MYRC; users burn MYRC to receive MYR directly to a linked Malaysian bank account. Eligibility requires Malaysian eKYC (MyKad verification) and a linked Malaysian bank account. All transaction fees are currently waived — Blox absorbs fees per its published Transaction Fee Structure policy. Mint authority is restricted to the Blox-controlled key on each chain.

### Proof of reserves

| Field | Value |
|---|---|
| `type` | `independent-audit` (monthly attestations by certified Malaysian accountants; specific audit firm name **not publicly disclosed**) |
| `url` | `https://www.blox.my/myrc/transparency` |
| `provider` | "Independent Malaysian accounting firm (name not publicly disclosed)" — verify against the latest attestation PDF before saving |

> Note: I was unable to surface the specific audit firm name from public sources or the transparency page (the page is JavaScript-rendered and WebFetch could not extract dynamic content). Recommend manual visit to `https://www.blox.my/myrc/transparency` to download a sample attestation PDF and read the auditor signature before saving the registry entry.

---

## 4. Reserves Composition

Public materials describe reserves as 100% MYR cash deposits held in the Maybank/UTMB trustee account. There is no disclosed Treasury bill or other instrument allocation. Until the latest attestation PDF can be reviewed manually, propose:

```json
"reserves": [
  { "name": "MYR cash deposits at Maybank (UTMB trustee)", "pct": 100, "risk": "low" }
]
```

Risk tier rationale: `low` rather than `very-low` because:
- Single-bank concentration (Maybank only, no multi-bank diversification disclosed)
- Single-jurisdiction concentration (Malaysia only; capital controls plausible)
- Auditor identity not publicly named on the transparency page
- Issuer unlicensed; no statutory deposit-segregation guarantee analogous to a regulated stablecoin issuer

If Pharos already grades USD bank deposits at large US/EU banks as `very-low`, the Malaysian-jurisdiction + single-bank + unlicensed-issuer combination warrants the one-tier downgrade to `low`.

---

## 5. Resilience Overrides (Phase 3)

| Field | Recommended value | Rationale |
|---|---|---|
| `chainTier` | `ethereum` | Ethereum is in the `contracts[]` set; Pharos picks the strongest chain tier per `adding-a-stablecoin.md` defaults |
| `deploymentModel` | `native-multichain` | Independent native ERC-20 contracts on each EVM chain (no canonical bridge between Ethereum/Arbitrum/Base — Arbitrum and Base share an address but each is its own deployment, separate from Ethereum), plus a separate Solana SPL mint. Issuer mints natively on each chain. |
| `collateralQuality` | `rwa` | MYR cash deposits |
| `custodyModel` | `institutional-regulated` | Maybank is a Malaysian licensed bank; UTMB is a licensed Malaysian trustee. The issuer itself is unlicensed but the **custodian** is regulated, which is what `custodyModel` measures. |
| `governanceQuality` | `single-entity` | Single admin/minter/police EOA on EVM and single Solana mint+freeze authority. Not `regulated-entity` because the *issuer* (Blox Blockchain Sdn Bhd) is not licensed. |

---

## 6. Links

```json
"links": [
  { "label": "Website", "url": "https://www.blox.my" },
  { "label": "Product Page", "url": "https://www.blox.my/myrc" },
  { "label": "Transparency", "url": "https://www.blox.my/myrc/transparency" },
  { "label": "Whitepaper", "url": "https://cdn.blox.my/misc/MYRC-Whitepaper.pdf" },
  { "label": "Docs", "url": "https://docs.blox.my" },
  { "label": "X", "url": "https://x.com/blox_malaysia" },
  { "label": "App", "url": "https://app.blox.my" }
]
```

(7 links, well above the 3-link minimum.)

---

## 7. Optional Fields

| Field | Recommendation |
|---|---|
| `pythFeedId` | None — Pyth does not appear to publish an MYRC or MYR/USD feed for this asset (no Pyth feed surfaced in research; would need to be a *MYR/USD* FX feed, not an MYRC asset feed) |
| `tradedContracts` | None — no separate market wrapper |
| `dependencies` | None — fiat-backed, no dependency on other tracked stablecoins |
| `canBeBlacklisted` | `true` — verified `restrictAddress` on EVM and `freezeAuthority` set on Solana |
| `infrastructures` | None — not part of liquity-v1, liquity-v2, or m0 |
| `notices` | Recommend at least two: one on regulatory status, one on float size. See draft below. |

### Suggested `notices`

```json
"notices": [
  {
    "level": "info",
    "title": "Issuer not licensed",
    "body": "Blox Blockchain Sdn Bhd does not hold a Bank Negara Malaysia or Securities Commission Malaysia license. SC Malaysia disclaimed jurisdiction; BNM has not yet established a payment-stablecoin framework as of 2026."
  },
  {
    "level": "info",
    "title": "Small float, single-jurisdiction",
    "body": "Total circulating supply is approximately MYR 5.3M (~USD 1.3M) and reserves are concentrated in a single Malaysian bank (Maybank) under a single Malaysian trustee (Universal Trustee Malaysia Bhd)."
  }
]
```

> Note: confirm `level` enum values against `CoinNoticeSchema` in `shared/types/stablecoin-meta-schemas.ts` before saving.

---

## 8. Live Reserves Adapter Assessment

**Recommendation:** Do **not** add a `liveReservesConfig`. Curated `reserves[]` only.

Reason: the Blox transparency page (`https://www.blox.my/myrc/transparency`) does not expose a machine-readable JSON API or on-chain PoR feed. The published artifact is a monthly PDF attestation. None of the existing adapter keys in `LIVE_RESERVE_ADAPTER_KEYS` (`shared/types/live-reserves.ts`) are designed for monthly PDF parsing, and a PDF-scraping adapter for a single small coin would be disproportionate effort.

If Blox publishes an attestation API in the future, the closest existing analog would be a *Chainlink PoR* feed (adapter `chainlink-por`) if Blox adopts one — recommend re-evaluating then.

---

## 9. Eligibility Note

Circulating supply is approximately **5,310,798 MYRC** (~**$1.33M USD**), which is **below** the $5M soft threshold in `adding-a-stablecoin.md` Phase 1.

Strategic justification for adding anyway: **MYRC is the first MYR-pegged stablecoin Pharos would track**, and Pharos already tracks 215+ stablecoins across many fiat pegs (USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, CNH, PHP, MXN, UAH, ARS). MYR coverage extends Pharos's geographic surface to Southeast Asia beyond IDR/SGD/PHP and matches a documented user request from the 2026-04-21 support gap sweep.

**Recommendation:** Add as `status: "active"` (not pre-launch — coin is live and trading on multiple chains). Treat the small float as a notice, not a tracking blocker.

---

## 10. Editorial Summary Draft (`data/ai-summaries.json`)

```json
"myrc-blox": {
  "title": "First Malaysian Ringgit stablecoin",
  "text": "MYRC is a Malaysian Ringgit-pegged stablecoin issued by Blox Blockchain Sdn Bhd, deployed natively on Ethereum, Arbitrum, Base, and Solana. Each token is collateralised 1:1 by MYR cash deposits held at Maybank under the trustee custody of Universal Trustee (Malaysia) Bhd. Mint and redemption flow through Malaysian banking rails (FPX) and require eKYC via MyKad, restricting access to Malaysian residents with linked local bank accounts. Blox publishes monthly third-party attestations on its transparency page, but the issuer holds no license from Bank Negara Malaysia or the Securities Commission Malaysia — SC Malaysia disclaimed jurisdiction in 2022 and BNM has not yet finalised a stablecoin framework. Circulating supply is small (~MYR 5.3M) and reserves are concentrated in a single bank and trustee in a single jurisdiction.",
  "updatedAt": "2026-04-29"
}
```

---

## 11. Logo Source

- CoinGecko hosts a clean PNG: `https://www.coingecko.com/en/coins/blox-myrc` (right-click the asset logo on that page; CoinGecko serves a high-resolution PNG via its `coin-images.coingecko.com` CDN).
- The Blox website uses an SVG logo at `https://www.blox.my/` — inspect the page header for the SVG asset path.

Recommend downloading the highest-resolution CoinGecko PNG, saving as `public/logos/myrc-blox.png`, and adding `"myrc-blox": "/logos/myrc-blox.png"` to `data/logos.json`.

---

## Appendix: Source Provenance

| Claim | Source |
|---|---|
| CoinGecko ID, market cap, supply, contract addresses | https://www.coingecko.com/en/coins/blox-myrc |
| Ethereum contract metadata | https://etherscan.io/token/0xbed7D999f1D71Ac70c263F64c7c7E009d691be2e |
| Arbitrum contract metadata | https://arbiscan.io/token/0x3eD03E95DD894235090B3d4A49E0C3239EDcE59e |
| Base contract metadata | https://basescan.org/token/0x3eD03E95DD894235090B3d4A49E0C3239EDcE59e |
| Solana mint metadata (decimals 6, freeze+mint authority) | Solana mainnet `getAccountInfo` JSON-RPC |
| Issuer legal entity, regulatory status, banking transition | https://theedgemalaysia.com/node/787125 (The Edge Malaysia, "Inside Malaysia's stablecoin beta phase") |
| Custodian/trustee structure (Maybank + UTMB) | https://theedgemalaysia.com/node/787125 |
| 1:1 mint/redeem mechanism, FPX, MyKad eKYC | https://docs.blox.my/, https://www.blox.my/myrc |
| Fee structure (currently waived) | https://www.blox.my/policies/transaction-fee-structure |
| DefiLlama absence | Queried `https://stablecoins.llama.fi/stablecoins`, no match for symbol/name |
| EVM blacklist surface (`restrictAddress`, `POLICE_ROLE`) | Etherscan/Arbiscan/Basescan verified source code |
| SC Malaysia digital asset regime context | https://www.sc.com.my/digital-assets, https://www.sc.com.my/regulation/guidelines/digital-assets |

---

## Open Items For Implementer

1. **Extend `PEG_CURRENCY_VALUES`** in `shared/types/core.ts` to include `"MYR"` before adding the registry entry. This may also require touching FX-display surfaces.
2. **Manually verify the audit firm name** by downloading the latest monthly attestation PDF from `https://www.blox.my/myrc/transparency`. The transparency page is dynamically rendered and WebFetch could not surface PDF links during research.
3. **Inspect `CoinNoticeSchema`** before authoring `notices` to confirm the supported `level` enum values.
4. **Confirm canonical-order placement** — at ~$1.3M cap, MYRC sits well below the median tracked-coin cap; place near the tail of `canonical-order.json` but ahead of any pre-launch entries.
5. **No DefiLlama path** — set `detailProvider: "coingecko"` so the runtime cache admits the asset via the CoinGecko fallback.
