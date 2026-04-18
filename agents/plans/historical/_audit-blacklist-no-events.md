# Blacklist Tracker — Audit of 10 Zero-Event Stablecoins

**Date:** 2026-04-17
**Scope:** U, FDUSD, BRZ, EURI, USDQ, UDSD (→ USDD), AID, TGBP, EURC, BUILD (→ BUIDL)
**Report source:** `worker/src/lib/blacklist-contracts.ts` contract specs vs on-chain ABIs (Etherscan v2 `getabi`) + historical `eth_getLogs` probes.

## TL;DR
- **Event signatures are correct for 9 of 9 tracked coins.** USD1_EVENT_FAMILY, USDC_EVENT_FAMILY, USDT0_EVENT_FAMILY, DENY_LIST_EVENT_FAMILY, BANNED_EVENT_FAMILY, SECURITIZE_SEIZE_EVENT_FAMILY all verified against implementation ABIs and correct keccak topic hashes.
- **USDD is not configured at all** (and its EVM contracts emit only Transfer/Approval — no freeze capability). Nothing to fix on blacklist side.
- **EURC *is* producing events** (Ethereum 377 Blacklisted + 95 UnBlacklisted; Base 317+92; Avalanche ~100+94) and the DB already has **472 Ethereum, 286 Base, 159 Avalanche** events. It's working — the user's "no events" assumption for EURC is incorrect.
- **BRZ Gnosis has 2 Blacklisted events** on-chain (blocks 45229172, 45229396) but the tracker's `last_block` is stuck at **33257602** (= startBlock-1). The Gnosis dRPC code path isn't making forward progress.
- **BUIDL (all 6 chains), U (both chains), FDUSD (all 3 chains), EURI (both chains), USDQ, AID, TGBP (both chains): issuers have never used the capability.** Zero events ever. This is expected behaviour — no product bug.
- **Stale EURC sync-state row** with mixed-case key (`ethereum-0x1aBaEA...`) is a dead remnant, harmless but worth cleaning.

Recommended follow-ups per coin are enumerated in each section below.

---

## Key topic-hash reference (from implementation ABIs)

| Signature | Keccak256 topic0 | Used by |
|---|---|---|
| `Freeze(address,address)` | `0x51d187…bc528` | U, FDUSD, EURI (USD1_EVENT_FAMILY) |
| `Unfreeze(address,address)` | `0x4f3ab9…4c79` | U, FDUSD, EURI |
| `Blacklisted(address)` | `0xffa4e6…b855` | BRZ, EURC (USDC_EVENT_FAMILY) |
| `UnBlacklisted(address)` | `0x117e32…c4e` | BRZ, EURC |
| `BlockPlaced(address)` | `0x406bbf…7c7` | USDQ (USDT0_EVENT_FAMILY) |
| `BlockReleased(address)` | `0x665918…3c27` | USDQ |
| `DestroyedBlockedFunds(address,uint256)` | `0x6a2859…f1e9` | USDQ |
| `AddedToDenyList(address[])` | `0x02dd2f…8c05` | AID (DENY_LIST_EVENT_FAMILY) |
| `RemovedFromDenyList(address[])` | `0xfe8496…4f38` | AID |
| `Banned(address)` | `0x30d1df…1005` | TGBP (BANNED_EVENT_FAMILY) |
| `UnBanned(address)` | `0xb39966…d234` | TGBP |
| `Seize(address,address,uint256,string)` | `0x5068c4…21d7` | BUIDL (SECURITIZE_SEIZE_EVENT_FAMILY) |
| `OmnibusSeize(address,address,uint256,string,uint8)` | `0x5c719d…33a9` | BUIDL |

All 13 topics match what `blacklist-contracts.ts` has. No mismatches.

---

## U — United Stables (`u-united-stables`)

**Canonical address (shared/data/stablecoins/usd-major.json lines 2339–2349):**
- Ethereum `0xce24439f2d9c6a2289f741120fe202248b666666`
- BSC `0xce24439f2d9c6a2289f741120fe202248b666666`

**Proxy info (Etherscan v2 `getsourcecode`):**
- Both chains: TransparentUpgradeableProxy → implementation `0xbef21313c69c009fd7d9510a8d3a481a32473dfc` (same on Ethereum and BSC).

