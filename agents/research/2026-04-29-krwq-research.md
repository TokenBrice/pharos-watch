# KRWQ Research Packet

**Date:** 2026-04-29
**Asset:** KRWQ – the first Korean Won-pegged stablecoin (Frax + IQ)
**Status recommendation:** `active` (with caveats — see eligibility section)
**Primary blocker:** `KRW` is **NOT** in `PEG_CURRENCY_VALUES` in `shared/types/core.ts`. Pharos cannot currently model a Korean Won peg. This must be addressed before KRWQ can be onboarded with proper depeg / Safety Score handling.

---

## 1. Identity

| Field | Value | Source |
|---|---|---|
| Canonical Pharos ID | `krwq-iq` | Issuer narrative consistently identifies KRWQ as **"IQ's KRWQ"** with Frax as infrastructure partner. The press release and IQ blog (`blog.iqai.com`) treat IQ as the issuing/operating entity. `krwq-iq` is cleaner than `krwq-krwq` and matches the issuer attribution used by CoinMarketCap (`korean-won-iq`) and PR Newswire ("IQ's KRWQ"). |
| `name` | `KRWQ` | CoinGecko `name`, etherscan token name. Etherscan also surfaces the longer marketing name **"Korean Won IQ"** which is the CMC slug origin; the canonical short name across CG/CMC/issuer is `KRWQ`. |
| `symbol` | `KRWQ` | All sources. |
| `geckoId` | `krwt` | Verified via `https://api.coingecko.com/api/v3/coins/krwt` — `id: "krwt"`, `symbol: "krwq"`, `name: "KRWQ"`. The slug ID is a CoinGecko legacy quirk (likely an early "KRW Token" working name); resolves to KRWQ today. `https://api.coingecko.com/api/v3/coins/krwq` returns 404. |
| `cmcSlug` | `korean-won-iq` | `https://coinmarketcap.com/currencies/korean-won-iq/` resolves; CMC ranking ~#4618 at last sweep. |
| `llamaId` | **None** | DefiLlama `/stablecoins` list contains no entry with symbol "KRWQ" / name "Korean Won". KRWQ is not yet tracked by DefiLlama stablecoins. → Use `detailProvider: "coingecko"` + `geckoId` admission path. |
| `protocolSlug` | n/a | KRWQ is an issuer-led stablecoin, not a TVL-bearing protocol on DefiLlama. |
| Jurisdiction | South Korea / FSC + Bank of Korea (BOK) | Whitepaper §3 explicitly cites the **Act on the Protection of Virtual Asset Users** (effective July 19, 2024), FSC supervisory authority, and BOK monetary policy. **Issuer is NOT yet a licensed Korean VASP for stablecoin issuance.** Whitepaper Phase 4 (2026–2027) targets banking-integration. KRWQ is "designed for forthcoming stablecoin legislation currently under review in the Korean National Assembly" — i.e. compliance-by-design, not yet a regulated issuance. |

### Jurisdiction object (recommendation)

```json
"jurisdiction": {
  "country": "South Korea",
  "regulator": "Financial Services Commission (FSC)",
  "license": "Unlicensed — designed for forthcoming Korean stablecoin legislation; not currently marketed to Korean residents"
}
```

> Caveat: confirm the exact `JurisdictionSchema` shape in `shared/types/stablecoin-meta-schemas.ts` before authoring. The schema may not have a free-text `license` field — adapt to its enum if needed.

---

## 2. Contracts

KRWQ uses **LayerZero OFT v2** with Ethereum as the canonical/source mint chain. Per the project's GitHub (`KRWQ-cash/krwq` README): *"The OFT token is deployed on Base, while KRWQ, the Custodian, and the OFT Adapter are deployed on Ethereum."* Subsequent expansion via Stargate to Polygon / Fraxtal / Codex / Morph.

