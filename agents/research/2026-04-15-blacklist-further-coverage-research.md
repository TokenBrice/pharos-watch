# Blacklist Tracker Further Coverage Research

Date: 2026-04-15

Baseline: commit `537342e4` (`feat(blacklist): add first-wave CeFi freeze coverage`).

Implementation update: the direct EVM wave, EURC mirror-zero suppression, and BUIDL seize-only subset were implemented after this research pass. The Solana/XRPL/Stellar and external-list/role-state waves remain implementation blockers until their provider and subject-identity models are selected.

## Scope

Research only. No implementation was performed.

This pass looks beyond the first-wave additions and prepares the next meaningful coverage opportunities for Pharos blacklist/freeze/destroy tracking. It covers:

- additional EVM token-event coverage,
- chain expansion for already-supported issuers,
- compliance-list / permissioned-token surfaces,
- and non-EVM adapters where supply is large enough to justify new infrastructure.

## Baseline After First Wave

Current live-supported symbols:

- `USDC`
- `USDT`
- `PAXG`
- `XAUT`
- `PYUSD`
- `USD1`
- `USDG`
- `RLUSD`
- `U`
- `USDTB`
- `A7A5`

Current scanner capabilities:

- EVM logs by token contract and topic0.
- TronGrid contract events.
- affected EVM address in:
  - `topics[1]` by default,
  - configurable `topics[2]`,
  - first static ABI word in `data`,
  - dynamic `address[]` in `data`.
- emitted non-indexed amount for Tether-style destroy events.
- price-cache USD conversion for PAXG, XAUT, A7A5.
- persistent freeze ledger via `blacklist_current_balances`.

Current scanner limitations that matter for further expansion:

- no event-source contract separate from token contract,
- no topic1/topic2 filtering for role-based AccessControl events,
- no indexed `uint256` amount extraction,
- no transaction-input classification,
- no Solana / Stellar / XRPL / Aptos / Sui / TON adapters,
- no per-token-account identity model for chains where the frozen unit is not the wallet address.

## Research Inputs

Local:

- `shared/data/stablecoins/*.json`
- `worker/src/lib/blacklist-contracts.ts`
- `worker/src/cron/blacklist/*`
- `docs/blacklist-tracker.md`
- `agents/research/2026-04-15-cefi-blacklist-expansion-research.md`

Current market/supply:

- DefiLlama stablecoins API: `https://stablecoins.llama.fi/stablecoins?includePrices=true`
- CoinGecko simple price API for fallback market caps.

Contract/event discovery:

- Sourcify metadata API for EVM ABIs.
- Public RPC EIP-1967 implementation-slot checks where supported by repo public RPCs.
- Solana JSON-RPC `getAccountInfo` for mint freeze authority / Token-2022 extensions.

External docs used:

- Solana Token docs, including Freeze Account and Token-2022 extensions:
  - `https://solana.com/docs/tokens/basics/freeze-account`
  - `https://solana.com/docs/tokens`
  - `https://solana.com/docs/developers/guides/token-extensions/permanent-delegate/`
- XRP Ledger token freeze docs:
  - `https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes/`
  - `https://xrpl.org/docs/tutorials/how-tos/use-tokens/freeze-a-trust-line`
- Stellar asset authorization / clawback docs:
  - `https://developers.stellar.org/docs/tokens/control-asset-access`
  - `https://developers.stellar.org/docs/build/guides/transactions/clawbacks`

## Meaningful Opportunity Criteria

I treated an opportunity as meaningful when at least one condition is true:

- material supply gap, roughly USD 50M+ or strategically important issuer,
- large chain-specific supply gap for an already-supported asset,
- low implementation risk because the event family maps to the current tracker,
- or high methodology value even if engineering work is non-trivial, such as Solana USDC/USDT/PYUSD/USDG.

I de-prioritized assets when:

- market cap is low and event surface is only KYC/allowlist without frozen-balance semantics,
- no verified per-address event surface was found,
- the relevant control is purely off-chain,
- or the work needs a new non-EVM adapter but the asset supply is not material.

## Executive Ranking

### Implementation-Ready EVM Backlog