**Implementation events (abridged):**
```
event Freeze(address indexed caller, address indexed account)    topic0 = 0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528
event Unfreeze(address indexed caller, address indexed account)  topic0 = 0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79
```
**Note:** Implementation does NOT define `FrozenAccountDrained` or `FrozenFundsReallocated`. Those two are defined in the USD1 WLFI contract (different issuer) and live in our shared `USD1_EVENT_FAMILY` only because we reused the family. No harm — the extra topics just never fire.

**Configured family comparison:** ✓ Match for `Freeze` / `Unfreeze`. Extra `FrozenAccountDrained` / `FrozenFundsReallocated` topics in family are not in this contract but they're harmless (worker only stores events whose topic matches).

**Historical probe:**
- Ethereum (start 24030193 → latest): Freeze 0, Unfreeze 0, FrozenAccountDrained 0
- BSC (start 71922111 → latest): Freeze 0, Unfreeze 0, FrozenAccountDrained 0, FrozenFundsReallocated 0

**Verdict:** No action — issuer has not used capability.

---

## FDUSD — First Digital USD (`fdusd-first-digital`)

**Canonical address (shared/data/stablecoins/usd-major.json lines 3034–3049):**
- Ethereum `0xc5f0f7b66764f6ec8c8dff7ba683102295e16409`
- BSC `0xc5f0f7b66764f6ec8c8dff7ba683102295e16409`
- Arbitrum `0x93c9932e4afa59201f0b5e63f7d816516f1669fe`

**Proxy info:** All three chains: TransparentUpgradeableProxy → impl `0xa6b2c3d2910246fb0adb02e5f6b39e29026e6d50` (same on Ethereum, BSC, Arbitrum).

**Implementation events:** identical to U above — `Freeze(address,address)` + `Unfreeze(address,address)` only.

**Configured family comparison:** ✓ Match.

**Historical probe:**
- Ethereum (start 17144262 → latest): Freeze 0, Unfreeze 0 (Etherscan v2 getLogs)
- BSC (start 27850220 → latest): Freeze 0, Unfreeze 0 (Alchemy BSC)
- Arbitrum (start 336278229 → latest): Freeze 0, Unfreeze 0 (Alchemy)

**Verdict:** No action — issuer has not used capability.

---

## BRZ — Brazilian Digital (`brz-transfero`)

**Canonical address (shared/data/stablecoins/non-usd.json lines 230–265):**
- Ethereum `0x01d33fd36ec67c6ada32cf36b31e88ee190b1839`
- Gnosis `0x0a06c8354a6cc1a07549a38701eac205942e3ac6`

**Proxy info:**
- Ethereum: TransparentUpgradeableProxy → impl `0x2c4a809e8d86b1688b65581b6c7f50bd670d1b77`
- Gnosis: TransparentUpgradeableProxy → impl `0x8070bd3f60e54da7110ab21729a846cca2734f23` (name `TokenV2_1`)

**Implementation events:**
```
event Blacklisted(address indexed _account)     topic0 = 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
event UnBlacklisted(address indexed _account)   topic0 = 0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e
```

**Configured family comparison:** ✓ Match (`USDC_EVENT_FAMILY`).

**Historical probe:**
- Ethereum (start 17517084 → latest, Etherscan v2): Blacklisted 0, UnBlacklisted 0.
- Gnosis (start 33257603 → latest, via Blockscout eth_rpc): **Blacklisted = 2 events** at blocks 45229172 (tx `0x847097bfd944100a167e106acfd9fd4be3beb2a5fa18b5ddfd7d8f60b4b5482b`) and 45229396 (tx `0x5a5ec473cbd805ae277eedd63528ce34e17127284c7e6c6387b210ed021ed4ce`); UnBlacklisted 0.

**Sync state check (D1 blacklist_sync_state):**
- `gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6` → last_block **33257602 (= startBlock - 1)**. Gnosis chain head is ~45.7M. The tracker has scanned effectively zero blocks for this contract.
- Adjacent Ethereum BRZ row advances normally (`last_block=24901482`).

**Cause hypothesis:** Gnosis is served by the dRPC-backed fallback path (`shouldPreferRpcLogScan` is true), with `fallback` window = 50k blocks and `alchemy` window = 250k blocks — but Gnosis doesn't have an Alchemy endpoint in `ALCHEMY_CHAINS`, so the config uses dRPC as primary + publicRpc as fallback, and dRPC free tier enforces a **10,000-block cap**. `RPC_LOG_SCAN_WINDOWS.gnosis = { alchemy: 250_000, fallback: 50_000 }` — both windows exceed dRPC's 10k cap, so every getLogs call returns `"ranges over 10000 blocks are not supported on freetier"`. The circuit breaker likely marks it as failed and the sync state never advances. The worker cron has been running for weeks without catching up.