| Chain key (Pharos) | Address | Decimals | Verification |
|---|---|---|---|
| `ethereum` | `0xc00db6b41473d065027f5ed6fada20fde75f142e` | 18 | `https://etherscan.io/token/0xc00db6b41473d065027f5ed6fada20fde75f142e` — *"Token Name: KRWQ (Korean Won IQ), Symbol: KRWQ, Decimals: 18"*, EIP-1967 transparent upgradeable proxy, Solidity 0.8.24, source verified. CoinGecko `detail_platforms.ethereum.decimal_place: 18`. |
| `base` | `0x370923d39f139c64813f173a1bf0b4f9ba36a24f` | 18 | `https://basescan.org/token/0x370923D39f139C64813f173a1bf0b4f9Ba36a24f` — name "Korean Won Token", symbol KRWQ, decimals 18, transparent upgradeable proxy → impl `0x394B2763895d648abcd84c191c2a12ff9504de27`, Solidity 0.8.24, source verified. CoinGecko `detail_platforms.base.decimal_place: 18`. |
| `polygon` | `0x44c3950a6ed303c863a6568ea18c1a01e504ffd2` | **Unverified** (likely 18) | Listed on official `krwq.cash` site. Polygonscan view returned 403/incomplete via WebFetch; OKLink confirms the address exists as ERC-20 on Polygon but did not surface decimals. Recommend confirming via `cast call` / Polygonscan UI before adding. |
| `fraxtal` | `0xbe5b2eb217bb04a7ddd1a451e6a1567dc15e2fd6` | **Unverified** (likely 18) | Listed on official `krwq.cash` site. Fraxscan returned 403 via WebFetch. Recommend manual confirmation before adding. |
| `codex` (L2) | `0xe898e1cffa565aae8bacc364aa7d65a6a2d20f16` | n/a | **Skip — Codex chain is NOT in `shared/lib/chains.ts`.** Adding it would require a new chain entry. Defer. |
| `morph-l2` | `0xe898E1CffA565aAe8bAcC364AA7D65D6A2d20F16` | **Unverified** (likely 18) | Morph IS in `chains.ts` as `morph-l2`. Verify on `https://explorer.morphl2.io` before adding. |

### Recommended `contracts[]` (conservative — Ethereum + Base only)

Until Polygon/Fraxtal/Morph addresses are on-chain-verified for decimals, ship Ethereum + Base only and follow up to expand:

```json
"contracts": [
  { "chain": "ethereum", "address": "0xc00db6b41473d065027f5ed6fada20fde75f142e", "decimals": 18 },
  { "chain": "base",     "address": "0x370923d39f139c64813f173a1bf0b4f9ba36a24f", "decimals": 18 }
]
```

Both verified directly on Etherscan/Basescan with quoted text. Total supply across these two chains (~1.917B KRWQ at last sweep) matches CoinGecko's circulating supply, suggesting the other chains carry negligible balance for now.

### Note on bridging / `deploymentModel`

KRWQ is an OFT minted on Ethereum and bridged via Stargate / LayerZero OFT to Base, Polygon, Fraxtal, Codex, Morph. This is `native-multichain` (LayerZero OFT v2 unified-supply model), not `canonical-bridge` and not `third-party-bridge` — the OFT standard is the issuer's primary multichain mechanism, baked into the contract architecture per the whitepaper §4.2.

---

## 3. Peg + Collateral

```json
"flags": {
  "backing": "rwa-backed",
  "pegCurrency": "KRW",
  "governance": "centralized",
  "yieldBearing": false,
  "rwa": true,
  "navToken": false
}
```

> ⚠️ **Blocker:** `"KRW"` must be added to `PEG_CURRENCY_VALUES` in `shared/types/core.ts` first. This is the same blocker flagged for `cNGN`, `MYRC`, `KGST` in the 2026-04-21 stablecoin support gap sweep.

**`flags.governance: "centralized"`** — IQ-led, multi-sig admin, KYC-gated mint/redeem. Whitepaper §7: *"All critical system functions, including smart contract upgrades and reserve asset movements, require multi-signature authorization under a dual-control policy."*

**`flags.yieldBearing: false`** — per whitepaper §8 Legal Disclosures: *"It is not a deposit, investment product, or interest-bearing instrument."*

**`flags.rwa: true`** — Korean Treasury Bonds + USDC + frxUSD reserves.

**`flags.navToken: false`** — KRWQ is a 1:1 KRW-pegged stablecoin, not a fund-share / NAV token.

### `collateral` (prose)

> Mixed reserves transitioning from USDC-only to a target mix dominated by short-term Korean Treasury Bonds. Current composition includes Korean Treasury Bonds tokenized via Etherfuse's Stablebond framework and held in segregated, bankruptcy-remote custody at Shinhan Securities, alongside USDC and Frax frxUSD. Whitepaper Phase 2 (2025) targets transition to Korean Treasury Bonds, KRW money-market securities, and KRW deposits in regulated bankruptcy-remote custody.

### `pegMechanism` (prose)

> Centralized issuance against a 100% reserve. Mint and redemption are gated to KYC-verified institutional counterparties (exchanges, market makers, OTC desks). KRWQ is deployed on Ethereum as the canonical mint chain, with Base, Polygon, Fraxtal, Codex, and Morph as LayerZero OFT destinations sharing unified supply via Stargate. Token is not offered to South Korean residents pending domestic stablecoin legislation. Real-time on-chain reserve dashboard plus planned monthly third-party attestations.