| Priority | Asset | Approx. cap | Chains prepared | Event family | Parser gap | Valuation gap | Status |
| ---: | --- | ---: | --- | --- | --- | --- | --- |
| 1 | FDUSD | ~$408M | Ethereum, BSC, Arbitrum | `Freeze(address,address)` / `Unfreeze(address,address)` | none; reuse dual-index parser | none, USD | ready |
| 2 | BRZ | ~$296M | Ethereum, Gnosis | `Blacklisted(address)` / `UnBlacklisted(address)` | none; indexed address | BRL/USD conversion | ready after valuation mapping |
| 3 | AUSD | ~$162M | Arbitrum, Base | `AccountFrozen(address)` / `AccountUnfrozen(address)` | none; indexed address | none, USD | ready |
| 4 | MNEE | ~$101M | Ethereum | blacklisted/frozen/delisted/unfrozen + confiscation/burn | indexed `uint256` amount support | none, USD | parser extension needed |
| 5 | EURI | ~$60M | Ethereum, BSC | `Freeze(address,address)` / `Unfreeze(address,address)` | none; reuse dual-index parser | EUR/USD conversion | ready after valuation mapping |
| 6 | USDQ | ~$52M | Ethereum | `BlockPlaced` / `BlockReleased` / `DestroyedBlockedFunds` | none; reuse USDT0 parser | none, USD | ready |
| 7 | USDO | ~$41M | Ethereum, Base | `AccountBanned(address)` / `AccountUnbanned(address)` | none; indexed address | none, USD | ready |
| 8 | USDX | ~$42M | Ethereum | `AddedBlacklist(address)` / `RemovedBlacklist(address)` | likely non-indexed address; existing static-data parser | destroy needs tx-input if desired | ready for blacklist only |
| 9 | AID | ~$18M | Ethereum | `AddedToDenyList(address[])` / `RemovedFromDenyList(address[])` | reuse dynamic `address[]` parser | none, USD | ready |
| 10 | tGBP | ~$16M | Ethereum, Avalanche | `Banned(address)` / `UnBanned(address)` | none; indexed address | GBP/USD conversion | ready after valuation mapping |

### Infrastructure / Methodology Backlog

| Priority | Surface | Why it matters | Required new capability | First target set |
| ---: | --- | --- | --- | --- |
| 1 | Solana SPL/Token-2022 freeze adapter | Largest uncovered supply: USDC, USDT, USDG, PYUSD, USD1, YLDS | Solana instruction/indexer source, token-account subject identity | USDC, USDT, USDG, PYUSD, USD1, YLDS |
| 2 | EURC mirror suppression | Material Circle-controlled supply but known mirror-noise problem | Mirror classifier and public-total suppression semantics | EURC Ethereum/Base/Avalanche |
| 3 | External list contracts | Captures USDY and USTB/OUSG-style permissioned assets | event-source contract provenance and list-source keys | USDY blocklist/sanctions list |
| 4 | AccessControl role events | Captures mTBILL/EURAU-style `BLACKLISTED_ROLE` | topic1 role-hash filtering and role-event mapping | mTBILL, EURAU |
| 5 | XRPL adapter | RLUSD/USDC/EURCV/USDQ/VEUR trustline freeze/clawback | XRPL transaction parser and trustline balance model | RLUSD, USDC |
| 6 | Stellar adapter | USDC/EURC/PYUSD/USDY authorization/clawback | Horizon operation parser and trustline model | USDC, EURC, PYUSD |

### Highest-Value Next Opportunities

1. **Solana adapter** for USDC, USDT, USD1, PYUSD, USDG, and YLDS.
   - Current uncovered tracked supply: USDC ~$8.0B, USDT ~$3.1B, USDG ~$1.34B, PYUSD ~$751M, USD1 ~$745M, YLDS ~$575M.
   - Requires new chain adapter and token-account identity decisions.

2. **A7A5 Tron**.
   - Current uncovered supply: ~$545M.
   - Likely Tether-like event family, but TronGrid result keys must be verified before implementation.

3. **FDUSD Ethereum/BSC/Arbitrum**.
   - Current total supply: ~$408M.
   - Verified EVM `StablecoinV2` with `Freeze(address,address)` / `Unfreeze(address,address)`.
   - Very close to existing `USD1` / `U` event family.

4. **EURC with zero-balance/mirrored-action suppression**.
   - Current total supply: ~$419M.
   - Existing data proves Circle-style events are ingestible, but current docs intentionally exclude it because many EURC rows mirror USDC actions with zero balance.
   - Needs product-safe noise suppression, not raw config re-addition.

5. **USDY Ethereum/Arbitrum external blocklist + sanctions-list contracts**.
   - Current supply: ~$2.17B.
   - High value, but needs event-source-contract provenance and dual-source list-state handling.

6. **BUIDL seize-only coverage**.
   - Current supply: ~$3.03B.
   - Verified Securitize `Seize` / `OmnibusSeize` events on multiple EVM deployments.
   - Needs a `seize` methodology or explicit mapping into `destroy`.

7. **Direct EVM event wave for mid-cap centralized tokens**:
   - AUSD, BRZ, MNEE, EURI, USDO, EURR/USDR/USDQ, USDX, tGBP, XAUm, AID.
   - These have verified event surfaces and mostly require adding event families plus price conversion for non-USD pegs.

## High-Value Chain Expansion Gaps

### USDT

Material tracked but uncovered supply:

| Chain | Current supply | Local contract? | Current tracker support | Opportunity |
| --- | ---: | --- | --- | --- |
| Solana | ~$3.05B | yes | no | Solana SPL freeze/thaw adapter |
| Plasma | ~$917M | yes | no | EVM support requires RPC/explorer support and ABI verification |
| Aptos | ~$679M | yes | no | Move adapter |
| TON | ~$581M | yes | no | TON adapter |
| Mantle | ~$454M | yes | no | EVM chain support + ABI verification |
| Ink | ~$226M | yes | no | EVM chain support + ABI verification |
| Celo | ~$132M | yes | no | EVM support possible; verify event family |
| Kava | ~$110M | yes | no | EVM support possible; verify event family |
| Fantom | ~$83M | yes | no | EVM support possible; verify event family |

Implementation prep:

- For EVM USDT-like contracts, first verify if deployment emits legacy `AddedBlackList`/`RemovedBlackList`/`DestroyedBlackFunds` or USDT0 `BlockPlaced`/`BlockReleased`/`DestroyedBlockedFunds`.
- For chains already in repo public RPC registry (`celo`, `fantom`) this is mostly a config + start-block task if ABI matches.
- For `plasma`, `mantle`, `ink`, add `buildChainRpcs()` support or explorer/Etherscan-compatible source first.
- For Solana/Aptos/TON, see non-EVM adapter sections.

### USDC

Material tracked but uncovered supply:

| Chain | Current supply | Local contract? | Current tracker support | Opportunity |
| --- | ---: | --- | --- | --- |
| Solana | ~$8.03B | yes | no | Solana SPL freeze/thaw adapter |
| BSC | ~$1.28B | yes | no | Likely bridged/pegged asset; do not assume Circle native event family |
| Sui | ~$371M | yes | no | Sui adapter |
| Aptos | ~$303M | yes | no | Move adapter |
| Stellar | ~$265M | yes | no | Stellar authorization/clawback adapter |
| Starknet | ~$240M | yes | no | Cairo adapter |
| Fantom | ~$181M | yes | no | EVM support possible; verify native/bridged contract |
| Cronos | ~$179M | yes | no | EVM support possible; verify contract |
| Noble | ~$145M | yes | no | Cosmos/Noble adapter |
| Sonic | ~$102M | yes | no | EVM support possible; verify Circle events |

Implementation prep:

- Do not bulk-add every USDC contract using the Circle event family. Some entries are bridged or wrapped assets and may not be Circle-controlled.
- Solana and Stellar are more strategically valuable than most EVM tails because they have both supply and native issuer-control primitives.
- BSC USDC should be treated as a separate investigation; supply is material, but it may be Binance-pegged or legacy bridged rather than native Circle USDC.

### USD1

Material tracked but uncovered supply:

| Chain | Current supply | Local contract? | Current tracker support | Opportunity |
| --- | ---: | --- | --- | --- |
| Solana | ~$745M | yes | no | Solana SPL freeze/thaw adapter |
| Aptos | ~$14.6M | yes | no | Move adapter, lower priority |
| AB Core | ~$3.7M | yes | no | EVM support low priority |

Implementation prep:

- Solana is the only meaningful next USD1 chain right now.
- EVM tails are too small unless the implementation is free after broader EVM chain support exists.

### PYUSD

Material tracked but uncovered supply:

| Chain | Current supply | Local contract? | Current tracker support | Opportunity |
| --- | ---: | --- | --- | --- |
| Solana | ~$751M | yes | no | Token-2022 freeze/permanent-delegate adapter |
| Flow | ~$9.6M | yes | no | Flow adapter, not meaningful yet |

Implementation prep:

- Solana PYUSD is Token-2022 with freeze authority and permanent delegate in the parsed mint data.
- This makes it more than freeze/thaw: a permanent delegate can burn from token accounts, so Solana destroy/seize tracking should include Token-2022 delegate burns by the issuer delegate.

### USDG

Material tracked but uncovered supply:

| Chain | Current supply | Local contract? | Current tracker support | Opportunity |
| --- | ---: | --- | --- | --- |
| Solana | ~$1.34B | yes | no | Token-2022 freeze/permanent-delegate adapter |
| X Layer | ~$269M | yes | no | EVM support + ABI verification |
| Ink | ~$107M | yes | no | EVM support + ABI verification |

Implementation prep:

- Solana USDG is Token-2022 with freeze authority and permanent delegate, same issuer authority as Solana PYUSD.
- X Layer / Ink should use the Paxos `FreezeAddress` family only after ABI verification. Quick Sourcify pass did not resolve them.

### A7A5

Material tracked but uncovered supply:

| Chain | Current supply | Local contract? | Current tracker support | Opportunity |
| --- | ---: | --- | --- | --- |
| Tron | ~$545M | yes | no | TronGrid event mapping |

Implementation prep:

- Verify Tron event names/result keys before implementation.
- Likely candidates based on Ethereum ABI:
  - `Blacklisted`
  - `DeBlacklisted`
  - `DestroyedBlackFunds`
- Extend `TRON_EVENT_NAME_MAP` for `Blacklisted` / `DeBlacklisted`.
- Add `tronResultKey` values only after inspecting a real TronGrid event payload or Tronscan ABI.
- Reuse A7A5 price-cache conversion from v3.8.

## EVM Direct-Event Opportunities

These are the cleanest next EVM additions because they expose per-address events that can map into the existing `blacklist_events` model.

### FDUSD (`fdusd-first-digital`) — High Priority

Market cap: ~$408M.

Verified deployments:

- Ethereum `0xc5f0f7b66764f6ec8c8dff7ba683102295e16409`
- BSC `0xc5f0f7b66764f6ec8c8dff7ba683102295e16409`
- Arbitrum `0x93c9932e4afa59201f0b5e63f7d816516f1669fe`

Verified ABI:

- contract: `StablecoinV2`
- events:
  - `Freeze(address indexed,address indexed)`
  - `Unfreeze(address indexed,address indexed)`