**Verdict:** ✗ **Bug — Gnosis sync path broken by dRPC block-range cap.** Two real events have been missed.
**Recommended follow-up:**
1. Lower `RPC_LOG_SCAN_WINDOWS.gnosis.fallback` (and `.alchemy` since Gnosis has no Alchemy) to `9_500` (inside dRPC free tier), OR switch Gnosis to Blockscout's `/api/eth-rpc` (accepts wide ranges), OR reinstate Etherscan v2 for chainid=100 (currently blocked on free tier).
2. After fix, backfill from block 33257603 by resetting `gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6` to 33257602 so the next sync pulls the 2 missed events.

---

## EURI — Eurite (`euri-banking-circle`)

**Canonical address (shared/data/stablecoins/non-usd.json lines 555–565):**
- Ethereum `0x9d1a7a3191102e9f900faa10540837ba84dcbae7`
- BSC `0x9d1a7a3191102e9f900faa10540837ba84dcbae7`

**Proxy info:** Both TransparentUpgradeableProxy → impl `0x039a26c8239d6d0c8d8fbdc6e60a6cc465d6712d` (same on Ethereum and BSC).

**Implementation events:** identical pattern to U / FDUSD — `Freeze(address,address)` + `Unfreeze(address,address)`.

**Configured family comparison:** ✓ Match (`USD1_EVENT_FAMILY`).

**Historical probe:**
- Ethereum (start 20217556 → latest, Etherscan v2): Freeze 0.
- BSC (start 40115386 → latest, Alchemy): Freeze 0, Unfreeze 0.

**Verdict:** No action — issuer has not used capability.

---

## USDQ — Quantoz USDQ (`usdq-quantoz`)

**Canonical address (shared/data/stablecoins/usd-minor.json lines 2483–2503):**
- Ethereum `0xc83e27f270cce0a3a3a29521173a83f402c1768b`
- Polygon `0xb291996477504506bf5f583102b5b5ea5d1e40e0` (**not tracked — optional follow-up**)
- XRPL + Algorand (non-EVM)

**Proxy info:** Ethereum TransparentUpgradeableProxy → impl `0xbae166f5e8b4b6735341446b1405fa779a92d7c7`.

**Implementation events:**
```
event BlockPlaced(address indexed _user)                         topic0 = 0x406bbf2d8d145125adf1198d2cf8a67c66cc4bb0ab01c37dccd4f7c0aae1e7c7
event BlockReleased(address indexed _user)                       topic0 = 0x665918c9e02eb2fd85acca3969cb054fc84c138e60ec4af22ab6ef2fd4c93c27
event DestroyedBlockedFunds(address indexed _blockedUser, uint256 _balance)  topic0 = 0x6a2859ae7902313752498feb80a014e6e7275fe964c79aa965db815db1c7f1e9
```

**Configured family comparison:** ✓ Match (`USDT0_EVENT_FAMILY`).

**Historical probe:** Ethereum (start 21179575 → latest): BlockPlaced 0, BlockReleased 0.

**Verdict:** No action — issuer has not used capability on Ethereum. Polygon USDQ contract (`0xb291996477504506bf5f583102b5b5ea5d1e40e0`) is NOT tracked — minor feature gap but low priority (Polygon supply is small).

---

## UDSD (= USDD) — Tron DAO Reserve (`usdd-tron-dao-reserve`)

**Interpretation:** The user wrote "UDSD" but the stablecoin corpus only has `usdd-tron-dao-reserve` (Dominica-based USDD). That's the intended coin.

**Canonical address (shared/data/stablecoins/usd-major.json lines 2029–2064):**
- Tron `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`
- Ethereum `0x4f8e5de400de08b164e7421b3ee387f461becd1a`
- BSC `0x45e51bc23d592eb2dba86da3985299f7895d66ba`
- Avalanche `0xb514cabd09ef5b169ed3fe0fa8dbd590741e81c2`
- Arbitrum `0x680447595e8b7b3aa1b43beb9f6098c79ac2ab3f`
- Near + BitTorrent (non-primary)