### `proofOfReserves`

```json
"proofOfReserves": {
  "type": "real-time",
  "url": "https://krwq.cash/transparency",
  "provider": "KRWQ (self-reported on-chain dashboard)"
}
```

Whitepaper §7 commits to *"independent monthly attestations by a qualified, third-party auditing firm starting in 2025"* — but **no auditor is named, and no attestation report URL is published yet.** The transparency dashboard exists but the page noted "actual numerical reserve data and attestation documents are not included." Use `real-time` to reflect the on-chain dashboard, not `independent-audit`. Switch to `independent-audit` only once the first PDF report is public.

---

## 4. Reserves Composition

Per Feb 2026 announcements (KRWQ + Etherfuse + Shinhan Securities) and the official transparency page, current mix combines USDC, frxUSD, and tokenized Korean Treasury Bonds (KTBs). Exact percentages are not published — the breakdown below reflects qualitative best-review estimates and should be revisited when monthly attestations begin.

```json
"reserves": [
  { "name": "USDC (Circle)",                                                      "pct": 50, "risk": "low",      "coinId": "usdc-circle",      "depType": "collateral", "blacklistable": true },
  { "name": "frxUSD (Frax)",                                                      "pct": 25, "risk": "low",      "coinId": "frxusd-frax",      "depType": "collateral" },
  { "name": "Tokenized Korean Treasury Bonds (Etherfuse Stablebond / Shinhan custody)", "pct": 25, "risk": "low",      "depType": "collateral" }
]
```

Notes:
- Verify `usdc-circle` and `frxusd-frax` canonical IDs match the registry before saving (these are the standard Pharos IDs as of last sweep).
- Etherfuse Stablebond KTB is **not currently a tracked Pharos asset**, so no `coinId` is set.
- **Splits are estimates** — the issuer publishes a "Reserve Breakdown" table on the transparency page but no public percentages. The whitepaper Phase 2 explicitly describes ongoing transition from USDC-only toward KTB-dominant. Update once attestations land.
- Risk tier `low` for the KTB slice because (a) sovereign Korean credit, (b) bankruptcy-remote segregated custody at a top-tier Korean broker, but (c) the mechanism (Etherfuse → Shinhan) introduces tokenization-layer risk that prevents `very-low`.
- USDC and frxUSD slices are marked with `depType: "collateral"` to wire dependency-graph edges.

---

## 5. Resilience Overrides

| Field | Value | Rationale |
|---|---|---|
| `chainTier` | `ethereum` | Ethereum is the canonical mint / custody / OFT-adapter chain per the GitHub README. Base, Polygon, Fraxtal, Morph are bridged OFT destinations. The primary tier is the canonical issuance chain. |
| `deploymentModel` | `native-multichain` | LayerZero OFT v2 + Stargate maintain a single unified supply across chains. This is exactly the OFT pattern, not a wrapper bridge. |
| `collateralQuality` | `rwa` | Mixed RWA: tokenized Korean Treasury Bonds + USDC + frxUSD. The dominant target is sovereign KRW debt. |
| `custodyModel` | `institutional-regulated` | Shinhan Securities (Korean licensed broker-dealer) holds the KTB reserve in segregated, bankruptcy-remote custody. The USDC/frxUSD legs are on-chain in issuer-controlled multisig. The KTB leg justifies `institutional-regulated`. If the curator wants to weight the on-chain USDC/frxUSD legs more heavily, `institutional-top` could be argued. |
| `governanceQuality` | `single-entity` | IQ-led with multisig admin and dual-control governance, but no DAO, no regulated stablecoin license yet, no external audit committee. Not `regulated-entity` until the Korean stablecoin law passes and IQ secures a license. |

---

## 6. Links

```json
"links": [
  { "label": "Website",  "url": "https://krwq.cash" },
  { "label": "X",        "url": "https://x.com/krwqcash" },
  { "label": "Docs",     "url": "https://krwq.cash/whitepaper.pdf" },
  { "label": "Reserves", "url": "https://krwq.cash/transparency" },
  { "label": "GitHub",   "url": "https://github.com/KRWQ-cash" },
  { "label": "Telegram", "url": "https://t.me/KRWQcash" }
]
```

No public smart-contract audit. Etherscan explicitly shows no audit submitted for the Ethereum contract. Whitepaper §7 promises monthly attestations starting 2025 but no auditor named, no report URL.

---

## 7. Optional Fields