- functions:
  - `freeze(address)`
  - `unfreeze(address)`
  - `frozen(address)`

Implementation:

- Reuse `USD1_EVENT_FAMILY` / dual-index event family.
- Add `FDUSD` to `BLACKLIST_STABLECOINS`.
- Add chart color.
- Add config specs for Ethereum, BSC, Arbitrum.
- Current balance is normal ERC-20 `balanceOf`.
- No destroy/clawback event was found in ABI.

Load:

- +3 configs.
- +6 log-topic calls/hour.
- +3 cursor read/write pairs/hour.
- Freeze rows add current-balance upserts.

Notes:

- Very strong candidate for the next implementation wave.

### EURC (`eurc-circle`) — High Priority But Needs Noise Suppression

Market cap: ~$419M.

Current state:

- Legacy EURC rows exist in production D1.
- It is intentionally excluded from live filter enum because Circle often mirrors USDC blacklist actions across EURC, creating many zero-balance EURC rows.

Implementation options:

1. **Strict amount-gated EURC live support**
   - Add EURC configs using Circle `Blacklisted`/`UnBlacklisted`.
   - Insert event rows only when either:
     - historical/current balance is non-zero above dust threshold, or
     - there is independent EURC-specific signal.
   - Risk: suppresses a genuine zero-balance blacklist event, but that is likely acceptable for freeze-ledger value semantics.

2. **Store events but exclude zero-value mirrors from public totals**
   - Keep all rows.
   - Add `amount_status`/`amount_source` semantics or a new flag such as `suppressed_mirror`.
   - Public stats and charts ignore suppressed mirrors.
   - Risk: schema/methodology larger.

3. **Dedicated Circle mirror classifier**
   - Detect same-address, same-window USDC + EURC events.
   - If EURC balance is zero and USDC balance is non-zero, mark EURC as mirror-no-value.
   - Preserve row provenance.

Recommended:

- Option 3 is the cleanest. It fixes the specific reason EURC was removed without hiding genuine EURC freezes.

Load:

- Ethereum/Base/Avalanche EURC EVM configs: +6 log-topic calls/hour for 3 configs.
- If adding World Chain too, repo needs chain RPC/explorer support.

### BRZ (`brz-transfero`) — High Priority Non-USD EVM

Market cap: ~$296M.

Verified event surface:

- Ethereum `TokenV2_1`
- Gnosis `TokenV2_1`
- events:
  - `Blacklisted(address indexed)`
  - `UnBlacklisted(address indexed)`
- functions:
  - `blacklist(address)`
  - `unBlacklist(address)`
  - `isBlacklisted(address)`

Implementation:

- Add `BRZ` symbol.
- Reuse Circle-style `Blacklisted` / `UnBlacklisted`.
- Add price-cache / FX conversion for BRL-denominated native amount.
- Ethereum and Gnosis are verified. Polygon/Base/Arbitrum need implementation resolution or explorer support before inclusion.

Parser work:

- none beyond existing indexed-address parsing.

Load:

- Ethereum + Gnosis: +4 log-topic calls/hour, +2 cursor read/write pairs/hour.

### AUSD (`ausd-agora`) — High Priority Medium-Cap EVM

Market cap: ~$162M.

Verified event surface:

- Arbitrum and Base implementations resolve to `AgoraDollar`.
- events:
  - `AccountFrozen(address indexed)`
  - `AccountUnfrozen(address indexed)`
- functions:
  - `batchFreeze(address[])`
  - `batchUnfreeze(address[])`
  - `accountData(address)`

Implementation:

- Add event family:
  - `AccountFrozen(address)` -> `blacklist`
  - `AccountUnfrozen(address)` -> `unblacklist`
- Add Arbitrum and Base configs first.
- Ethereum/Avalanche/BSC/Polygon/Monad/Mantle/Katana likely share the proxy, but quick scan did not resolve all implementations through current public RPC/Sourcify. Verify before adding.

Load:

- Arbitrum + Base: +4 log-topic calls/hour.

### MNEE (`mnee-mnee`) — High-Quality Event Surface

Market cap: ~$101M.

Verified event surface:

- Ethereum implementation `MNEE`.
- events:
  - `AccountBlacklisted(address indexed)`
  - `AccountDelisted(address indexed)`
  - `AccountFrozen(address indexed)`
  - `AccountUnfrozen(address indexed)`
  - `FundsConfiscated(address indexed,uint256 indexed,address indexed)`
  - `HoldingsBurnt(address indexed,uint256 indexed)`

Implementation:

- Add `MNEE` symbol.
- Map:
  - `AccountBlacklisted` and `AccountFrozen` -> `blacklist`
  - `AccountDelisted` and `AccountUnfrozen` -> `unblacklist`
  - `FundsConfiscated` and `HoldingsBurnt` -> `destroy` or future `seize`
- Parser needs **indexed uint256 amount extraction** because the ABI marks amount as indexed for confiscation/burn events.
- Add `amountTopicIndex` or `uint256TopicIndex` to `BlacklistEventDef`.

Load:

- +1 config.
- +6 log-topic calls/hour if all relevant events tracked.