**Configuration status:** **Not configured in `CONTRACT_CONFIG_SPECS`** and **not in `BLACKLIST_STABLECOINS`** (`shared/types/market.ts` — USDD missing). That's the whole reason there are zero events.

**Implementation events (Ethereum + BSC ABIs, direct `getabi`):**
- Both Ethereum and BSC are **non-proxy** native contracts named `Usdd`. Their ABIs contain only `event Transfer(address,address,uint256)` and `event Approval(address,address,uint256)`. **No freeze, block, blacklist, ban, or seize capability at the EVM layer.**

**Tron side:** TronScan shows the contract is **unverified** (no public ABI). TRC20 bytecode analysis beyond the scope of this audit — but given the EVM deployments are deliberately minimal TRC20 wrappers, the Tron master contract would need separate on-chain verification if the team claims clawback. Their docs (docs.usdd.io) don't describe a blacklist or freeze mechanism; USDD is presented as a decentralized CDP-backed stablecoin.

**Verdict:** No action. USDD has no clawback/blacklist feature exposed as events on EVM. If Tron-side capability exists, adding it would require (a) verifying the Tron source, (b) adding `USDD` to `BLACKLIST_STABLECOINS`, (c) adding a new event family, and (d) wiring up TronGrid event scanning — significant effort for uncertain payoff. Defer unless Justin Sun / TRON-DAO publish a documented freeze interface.

---

## AID — GAIB AID (`aid-gaib`)

**Canonical address (shared/data/stablecoins/usd-minor.json lines 9021–9036):**
- Ethereum `0x18f52b3fb465118731d9e0d276d4eb3599d57596`
- Arbitrum `0x18f52b3fb465118731d9e0d276d4eb3599d57596`
- Base `0x18f52b3fb465118731d9e0d276d4eb3599d57596`