| Field | Recommendation |
|---|---|
| `pythFeedId` | None. Pyth has no public KRW/USD or KRWQ feed. |
| `tradedContracts` | None. The standard `contracts[]` are the canonical issuance contracts. |
| `dependencies` | Set automatically via `reserves[].coinId + depType`. Explicit `dependencies[]` not needed unless you want to weight `usdc-circle` and `frxusd-frax` differently. |
| `canBeBlacklisted` | `true`. The contract is an OpenZeppelin ERC20-style upgradeable proxy with admin multisig and explicit allow/deny-list capability per whitepaper §3.2 ("On-chain monitoring, allow/deny lists, and tiered onboarding for institutional partners"). |
| `infrastructures` | None. KRWQ is not on `liquity-v1`, `liquity-v2`, or `m0`. It uses Frax's `frxUSD` infrastructure as a reserve asset, but `frxUSD` is not currently a Pharos `infrastructures` value. Do not invent one. |
| `notices` | Recommend a `notices` entry: *"Not offered to South Korean residents pending domestic stablecoin legislation. Mint/redeem KYC-gated to institutional counterparties only. Independent attestations promised but not yet published — proof-of-reserves is currently a self-reported on-chain dashboard."* |
| `tags` | Optional editorial: `["korea", "non-usd", "rwa"]`. |

---

## 8. Live Reserves Adapter Assessment

**Recommendation: do NOT add a live reserves adapter on first ship. Use curated `reserves[]` only.**

Rationale:
- The transparency page (`krwq.cash/transparency`) renders a "Reserve Breakdown" table but the on-page numerical reserve amounts are dynamic placeholders (`0x...0x` per WebFetch) and there is no documented public JSON/CSV endpoint.
- Whitepaper Phase 2 promises monthly third-party attestations starting 2025 — but no auditor is named, no PDF is public.
- None of the existing `LIVE_RESERVE_ADAPTER_KEYS` cleanly fit:
  - The `frax-balance-sheet` adapter is for Frax's own protocol reserves, not for downstream Frax-infrastructure issuers like KRWQ.
  - `chainlink-por`, `circle-transparency`, `tether`, `chainlink-nav`, etc. don't apply.
  - A `curated-validated` adapter requires a tracked on-chain contract for the coin's reserves; KRWQ has no such on-chain reserve registry that I could find on the transparency page.
- Building a custom KRWQ adapter is premature until the issuer publishes a stable, parseable feed (likely after attestations begin).

**Path forward:** ship with curated `reserves[]` + `proofOfReserves: "real-time"` pointing at the dashboard. Add a live adapter when (a) attestations begin publishing PDFs at a stable URL, or (b) the issuer exposes a machine-readable reserves endpoint, or (c) a Shinhan/Etherfuse custody page becomes scrapable. Track this as a follow-up.

---

## 9. Eligibility Note

**Market cap: ~$1.32M USD (CoinGecko, last sweep)** — well below the $5M soft threshold from the add-a-coin process Phase 1.

**Recommendation: track as `active`, not `pre-launch`** — KRWQ launched October 30, 2025 and has been live for ~6 months. It is not pre-launch.