### EURI (`euri-banking-circle`) — Simple Dual-Index Family

Market cap: ~$60M.

Verified event surface:

- Ethereum and BSC `Stablecoin`.
- events:
  - `Freeze(address indexed,address indexed)`
  - `Unfreeze(address indexed,address indexed)`

Implementation:

- Reuse `USD1_EVENT_FAMILY`.
- Add EUR price conversion via price cache or FX reference.

Load:

- +2 configs.
- +4 log-topic calls/hour.

### Hadron / Tether-Style Blocked-List Tokens

Assets:

- `eurr-stablr` / EURR (~$13M)
- `usdr-stablr` / USDR (~$6M)
- `usdq-quantoz` / USDQ (~$52M)

Verified event surface:

- `HadronToken` / similar.
- events:
  - `BlockPlaced(address indexed)`
  - `BlockReleased(address indexed)`
  - `DestroyedBlockedFunds(address indexed,uint256)`
- functions:
  - `addToBlockedList`
  - `removeFromBlockedList`
  - `destroyBlockedFunds`

Implementation:

- Reuse USDT0 event family.
- Add price conversion for EUR-denominated tokens (`EURR`) and possibly USDQ no conversion.
- Good low-risk config additions once product accepts long-tail symbols.

Load:

- +3 topics/config.

### USDO (`usdo-openeden`)

Market cap: ~$41M.

Verified event surface:

- Ethereum and Base `USDO`.
- events:
  - `AccountBanned(address indexed)`
  - `AccountUnbanned(address indexed)`
- functions include `BANLIST_ROLE`.

Implementation:

- Add event family:
  - `AccountBanned` -> `blacklist`
  - `AccountUnbanned` -> `unblacklist`
- Ethereum/Base configs.
- No destroy event found.

Load:

- +2 configs.
- +4 log-topic calls/hour.

### USDX (`usdx-hex-trust`)

Market cap: ~$42M.

Verified event surface:

- Ethereum `HexTrustUSDV2`.
- events:
  - `AddedBlacklist(address)`
  - `RemovedBlacklist(address)`
- functions:
  - `addBlacklist(address)`
  - `removeBlacklist(address)`
  - `isBlacklisted(address)`
  - `burnBlackFunds(address)` (function found, but no matching event found in quick ABI scan)

Implementation:

- Add `AddedBlacklist` / `RemovedBlacklist` event family.
- Address appears non-indexed unless ABI confirms otherwise; parser likely uses first data word.
- Destroy/burn support requires transaction-input classification or receipt inference if no event exists.

### tGBP (`tgbp-tokenised`)

Market cap: ~$16M.

Verified event surface:

- Ethereum and Avalanche `StableTokenV1OFT`.
- events:
  - `Banned(address indexed)`
  - `UnBanned(address indexed)`

Implementation:

- Add `Banned` / `UnBanned` event family.
- GBP price conversion needed.
- Low cap but technically clean.

### XAUm (`xaum-matrixdock`)

CoinGecko market cap not in DefiLlama pass, but tokenized gold coverage is strategically relevant.

Verified event surface:

- Ethereum `MTokenMain`.
- events:
  - `BlockPlaced(address indexed)`
  - `BlockReleased(address indexed)`
- functions:
  - `addToBlockedList`
  - `removeFromBlockedList`

Implementation:

- Add block/unblock only. No `DestroyedBlockedFunds` event found.
- Gold/commodity price conversion needed via `xaum-matrixdock`.

### AID (`aid-gaib`)

Market cap: ~$17.8M.

Verified event surface:

- Ethereum `AID`.
- events:
  - `AddedToDenyList(address[])`
  - `RemovedFromDenyList(address[])`

Implementation:

- Reuse dynamic `address[]` parser from USDTB.
- Map deny-list add/remove to blacklist/unblacklist.
- Base proxy did not resolve to implementation in quick pass; Ethereum first.

## Role-Based / Permissioned EVM Opportunities

These are meaningful but should not be mixed into the simple event-family wave without a small parser/model extension.

### AccessControl `BLACKLISTED_ROLE` Tokens

Observed examples:

- `mtbill-midas` / mTBILL:
  - functions expose `BLACKLISTED_ROLE`, `BLACKLIST_OPERATOR_ROLE`, `GREENLISTED_ROLE`.
  - events are generic `RoleGranted(bytes32,address,address)` and `RoleRevoked(bytes32,address,address)`.
- `eurau-allunity` / EURAU:
  - functions expose `BLACKLISTED_ROLE`, `BLACKLISTED_BURNER_ROLE`, `burnFromBlacklistedAddress`.
  - events are generic AccessControl role events.

Implementation:

- Add a `roleEvent` blacklist source type:
  - filter topic0 = `RoleGranted` / `RoleRevoked`,
  - filter topic1 = role hash, e.g. `keccak256("BLACKLISTED_ROLE")`,
  - affected address = `topics[2]`,
  - `RoleGranted` -> `blacklist`,
  - `RoleRevoked` -> `unblacklist`.
- Add support for topic filters beyond topic0 in `fetchAlchemyLogs` / `fetchEvmLogsForTopic`, or add a new EVM source path.
- For burns such as `burnFromBlacklistedAddress`, no event was confirmed in quick scan; tracking destroys may require transaction-input classification.