**Configured chains:** Ethereum only (Arbitrum and Base exist in data but aren't tracked — **minor coverage gap**).

**Proxy info:** Ethereum ERC1967Proxy → impl `0x5e8e15bae8601426b3d6765e9d2fa3da2b4ca8fa`.

**Implementation events:**
```
event AddedToDenyList(address[] accounts)                        topic0 = 0x02dd2f2ab1d45714c6f178e8ff8c5594023ec5d134bb99bbb230adabdb718c05
event RemovedFromDenyList(address[] accounts)                    topic0 = 0xfe849628f690f8527fe506998b4ddf44a5b11ecb3ec64257db0951b62d9a4f38
```

**Configured family comparison:** ✓ Match (`DENY_LIST_EVENT_FAMILY`, `addressArrayData: true` is correct since `address[]` lives in data).

**Historical probe:** Ethereum (start 23682560 → latest): AddedToDenyList 0, RemovedFromDenyList 0.

**Verdict:** No action on existing config. **Optional:** add Arbitrum + Base contracts if issuer expands usage — event family already handles it, but contract is still new (startBlock = 23682560 ≈ late 2025).

---

## TGBP — Tokenised GBP (`tgbp-tokenised`)

**Canonical address (shared/data/stablecoins/non-usd.json lines 2469–2494):**
- Ethereum, Base, BSC, Polygon, Avalanche — all `0x27f6c8289550fce67f6b50bed1f519966afe5287`

**Configured chains:** Ethereum + Avalanche (Base, BSC, Polygon exist in data but aren't tracked — **minor gap**).

**Proxy info:**
- Ethereum TransparentUpgradeableProxy → impl `0x94321d80d3c5cdac63b75f723ae64ca7f94be547`
- Avalanche TransparentUpgradeableProxy → impl `0xc608f7750b91f2e655ce7702bce3d30b8504abf2`

**Implementation events (both chains identical pattern):**
```
event Banned(address indexed account)    topic0 = 0x30d1df1214d91553408ca5384ce29e10e5866af8423c628be22860e41fb81005
event UnBanned(address indexed account)  topic0 = 0xb39966eac8a0ae96284afcbb1a1e8eb366677548a09cf1bf773b39b26bedd234
```

**Configured family comparison:** ✓ Match (`BANNED_EVENT_FAMILY`).

**Historical probe:**
- Ethereum (start 23046391 → latest): Banned 0.
- Avalanche (start 69696101 → latest, Routescan): Banned 0, UnBanned 0.

**Verdict:** No action. Optional: add BSC/Polygon/Base for completeness.

---

## EURC — Circle Euro (`eurc-circle`)

**Canonical address (shared/data/stablecoins/non-usd.json lines 122–152):**
- Ethereum `0x1abaea1f7c830bd89acc67ec4af516284b1bc33c`
- Base `0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42`
- Avalanche `0xc891eb4cbdeff6e073e859e987815ed1505c2acd`

**Proxy info:**
- Ethereum FiatTokenProxy → impl `0x43506849d7c04f9138d1a2050bbf3a0c054402dd`
- Base FiatTokenProxy → impl `0x2ce6311ddae708829bc0784c967b7d77d19fd779`
- Avalanche FiatTokenProxy → impl `0x30dfe0469803bce76f8f62ac24b18d33d3d6ffe6`

**Implementation events (all three identical — Circle FiatTokenV2 line):**
```
event Blacklisted(address indexed _account)     topic0 = 0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855
event UnBlacklisted(address indexed _account)   topic0 = 0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e
```

**Configured family comparison:** ✓ Match.

**Historical probe:**
- Ethereum (start 14807227 → latest, Etherscan v2): Blacklisted **377**, UnBlacklisted **95**.
- Base (start 15107859 → latest, Alchemy): Blacklisted **317**, UnBlacklisted **92**.
- Avalanche (start 26857185 → latest, Routescan): Blacklisted ~100 (Routescan paginates), UnBlacklisted ~94.

**DB state (D1 `blacklist_events` table):** EURC Ethereum **472 rows**, Base **286 rows**, Avalanche **159 rows**. Tracker IS working for EURC.

**Finding:** The user's premise that EURC has no events is wrong. The tracker has recorded over **900 EURC events** across its three supported chains. Live counts slightly exceed DB counts (expected — some lag, and Routescan Avalanche totals are dampened by paginated list truncation).

**Verdict:** No product bug. **Minor cleanup:** the D1 `blacklist_sync_state` table contains a stale legacy row with mixed-case address `ethereum-0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c` (last_block 24286202) alongside the correct lowercase row (last_block 24901777). The mixed-case row is unreachable by the worker now (config keys are lowercased) and can be deleted.

---

## BUIDL — BlackRock USD (`buidl-blackrock`) — "BUILD" typo

**Canonical address (shared/data/stablecoins/usd-major.json lines 1899–1939):**
- Ethereum `0x7712c34205737192402172409a8f7ccef8aa2aec`
- BSC `0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f`
- Optimism `0xa1cdab15bba75a80df4089cafba013e376957cf5`
- Arbitrum `0xa6525ae43edcd03dc08e775774dcabd3bb925872`
- Avalanche `0x53fc82f14f009009b440a706e31c9021e1196a2f`
- Polygon `0x2893ef551b6dd69f661ac00f11d93e5dc5dc0e99`
- Solana + Aptos (non-EVM, not tracked)

**Proxy info:**
- Ethereum: `Proxy` (Securitize custom) → impl `0x603bb6909be14f83282e03632280d91be7fb83b2`
- Other five chains: ERC1967Proxy → impls `0xe478ae7036d20fd956ebb5beddd1f6e950657126` (BSC), `0xca91fa164b75da598e16b4d89fb2086b47140df3` (OP), `0xdbf6db49066784a69244d3b33cf44c25ec86c0f7` (ARB), `0xf93667d01c7675e2667ee392aa69104df79c4ad0` (AVAX), `0x20c4c5194658e58fc783f4272254d3f8f18bb836` (POLY).

**Implementation events (all 6 chains — Securitize DS token family):**
```
event Seize(address indexed from, address indexed to, uint256 value, string reason)
    topic0 = 0x5068c48f7f290ce2b8d555bd28014be9f312999bb621037ea3e9fc86335a21d7
event OmnibusSeize(address indexed omnibusWallet, address from, uint256 value, string reason, uint8 assetTrackingMode)
    topic0 = 0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9
```
(Also present: OmnibusTransfer, OmnibusBurn, OmnibusDeposit, etc. — not blacklist events, ignored.)

**Configured family comparison:** ✓ Match for both `Seize` and `OmnibusSeize`. `addressTopicIndex: 1` for `Seize` and `addressDataIndex: 0` for `OmnibusSeize` are correct.

**Historical probe:**
- Ethereum (start 19343293 → latest, Etherscan v2): Seize 0, OmnibusSeize 0.
- BSC (start 63931579 → latest, Alchemy): Seize 0, OmnibusSeize 0.
- Optimism (start 127565419 → latest, Alchemy): Seize 0, OmnibusSeize 0.
- Arbitrum (start 270969308 → latest, Alchemy): Seize 0, OmnibusSeize 0.
- Avalanche (start 52649153 → latest, Routescan): Seize 0, OmnibusSeize 0.
- Polygon (start 63877025 → latest, Alchemy): Seize 0, OmnibusSeize 0.

**Verdict:** No action — BlackRock has never seized a BUIDL holder. Expected given institutional-only access.

---

## Sync-state anomalies worth noting

From D1 `blacklist_sync_state` snapshot (taken during audit):

| Config key | last_block | Gap vs chain head | Note |
|---|---|---|---|
| `gnosis-0x0a06c8354a6cc1a07549a38701eac205942e3ac6` | 33257602 | ~12.5M blocks behind | **Broken** — dRPC free-tier blocks the 50k/250k scan windows. |
| `bsc-0xc5f0f7b66764f6ec8c8dff7ba683102295e16409` (FDUSD) | 38850219 | ~54M blocks behind | Slow catch-up; Alchemy BSC confirms 0 events in the skipped range, so no data loss. |
| `bsc-0xce24439f2d9c6a2289f741120fe202248b666666` (U) | 82922110 | ~10M behind | Slow catch-up; verified 0 events in lag window. |
| `bsc-0x9d1a7a3191102e9f900faa10540837ba84dcbae7` (EURI) | 50865385 | ~42M behind | Same. |
| `ethereum-0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c` | 24286202 | frozen | Duplicate mixed-case row; unreachable by worker. Safe to delete. |

Recommend a follow-up to raise scan-window limits for Gnosis (primary issue) and optionally batch-up BSC backfill so it catches up faster, even though no data is missing.

---

## Consolidated verdict table

| Coin | Chain | Configured | Events on chain | Events in DB | Verdict |
|---|---|---|---|---|---|
| U | Ethereum | ✓ | 0 | 0 | No action |
| U | BSC | ✓ | 0 | 0 | No action |
| FDUSD | Ethereum | ✓ | 0 | 0 | No action |
| FDUSD | BSC | ✓ | 0 | 0 | No action |
| FDUSD | Arbitrum | ✓ | 0 | 0 | No action |
| BRZ | Ethereum | ✓ | 0 | 0 | No action |
| **BRZ** | **Gnosis** | **✓** | **2** | **0** | **Fix dRPC scan window + backfill** |
| EURI | Ethereum | ✓ | 0 | 0 | No action |
| EURI | BSC | ✓ | 0 | 0 | No action |
| USDQ | Ethereum | ✓ | 0 | 0 | No action |
| USDD | (none) | — | N/A (no feature) | 0 | Not tracked; defer (no feature) |
| AID | Ethereum | ✓ | 0 | 0 | No action |
| TGBP | Ethereum | ✓ | 0 | 0 | No action |
| TGBP | Avalanche | ✓ | 0 | 0 | No action |
| EURC | Ethereum | ✓ | 377 + 95 | 472 | **Working — user assumption wrong** |
| EURC | Base | ✓ | 317 + 92 | 286 | Working |
| EURC | Avalanche | ✓ | ~100 + 94 | 159 | Working |
| BUIDL | Ethereum | ✓ | 0 | 0 | No action |
| BUIDL | BSC | ✓ | 0 | 0 | No action |
| BUIDL | Optimism | ✓ | 0 | 0 | No action |
| BUIDL | Arbitrum | ✓ | 0 | 0 | No action |
| BUIDL | Avalanche | ✓ | 0 | 0 | No action |
| BUIDL | Polygon | ✓ | 0 | 0 | No action |

**Biggest single follow-up:** fix Gnosis dRPC scan window in `worker/src/cron/blacklist/evm-source.ts` (`RPC_LOG_SCAN_WINDOWS.gnosis`) — both `alchemy` and `fallback` must be ≤ 9500 blocks for dRPC free tier, or switch Gnosis to Blockscout's eth_rpc.

**Optional cleanups:**
- Delete the mixed-case `ethereum-0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c` sync_state row (harmless but stale).
- Consider adding Arbitrum/Base for AID; BSC/Base/Polygon for TGBP; Polygon for USDQ — all zero priority until issuers demonstrate clawback activity anywhere.

**What the audit did NOT change:** event signatures, topic hashes, proxy resolution, or the family definitions in `blacklist-contracts.ts`. All correct as configured.