Strategic justification for accepting the sub-$5M cap:
1. **First Korean Won-pegged stablecoin in production.** This is a category-defining asset for a major economy (South Korea: world's 6th largest exporter, 16M+ crypto users, ~32% population penetration per the whitepaper).
2. **High-profile partners.** Frax (institutional stablecoin infra; established Pharos coverage), LayerZero, Aerodrome, EDXM. KRWQ is referenced in IQ's monthly reports and across institutional crypto press.
3. **Korean Treasury Bond integration via Etherfuse + Shinhan Securities** — a meaningful sovereign-debt-backed fiat stablecoin innovation worth modelling for Pharos's RWA coverage.
4. **Multichain via LayerZero OFT** with cross-chain unified supply — fits Pharos's coverage of multichain-native designs.
5. **Active perpetual futures market** announced via EDXM International (December 2025 / Q1 2026).

**However:** the bigger blocker is the missing `KRW` peg currency, not the cap. Without `KRW` in `PEG_CURRENCY_VALUES`, KRWQ cannot be onboarded with proper depeg/Safety Score handling, regardless of strategic value. Do the peg-currency expansion first; revisit eligibility immediately after.

---

## 10. Editorial Summary Draft (`data/ai-summaries.json`)

```json
"krwq-iq": {
  "title": "First Korean Won stablecoin, RWA-backed by Korean Treasury Bonds",
  "text": "KRWQ is the first stablecoin pegged 1:1 to the South Korean won, launched October 2025 by IQ in partnership with Frax. It uses LayerZero's Omnichain Fungible Token (OFT) standard with Ethereum as the canonical mint chain and Base, Polygon, Fraxtal, and Morph as bridged destinations sharing a unified supply via Stargate. Reserves are transitioning from initial USDC backing to a target mix dominated by short-term Korean Treasury Bonds, which are tokenized through Etherfuse's Stablebond framework and held in segregated, bankruptcy-remote custody at Shinhan Securities. Mint and redemption are KYC-gated to institutional counterparties — exchanges, market makers, and OTC desks — and KRWQ is explicitly not marketed to South Korean residents while the country's stablecoin legislation moves through the National Assembly. The issuer commits to independent monthly attestations starting 2025 but has not yet named an auditor or published a report; live reserves are currently a self-reported on-chain dashboard. KRWQ trades primarily on Aerodrome (Base) against USDC and on EDX International for spot and perpetual markets.",
  "updatedAt": "2026-04-29"
}
```

---

## 11. Logo Source

**Recommended local path:** `/public/logos/krwq-iq.png` (or `.svg` if available)

**Source candidates** (highest fidelity first):
1. **CoinGecko CDN** — `https://www.coingecko.com/en/coins/krwt` hosts the KRWQ logo at the standard `assets.coingecko.com/coins/images/...` path. Open the page and right-click the logo for the direct asset URL (typical: `https://assets.coingecko.com/coins/images/<id>/large/<filename>.png`).
2. **Issuer site** — `https://krwq.cash` likely has a clean SVG in its hero/header. Inspect the page for the asset URL.
3. **GitHub** — `https://github.com/KRWQ-cash/.github` may have a branding asset.

Use the standard `scripts/fetch-logos.ts` flow if available, or download manually and place at `/public/logos/krwq-iq.png`. Add to `data/logos.json` keyed by `"krwq-iq"`.

---

## Summary of Blockers

1. **`KRW` not in `PEG_CURRENCY_VALUES`** (`shared/types/core.ts`). Same blocker as MYRC/KGST/cNGN. Must add `KRW` (and its FX-handling implications) before KRWQ can be properly tracked.
2. **No `llamaId`** — KRWQ is not in DefiLlama's stablecoins list. Use `detailProvider: "coingecko"` admission path with `geckoId: "krwt"`.
3. **Below $5M soft cap** ($1.32M) — accept on strategic grounds (first KRW stablecoin, sovereign-RWA-backed, Frax/IQ partnership, OFT-multichain).
4. **No public smart-contract audit** at time of writing.
5. **No machine-readable reserves feed** — ship with curated `reserves[]` + `proofOfReserves: "real-time"`; add live adapter later.
6. **Polygon, Fraxtal, Morph contract decimals not on-chain-verified** via WebFetch (explorers returned 403). Conservative shipping path: Ethereum + Base only on first add; expand once decimals are confirmed.
7. **Codex chain not in `chains.ts`** — skip the Codex deployment unless Codex is added to `chains.ts` separately.

---

## Source Index

- Issuer site: `https://krwq.cash`
- Transparency page: `https://krwq.cash/transparency`
- Whitepaper: `https://krwq.cash/whitepaper.pdf` (14 pages, dated October 30, 2025)
- GitHub org: `https://github.com/KRWQ-cash` (3 repos: `krwq`, `curve-assets` fork, `.github`)
- CoinGecko: `https://www.coingecko.com/en/coins/krwt` (id `krwt`, symbol KRWQ)
- CoinMarketCap: `https://coinmarketcap.com/currencies/korean-won-iq/` (slug `korean-won-iq`)
- Etherscan (Ethereum contract): `https://etherscan.io/token/0xc00db6b41473d065027f5ed6fada20fde75f142e`
- Basescan (Base contract): `https://basescan.org/token/0x370923D39f139C64813f173a1bf0b4f9Ba36a24f`
- Launch press release: `https://www.prnewswire.com/news-releases/krwq-the-first-korean-won-stablecoin-on-base-302599239.html`
- KTB/Shinhan press release: `https://www.prnewswire.com/news-releases/krwq-acquires-korean-government-bonds-with-shinhan-securities-together-with-etherfuse-302696216.html`
- LayerZero blog: `https://layerzero.network/blog/krwq-first-multi-chain-korean-won-stablecoin`
- IQ blog: `https://blog.iqai.com/krwq-the-first-korean-won-stablecoin-on-base/`
- FraxNet integration: `https://www.morningstar.com/news/pr-newswire/20251210sf44192/krwq-the-most-traded-korean-won-stablecoin-joins-fraxnets-genius-compatible-network`
- Prior Pharos research: `agents/research/2026-04-21-stablecoin-support-gap-sweep.md` (KRWQ entry)