Load:

- +2 topics/config, but each with topic1 narrowing. This can be efficient with RPC logs if topic arrays are supported.

### Allow/Deny Permission Tokens

Examples:

- `sbc-brale` uses `allow(address[])`, `deny(address[])`, and `isAllowed(address)`, but quick scan saw no dedicated allow/deny events beyond role events.
- `zarp-zarp` uses `AddressVerificationChanged(address,address,bool)`, which is KYC/permission state rather than freeze.
- `ustb-superstate` and `ousg-ondo-finance` are allowlist/KYC systems already covered in the previous research.

Recommendation:

- These belong in a **permissioned-token compliance tracker**, not the current freeze ledger, unless there is a direct deny/ban event.

## Seize / Forced-Transfer Opportunities

### BUIDL (`buidl-blackrock`)

Market cap: ~$3.03B.

Verified event surface:

- Securitize `DSToken` on Optimism/Arbitrum; likely same family on other verified deployments.
- events:
  - `Seize(address indexed,address indexed,uint256,string)`
  - `OmnibusSeize(address indexed,address,address,uint256,string,uint8)`

Implementation:

- Requires a product/methodology decision:
  - add event type `seize`, or
  - map to `destroy` with `source = "seize_event"`.
- Current active-record logic ignores destroy rows with no prior blacklist row; tracked ledger can store them, but public event semantics need to say "seized" not "frozen".

Recommendation:

- Keep as a separate "seize-only" release, not part of direct freeze expansion.

### USTB (`ustb-superstate`)

Verified source from Superstate:

- token has `AdminBurn(address indexed,address indexed,uint256)`.
- allowlist state lives in separate allowlist contract with entity and fund permissions.

Implementation:

- `AdminBurn` can be tracked as seize/destroy.
- Allowlist removals require stateful entity/address/fund tables and should not be represented as ordinary blacklist rows.

Recommendation:

- Implement as permission/seize tracker only after public methodology distinguishes "permission revoked" from "frozen".

### USDat (`usdat-saturn`)

Market cap currently not material in DefiLlama pass, but ABI is rich:

- `Frozen(address indexed,uint256)`
- `Unfrozen(address indexed,uint256)`
- `ForcedTransfer(address indexed,address indexed,address indexed,uint256)`

Implementation:

- If supply grows, this becomes technically good coverage:
  - freeze/unfreeze events include indexed address plus a uint256.
  - forced transfer maps to seize/destroy if product accepts it.

## Non-EVM Adapter Opportunities

### Solana Adapter — Highest Strategic Value

Material uncovered assets:

- USDC ~$8.03B.
- USDT ~$3.05B.
- USDG ~$1.34B.
- PYUSD ~$751M.
- USD1 ~$745M.
- YLDS ~$575M.
- CASH ~$125M.
- Smaller but visible: USDK, XO, etc.

Observed mint control surface from Solana JSON-RPC:

- USDC SPL mint has a `freezeAuthority`.
- USDT SPL mint has a `freezeAuthority`.
- USD1 SPL mint has a `freezeAuthority`.
- PYUSD Token-2022 mint has:
  - `freezeAuthority`,
  - `permanentDelegate`,
  - transfer-fee/confidential-transfer extensions.
- USDG Token-2022 mint has:
  - `freezeAuthority`,
  - `permanentDelegate`,
  - transfer-fee/confidential-transfer extensions.
- YLDS SPL mint has a `freezeAuthority`.
- CASH/USDK/XO Token-2022 mints also expose freeze authority and/or permanent delegate style controls.

Official Solana docs confirm:

- `FreezeAccount` prevents transfers and burns for a token account until thawed.
- only the mint's freeze authority can freeze accounts.
- Token-2022 permanent delegate can transfer or burn from token accounts as delegate.

Observed mint authority snapshot from public Solana RPC:

| Asset | Program | Mint | Freeze authority | Permanent delegate | Approx. supply gap |
| --- | --- | --- | --- | --- | ---: |
| USDC | SPL Token | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar` | n/a | ~$8.03B |
| USDT | SPL Token | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `Q6XprfkF8RQQKoQVG33xT88H7wi8Uk1B1CC7YAs69Gi` | n/a | ~$3.05B |
| USDG | Token-2022 | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | `2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk` | `2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk` | ~$1.34B |
| PYUSD | Token-2022 | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | `2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk` | `2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk` | ~$751M |
| USD1 | SPL Token | `USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB` | `84ssq8Ud2WRzxVCuEmPa9xLPBUt4odmB8wuE8svZkh71` | n/a | ~$745M |
| YLDS | SPL Token | `8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih` | `8A18H7n3atDfQsN8rLvt98hj5WZJWwhqqR8digDvbia6` | n/a | ~$575M |

Implementation architecture:

- New `solana` blacklist source module.
- Cursor table cannot use block number; use signature cursor plus slot:
  - either extend `blacklist_sync_state` semantics for Solana,
  - or create a source-specific sync-state table.
- Event discovery:
  - Public RPC `getSignaturesForAddress(mint)` is likely too noisy for high-volume USDC/USDT and may not retain enough history.
  - Prefer an indexed provider or data warehouse for historical backfill.
  - For live forward tracking, subscription/webhook/indexer path is better than polling all mint signatures.
- Parse instructions:
  - Token Program `FreezeAccount` / `ThawAccount`.
  - Token-2022 equivalent instructions.
  - Token-2022 `BurnChecked` by permanent delegate for issuer-seize semantics.
- Identity model:
  - frozen entity is a token account, not necessarily the wallet.
  - The token account carries an owner wallet.
  - Current schema has one `address` column; storing only token account is technically precise but user-hostile, while storing only owner can merge multiple token accounts.
  - Recommended: add `subject_address` / `account_address` style provenance, or encode token account in `contract_address`/metadata only as a stopgap.
- Current balance:
  - read parsed token account amount at latest for current ledger,
  - for event-time amount, use pre-event token account state if provider supports historical account state; otherwise mark event-time amount recoverability as unavailable and rely on current ledger.

Load:

- Potentially high if using public RPC history.
- With an indexed provider, live events are sparse and D1 writes scale with freeze/thaw events.

Recommendation:

- This is the biggest coverage unlock. Do not implement with naive public RPC mint-history scans for USDC/USDT. Design an indexed Solana event source first.

### XRPL Adapter

Material assets:

- RLUSD has XRPL issuance.
- USDC has XRPL issuance.
- EURCV, USDQ, VEUR, and others also have XRPL entries.

Official XRPL docs confirm:

- issuers can freeze individual trust lines,
- deep freeze can prevent receiving as well as spending,
- token freezes do not apply to XRP itself.

Implementation architecture:

- New XRPL source module.
- Track issuer account + currency code per asset.
- Parse transactions:
  - `TrustSet` with freeze/deep-freeze flag changes,
  - potentially `Clawback` transactions where supported.
- Current balance:
  - `account_lines` / Clio equivalent for trustline balances.
- Cursor:
  - ledger index + transaction hash.
- Event mapping:
  - set individual freeze / deep freeze -> `blacklist`,
  - clear freeze / deep freeze -> `unblacklist`,
  - clawback -> `destroy` or future `seize`.

Load:

- Lower event volume than Solana token transfer history if using issuer-account transaction stream.
- Needs robust XRPL provider with historical pagination.

Recommendation:

- Good second non-EVM adapter after Solana or in parallel if an XRPL data provider is easy to add.

### Stellar Adapter

Material assets:

- USDC Stellar ~$265M.
- EURC, PYUSD, USDY, EURCV, EURS, AUDD, CETES also have Stellar entries.

Official Stellar docs confirm:

- when authorization is revocable, issuer can revoke trustline authorization, freezing the asset held by an account.
- clawback-enabled issuers can claw back asset balances, burning them.
- `Set Trust Line Flag`, `Clawback`, and `Clawback Claimable Balance` are the relevant operations.

Implementation architecture:

- New Stellar source module using Horizon or archive provider.
- Track asset code + issuer.
- Parse operations:
  - `set_trust_line_flags`
  - `clawback`
  - `clawback_claimable_balance`
- Map:
  - revoke authorization / reduce to maintain-liabilities -> `blacklist`
  - restore authorization -> `unblacklist`
  - clawback -> `destroy` or `seize`.
- Current balance:
  - account balances for the asset, or effect payload if operation exposes amount.
- Cursor:
  - paging token.

Recommendation:

- Good high-quality adapter because Stellar explicitly models regulated-asset authorization and clawback.

### Aptos / Sui / TON / Noble / Cosmos

Meaningful assets exist:

- USDT Aptos ~$679M.
- USDC Aptos/Sui hundreds of millions.
- USDT TON ~$581M.
- USDC Noble ~$145M.
- USD1 Aptos ~$14.6M.

But this pass did not find a prepared event model from repo-local code or quick docs checks.

Recommendation:

- Do not start here unless a product priority targets one specific chain.
- Each needs a chain-specific transaction/event model and provider. They are real opportunities but less implementation-ready than Solana, XRPL, Stellar, and direct EVM.

## Parser / Schema Enhancements To Prepare

### 1. Event source contract separate from token contract

Needed for:

- USDY blocklist/sanctions lists.
- USTB allowlist.
- OUSG registry surfaces.

Design:

- Extend config with:
  - `eventSourceAddress`
  - `tokenContractAddress`
  - `eventSourceKind`
- Persist event source separately from token contract.
- Current `contract_address` should remain token contract if amount/current-balance recovery depends on it; add a new column if we need lossless provenance.

### 2. Additional topic filters

Needed for:

- AccessControl role-based blacklist (`RoleGranted`, `RoleRevoked`).

Design:

- Allow event definitions to specify topic filters beyond topic0:
  - topic1 = role hash.
- For Etherscan/RPC log scan, use topic arrays if source supports them.
- For fallback sources that cannot filter topic1, filter client-side but keep narrow scan windows.

### 3. Indexed uint256 amount extraction

Needed for:

- MNEE `FundsConfiscated(address indexed,uint256 indexed,address indexed)`.
- MNEE `HoldingsBurnt(address indexed,uint256 indexed)`.
- USDat `Frozen(address indexed,uint256)` if amount is indexed/non-indexed depending ABI.

Design:

- Add `amountTopicIndex?: number`.
- Existing `hasAmount` with indexed address currently assumes amount in `data`.
- Keep old behavior as default.

### 4. Chain-specific subject identity

Needed for:

- Solana token accounts vs owner wallets.
- Stellar trustlines.
- XRPL trustlines.

Design:

- Either add columns:
  - `subject_address`
  - `subject_type`
  - `holder_address`
- Or introduce a new non-EVM ledger table and map to public API after normalization.

Recommendation:

- Do not overload `address` with composite strings for non-EVM. It will hurt search, display, and de-duplication.

### 5. Non-USD amount conversion

Already partially solved for A7A5.

Needed for:

- BRZ, EURC/EURI/EURR/EURAU/EURCV, TRYB, XSGD, tGBP, ZARP, CADC, VCHF/VEUR/VGBP, gold/silver tokens.

Design:

- Generalize `getBlacklistPriceAssetId()` or use peg/fx reference lookup when price-cache is unavailable.
- For fiat-pegged non-USD assets, prefer price-cache if current and validated; fallback to FX reference only if methodology accepts it.

## Recommended Roadmap

### Wave 2A — Direct EVM Events, Low Risk

Implement next:

1. FDUSD Ethereum/BSC/Arbitrum.
2. EURI Ethereum/BSC.
3. AUSD Arbitrum/Base, then verify other chains.
4. BRZ Ethereum/Gnosis with BRL conversion.
5. EURR/USDR/USDQ Hadron-family tokens.
6. USDO Ethereum/Base.
7. MNEE Ethereum after indexed amount extraction is added.

Why:

- Adds many verified surfaces with modest code change.
- Keeps semantics close to existing blacklist/freeze model.
- Avoids the larger methodology fight around allowlists and seize-only assets.

Estimated steady-state load:

- Roughly +20 to +30 configs depending exact chain inclusion.
- Roughly +50 to +80 log-topic calls/hour.
- Still below the 900 blacklist subrequest budget, but initial backfill may need multiple hourly cycles.

### Wave 2B — EURC Re-Enablement

Implement after designing mirror-noise suppression.

Recommended rule:

- classify EURC rows as live/public only when EURC balance at event/current snapshot is non-zero or when no matching USDC mirror exists in a tight time window.

Why:

- EURC supply is material.
- Existing exclusion is a data-quality problem, not an absence of event support.

### Wave 3 — Solana Adapter

Implement once provider/indexing decision is made.

Start with:

- USDC
- USDT
- PYUSD
- USDG
- USD1
- YLDS

Why:

- This is by far the largest uncovered issuer-control surface by supply.

Blocker:

- Public RPC mint-signature polling is not a safe historical strategy for USDC/USDT scale.

### Wave 4 — External Lists / Permissioned Token State

Implement as an explicit methodology expansion, not hidden inside current event configs.

Targets:

- USDY blocklist + sanctions list.
- USTB allowlist + admin burn.
- OUSG KYC registry.
- mTBILL / EURAU AccessControl `BLACKLISTED_ROLE`.
- BUIDL seize-only.

Why:

- Very high market-cap coverage, but these are not all "frozen balance" events in the current sense.

### Wave 5 — XRPL / Stellar

Implement after Solana or in parallel if a provider is available.

Targets:

- XRPL: RLUSD, USDC, EURCV, USDQ, VEUR.
- Stellar: USDC, EURC, PYUSD, USDY, EURCV, EURS, AUDD.

Why:

- These chains have explicit issuer freeze/authorization/clawback primitives that map well to Pharos once adapters exist.

## Opportunities I Would Not Prioritize Further Right Now

- **USYC**: verified Ethereum token ABI still showed no direct blacklist/freeze/seize event surface.
- **M / wM by M0**: token ABI showed earning toggles, not freeze/blacklist controls.
- **TUSD**: material cap, but Sourcify only surfaced proxies / bridge contracts in quick scan. Needs manual implementation ABI discovery before it becomes actionable.
- **USDP/GUSD old Paxos assets**: likely control surfaces exist historically, but quick scan did not resolve implementation ABIs cleanly. Worth revisiting only after higher-readiness assets.
- **Pure KYC/allowlist tokens without per-address event semantics**: useful for a permission tracker, not for current blacklist frozen-value ledger.
- **Sub-$10M long-tail tokens**: many expose some compliance controls, but coverage impact is low unless the implementation reuses a family already added for larger assets.

## Exhaustion Summary

After this pass, the meaningful remaining opportunities fall into five buckets:

1. direct EVM event families that are implementation-ready,
2. EURC re-enable with mirror suppression,
3. Solana adapter for very large uncovered supply,
4. external-list / role / allowlist compliance surfaces requiring a methodology expansion,
5. XRPL/Stellar adapters.

Beyond those, I did not find another distinct high-impact class of blacklist/freeze/destroy coverage in the current Pharos tracked universe. Remaining gaps either lack verified event surfaces, are low-cap enough to wait for shared parser support, or require chain-specific infrastructure that should be justified by one of the high-supply assets above.
