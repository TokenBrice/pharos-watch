# Blacklist Tracker — Top 25 Coverage Expansion Candidates

Audit date: 2026-04-17
Author: audit agent
Scope: Identify the next 25 most valuable stablecoin additions to the Pharos blacklist tracker, prioritized by market cap and viability of on-chain log-level observation.

## Summary

- Current coverage: 24 stablecoins (worker/src/lib/blacklist-contracts.ts).
- Candidate pool: top ~100 uncovered stablecoins by DefiLlama circulating USD, filtered to EVM/Tron with verified admin freeze/destroy capability emitting dedicated events (RoleGranted-based patterns treated as secondary).
- Out-of-scope exclusions (non-EVM/Tron-only or pure DeFi/CDP without admin blacklist): USDS (Sky), USDe, DAI, GHO, crvUSD, USD0, FRAX, USDai, reUSD, NUSD (Neutrl, see note), LUSD, BOLD, MIM, eUSD, USDH, JUPUSD (Solana), USX (Solana), CASH (Solana), USDGO (Solana), YLDS (Solana/Provenance), BUCK (Sui), USDSUI (Sui), HONEY (Berachain CDP).
- Excluded despite fiat-backed profile: SBC (Brale) — `deny()` function exists but emits no dedicated event (non-observable via logs); WUSD (Worldwide) — pause-only; AUDD (Novatti) — pause-only; AvUSD (Avant) — burnFrom/mint only; USDz (Anzen) — pause-only; TBILL (OpenEden) — vault with AllowList off-contract; Gemini GUSD — non-upgrade ERC20Proxy with custodianship model, no user-level blacklist events.

## Currently Covered (24)

usdt-tether, usdc-circle, paxg-paxos, xaut-tether, pyusd-paypal, usd1-world-liberty-financial, usdg-paxos, rlusd-ripple, u-united-stables, usdtb-ethena, a7a5-old-vector, fdusd-first-digital, brz-transfero, ausd-agora, mnee-mnee, euri-banking-circle, usdq-quantoz, usdo-openeden, usdx-hex-trust, aid-gaib, tgbp-tokenised, usdp-paxos, eurc-circle, buidl-blackrock.

## Top 25 Ranked Candidates

Market caps pulled from DefiLlama `stablecoins?includePrices=true` on 2026-04-17. Chain list trimmed to EVM/Tron chains that already exist in CHAIN_META (Ethereum, BSC, Polygon, Arbitrum, Base, Optimism, Avalanche, Gnosis, Celo, Tron). Cross-chain deployments with LayerZero OFT pattern (same address on many chains) are noted but the first-wave scope targets the top ~2 chains per coin by supply.

| # | Symbol | Issuer | MCap (USD) | Chains (first-wave) | stablecoinId | Family | Complexity |
|---|--------|--------|-----------:|---------------------|--------------|--------|-----------|
| 1 | USDY | Ondo | $2.46B | Ethereum, Arbitrum, Mantle | `usdy-ondo-finance` | NEW: `ONDO_BLOCKLIST_SET_FAMILY` (only logs pointer changes; per-address state sits in an external Blocklist + SanctionsList contract — see note) | HIGH — needs separate blocklist contract discovery |
| 2 | USDD | Tron DAO Reserve | $1.54B | Tron, Ethereum | `usdd-tron-dao-reserve` | NONE (only `deny()` fn, no event) | SKIP (not observable via logs) |
| 3 | TUSD | TrueUSD | $484M | Ethereum, Avalanche, Polygon, Arbitrum, Optimism, BSC, Tron | `tusd-trueusd` | NEW: `TRUEUSD_EVENT_FAMILY` (`Blacklisted(address indexed,bool)` + `DestroyedBlackFunds(address indexed,uint256)`) | MEDIUM — bool flag in data tells blacklist vs unblacklist |
| 4 | EURCV | SocGen-Forge | $108M | Ethereum | `eurcv-societe-generale-forge` | NEW: `SOCGEN_FREEZE_FAMILY` (`AddressesFrozen(address[])` / `AddressesUnFrozen(address[])`, array-style) | MEDIUM — same shape as DENY_LIST_EVENT_FAMILY (batch) |
| 5 | JPYC | JPYC | $72M | Ethereum, Polygon, Avalanche | `jpyc-jpyc` | NEW: `CENTRE_BLOCKLISTED_FAMILY` (`Blocklisted(address indexed)` / `UnBlocklisted(address indexed)`, USDC-fork rename) | LOW |
| 6 | XAUm | Matrixdock | $500M* | Ethereum, BSC | `xaum-matrixdock` | EXISTING: `USDT0_EVENT_FAMILY` (BlockPlaced/BlockReleased indexed — no Destroy event on this contract) | LOW |
| 7 | USAT | Tether | $150M | Ethereum | `usat-tether` | EXISTING: `USDT0_EVENT_FAMILY` (BlockPlaced/BlockReleased/DestroyedBlockedFunds, all indexed) | LOW |
| 8 | EURR | StablR | $15.3M | Ethereum | `eurr-stablr` | EXISTING: `USDT0_EVENT_FAMILY` (same Quantoz-family contract) | LOW |
| 9 | EURQ | Quantoz | <$10M | Ethereum | `eurq-quantoz` | EXISTING: `USDT0_EVENT_FAMILY` | LOW |
| 10 | FIDD | Fidelity Digital | $50.8M | Ethereum | `fidd-fidelity` | NEW: `FIDELITY_RESTRICTION_FAMILY` (`TransferRestrictionImposed(address indexed)` / `TransferRestrictionRemoved(address indexed)`) | LOW |
| 11 | EURE | Monerium | $40.6M | Gnosis, Ethereum, Polygon, Arbitrum, Linea | `eure-monerium` | NONE (no blacklist/freeze events on current impl) | SKIP |
| 12 | XSGD | StraitsX | $12.6M | Ethereum, Polygon, Arbitrum, Avalanche, Base | `xsgd-straitsx` | EXISTING: `USDC_EVENT_FAMILY` (USDC FiatToken fork — `Blacklisted`/`UnBlacklisted`) | LOW |
| 13 | MXNB | Juno (Bitso) | — | Ethereum, Polygon, Arbitrum, Avalanche | `mxnb-juno` | EXISTING: `USDC_EVENT_FAMILY` | LOW |
| 14 | XUSD | StraitsX | $50.2M | Ethereum, BSC | `xusd-straitsx` | EXISTING: `USDC_EVENT_FAMILY` | LOW |
| 15 | CADC | CAD Coin | <$10M | Ethereum, Polygon, Arbitrum, Base | `cadc-cad-coin` | EXISTING: `USDC_EVENT_FAMILY` | LOW |
| 16 | TRYB | BiLira | $3M | Ethereum, BSC, Avalanche, Polygon, Base | `tryb-bilira` | EXISTING: `USDC_EVENT_FAMILY` (also has `seize()` function without event) | LOW |
| 17 | IDRT | Rupiah Token | <$5M | Ethereum, BSC, Polygon | `idrt-rupiah-token` | NEW: `RUPIAH_BLACKLIST_FAMILY` (`Blacklisted(address indexed)` / `Unblacklisted(address indexed)` — note lowercase "Un") | LOW |
| 18 | IDRX | IDRX | $7M | Polygon, Base, BSC | `idrx-idrx` | EXISTING: `USDT_EVENT_FAMILY` (USDT-legacy, non-indexed: `AddedBlackList(address)` / `RemovedBlackList(address)` / `DestroyedBlackFunds(address,uint256)`) | LOW |
| 19 | USDA | Avalon | $270M | Ethereum, BSC | `usda-avalon` | EXISTING: `USDT_EVENT_FAMILY` (non-indexed AddedBlackList/RemovedBlackList) — but no Destroy event | LOW |
| 20 | AxCNH | AnchorX | — | Ethereum, Conflux | `axcnh-anchorx` | EXISTING: `USDC_EVENT_FAMILY` (Centre fork) | LOW |
| 21 | AEUR | Anchored Coins | $26M | Ethereum, BSC | `aeur-anchored-coins` | EXISTING: `USD1_EVENT_FAMILY` (`Freeze(address indexed,address indexed)` / `Unfreeze`) | LOW |
| 22 | FRXUSD | Frax | $136M | Ethereum | `frxusd-frax` | NEW: `FRAX_FREEZE_FAMILY` (`AccountFrozen(address)` / `AccountThawed(address)`, both non-indexed) | LOW |
| 23 | VEUR / VCHF / VGBP | VNX | $5–20M each | Ethereum, Base, Arbitrum, Avalanche | `veur-vnx`, `vchf-vnx`, `vgbp-vnx` | EXISTING: `PAXG_EVENT_FAMILY` (`AddressFrozen`/`AddressUnfrozen` — identical topic hashes as PAXG, minus the `FrozenAddressWiped` event) | LOW |
| 24 | GYEN | GYEN | $4.7M | Ethereum, Arbitrum | `gyen-gyen` | NEW: `GYEN_WIPE_FAMILY` (`Wipe(address indexed,uint256)` — destroy-only; no blacklist event) | MEDIUM (destroy-only) |
| 25 | apxUSD | Apyx | $160M | Ethereum | `apxusd-apyx` | NEW: `APYX_DENYLIST_FAMILY` (`DenyListUpdated(address indexed caller,address indexed account)`) | LOW |

\* XAUm circulation reported at the fund level ($500M+); on-chain supply is lower.

**Honorable mentions intentionally excluded or deprioritized:**
- NUSD (Neutrl, $172M, role-based `AddedToDenylist(address indexed)`) — qualifies for a new `NEUTRL_DENYLIST_FAMILY` and could replace one of the sub-$10M coins (#24 or #17) if market cap is the priority.
- YUSD (Aegis, $36M) — direct USDT-legacy pattern (`AddedBlackList`/`RemovedBlackList`, no Destroy). Same family as IDRX; inclusion would be trivial.
- EURAU / CHFAU (AllUnity) — uses AccessControl `RoleGranted` with the `BLACKLISTED_ROLE` hash `0x548c7f0307ab2a7ea894e5c7e8c5353cc750bb9385ee2e945f189a9a83daa8ed`; observable but requires a role-hash filter not a direct event-name filter. Deferred until a dedicated "role-based" family is built.
- mTBILL, OUSG, USTB — same pattern as AllUnity (role-based). Deferred.
- WLFI USAT — already assigned to `usat-tether` above.

### Strict "Top 25" ranking by market cap (replacing honorable mentions where useful)

If strict market-cap ranking is preferred, the final 25 becomes:

1. USDY (Ondo) — complex, needs external-contract discovery
2. TUSD — `TRUEUSD_EVENT_FAMILY` (new)
3. USDA (Avalon) — `USDT_EVENT_FAMILY`
4. NUSD (Neutrl) — `NEUTRL_DENYLIST_FAMILY` (new)
5. apxUSD — `APYX_DENYLIST_FAMILY` (new)
6. FRXUSD — `FRAX_FREEZE_FAMILY` (new)
7. EURCV — `SOCGEN_FREEZE_FAMILY` (new, batch)
8. USDCV — `SOCGEN_FREEZE_FAMILY` (new)
9. FIDD — `FIDELITY_RESTRICTION_FAMILY` (new)
10. XUSD (StraitsX) — `USDC_EVENT_FAMILY`
11. EURE (Monerium) — SKIP (no events)
12. XAUm — `USDT0_EVENT_FAMILY`
13. USAT — `USDT0_EVENT_FAMILY`
14. AEUR — `USD1_EVENT_FAMILY`
15. YUSD (Aegis) — `USDT_EVENT_FAMILY` (no Destroy)
16. JPYC — `CENTRE_BLOCKLISTED_FAMILY` (new)
17. EURR (StablR) — `USDT0_EVENT_FAMILY`
18. EURQ (Quantoz) — `USDT0_EVENT_FAMILY`
19. EURAU — role-based (deferred)
20. VEUR / VCHF / VGBP (VNX) — `PAXG_EVENT_FAMILY` (reuse)
21. CHFAU — role-based (deferred)
22. IDRT — `RUPIAH_BLACKLIST_FAMILY` (new)
23. XSGD — `USDC_EVENT_FAMILY`
24. IDRX — `USDT_EVENT_FAMILY`
25. GYEN — `GYEN_WIPE_FAMILY` (new, destroy-only)

## Per-Candidate Detail

### 1. USDY — Ondo US Dollar Yield ($2.46B) — `usdy-ondo-finance`

- Ethereum: proxy `0x96f6ef951840721adbf46ac996b59e0235cb985c`, impl `0xea0f7eebdc2ae40edfe33bf03d332f8a7f617528`, start block 17,672,244 (tx 0xad4961…2e3fb7).
- Events on the USDY token: only `BlocklistSet(address,address)` (unindexed), `SanctionsListSet(address,address)` (unindexed), `Paused(address)`, `Unpaused(address)` — **no per-address blacklist events on the token contract itself**. The token delegates to external `IBlocklist` and `ISanctionsList` contracts (addresses retrievable via `blocklist()` and `sanctionsList()` getters).
- **Integration note:** requires a one-off step to discover the current blocklist/sanctionsList addresses, then track events on *those* contracts. Adds a new config shape (referenced-contract discovery) — treat as HIGH complexity. Recommend a follow-up task rather than first-wave inclusion.

### 2. TUSD — TrueUSD ($484M) — `tusd-trueusd`

- Ethereum: proxy `0x0000000000085d4780b73119b644ae5ecd22b376`, impl `0xdbc97a631c2fee80417d5d69f32b198c8c39c27e`, start block 6,988,184.
- Events:
  - `Blacklisted(address indexed,bool)` — topic `0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8` — bool in data indicates add vs remove.
  - `DestroyedBlackFunds(address indexed,uint256)` — topic `0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6` (same hash as USDT legacy; but here address is indexed, so event decoding differs).
- **New family** `TRUEUSD_EVENT_FAMILY`: listener must branch on the bool in data to pick `eventType: "blacklist"` vs `"unblacklist"`. Alternative: emit two virtual events based on the bool, or add an optional `eventTypeFromDataByte` discriminator in `BlacklistEventDef`.
- Multi-chain: contracts differ per chain (not LayerZero OFT). Ethereum ledger is canonical. Polygon/Arbitrum deployments are separate proxies; ABIs should be spot-checked before adding.

### 3. EURCV / USDCV — SocGen-Forge ($108M / $26M) — `eurcv-societe-generale-forge`, `usdcv-societe-generale-forge`

- Both EVM contracts share the same impl logic (`0xf4ccc80c4b831a0d8d1414f2aca82a3d760ff05b`).
- Events:
  - `AddressesFrozen(address[])` — topic `0x07381cac78ed3e2aa4d96e0d2c80e39d1c2fff09d8f6f079fa7249b553f45425`
  - `AddressesUnFrozen(address[])` — topic `0xb474664863a35c00b84f99fe9155ea67676b17495d6f9d6b0277787801f77a45`
  - Also has `freeze(address)`, `unfreeze(address)`, `wipeFrozenAddress(address)` — but `wipeFrozenAddress` has no matching event.
- **New family** `SOCGEN_FREEZE_FAMILY`: identical shape to existing `DENY_LIST_EVENT_FAMILY` (array-style batch). Use `addressArrayData: true`.
- EURCV start block 21,412,895 (tx 0x4da0da…8c8a). USDCV start block equivalent — verify at integration.

### 4. JPYC — JPYC ($72M) — `jpyc-jpyc`

- Ethereum `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`, impl `0xafac17fc3936a29ca2d2787ced3c5d1c52007d2e`, start block 22,622,960.
- Events:
  - `Blocklisted(address indexed)` — topic `0x917c251bb231c4b997a420bebe47edad5c20e70715da16c38e9b2e172e44ab92`
  - `UnBlocklisted(address indexed)` — topic `0xbc3fe0fc667d12a7a22748747f024a7d971127ffc48f6622675d3e97a2591a51`
- **New family** `CENTRE_BLOCKLISTED_FAMILY`: a Centre-token fork using the spelling "Blocklisted" instead of "Blacklisted". Different topic hashes from USDC.
- Same address on Polygon (start 72,306,327) and Avalanche (start — lookup needed).

### 5. XAUm — Matrixdock ($500M+) — (needs `xaum-matrixdock` entry — already tracked in shared/data/stablecoins/commodity.json)

- Ethereum `0x2103e845c5e135493bb6c2a4f0b8651956ea8682`, impl `0x3194e478b6d3ebee969470295f271727b62adf7b`, first transaction block 20,624,233.
- Events: `BlockPlaced(address indexed)` / `BlockReleased(address indexed)` only; **no Destroy event**.
- **Reuse** `USDT0_EVENT_FAMILY` but drop the Destroy event (or accept that `DestroyedBlockedFunds` topic will simply never fire on this contract — harmless).
- Also on BSC at `0x23ae4fd8e7844cdbc97775496ebd0e8248656028` — verify impl equivalence.

### 6. USAT — Tether US ($150M) — `usat-tether`

- Ethereum `0x07041776f5007aca2a54844f50503a18a72a8b68`, impl `0x8b98bcd9b1f8ae112fb2b58b45c3bc9a75cc4d0e`, start block 23,998,151.
- Events: `BlockPlaced`/`BlockReleased`/`DestroyedBlockedFunds` — all indexed address, matching `USDT0_EVENT_FAMILY` exactly.
- **Reuse** `USDT0_EVENT_FAMILY`. LOW complexity.
- NB: `usat-tether` impl is shared with `eurr-stablr` — same PaxosTokenV2-style TetherToken fork. EURR/EURQ follow the same pattern.

### 7. EURR / EURQ — StablR / Quantoz

- EURR `0x50753cfaf86c094925bf976f218d043f8791e408` (start 21,421,047), EURQ `0x8df723295214ea6f21026eeeb4382d475f146f9f`.
- Both share impl with USAT (Quantoz reference contract). Reuse `USDT0_EVENT_FAMILY`.

### 8. FIDD — Fidelity Digital Dollar ($50.8M) — `fidd-fidelity`

- Ethereum `0x7c135549504245b5eae64fc0e99fa5ebabb8e35d`, impl `0x8ae9cb3d9095da33555494110f567e3d974c6753`, start block 16,991,820.
- Events:
  - `TransferRestrictionImposed(address indexed)` — topic `0x31180c9d9d89196003f30f7b6643004f76e5feb146dbf10ae71764a88cfed5ef`
  - `TransferRestrictionRemoved(address indexed)` — topic `0x1c425db0931b7efc6b31b2491db198b75f20cfd6885f51c35f5f2a5495ef4619`
- **New family** `FIDELITY_RESTRICTION_FAMILY`. LOW complexity.

### 9. Centre FiatToken forks → `USDC_EVENT_FAMILY`

The following all use the USDC FiatToken contract (`Blacklisted(address indexed)` / `UnBlacklisted(address indexed)`, same topic hashes as USDC). LOW complexity across the board — just add config entries referencing the existing family.

- **XSGD** (`xsgd-straitsx`): Ethereum start 9,739,765. Polygon 26,533,670. Arbitrum 242,214,396. Also deployed on Avalanche + Base.
- **CADC** (`cadc-cad-coin`): Ethereum start 11,655,795. Polygon/Arbitrum/Base also exist.
- **MXNB** (`mxnb-juno`): Ethereum 19,092,028; Polygon 78,027,103; Arbitrum 271,756,855; Avalanche (lookup).
- **XUSD** (StraitsX, `xusd-straitsx`): Ethereum 19,132,912. BSC deployment separate.
- **AxCNH** (`axcnh-anchorx`): Ethereum 23,376,261. Conflux is non-EVM in our CHAIN_META (`type: "other"`) — Ethereum only for first wave.

### 10. USDT-legacy pattern (non-indexed AddedBlackList/RemovedBlackList/DestroyedBlackFunds) → `USDT_EVENT_FAMILY`

- **USDA (Avalon Finance, `usda-avalon`)**: Ethereum `0x8a60e489004ca22d775c5f2c657598278d17d9c2`, start 21,108,194. Non-indexed `AddedBlackList(address)`/`RemovedBlackList(address)` — but **no Destroy event** (no `DestroyedBlackFunds`). Reuse `USDT_EVENT_FAMILY` — harmless that Destroy never fires.
- **IDRX** (`idrx-idrx`): Polygon `0x649a2da7b28e0d54c13d5eff95d3a660652742cc`, start 43,038,233. Full USDT-legacy pattern including Destroy. Base + BSC deployments separate. Direct reuse of `USDT_EVENT_FAMILY`.
- **YUSD** (Aegis, `yusd-aegis`): Ethereum `0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a`, start 21,687,269. `AddedBlackList`/`RemovedBlackList` (non-indexed) only, no Destroy. Reuse `USDT_EVENT_FAMILY`.

### 11. Indexed Blacklisted/Unblacklisted (non-Centre) — IDRT pattern

- **IDRT (`idrt-rupiah-token`)**: Ethereum `0x998ffe1e43facffb941dc337dd0468d52ba5b48a`, impl `0xc61fddd0adc21f99b6a05d830e2ca996c25ee089`, start 7,542,084.
- Events: `Blacklisted(address indexed)` / `Unblacklisted(address indexed)` (note lowercase "n" in "Unblacklisted" vs USDC's "UnBlacklisted"). Different topic hash from USDC.
- **New family** `RUPIAH_BLACKLIST_FAMILY`.

### 12. AEUR / USD1-style dual-indexed Freeze

- **AEUR** (`aeur-anchored-coins`): Ethereum `0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21`, impl `0x7b709447e7812cbb0faec635759144db88e0a58f`, start 17,731,536. Uses `Freeze(address indexed,address indexed)` / `Unfreeze(address indexed,address indexed)` — topic hashes match `USD1_EVENT_FAMILY`. Reuse directly (LOW). Affected address is `topics[2]`.
- BSC deployment at same address — verify impl.

### 13. PAXG-family AddressFrozen/AddressUnfrozen → `PAXG_EVENT_FAMILY`

- **VEUR** (`veur-vnx`): Ethereum `0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3`, impl `0xd1d7193ce1aa7808d577058f48ef8289fc2f81fc`, start 15,998,094.
- **VCHF** (`vchf-vnx`): Ethereum `0x79d4f0232a66c4c91b89c76362016a1707cfbf4f`, start 16,097,303. Avalanche deployment at `0x228a48df6819ccc2eca01e2192ebafffdad56c19`.
- **VGBP** (`vgbp-vnx`): Base `0xaeb4bb7debd1e5e82266f7c3b5cff56b3a7bf411`.
- All three use `AddressFrozen(address indexed)` / `AddressUnfrozen(address indexed)` — **identical topic hashes to PAXG**. Reuse `PAXG_EVENT_FAMILY`; no `FrozenAddressWiped` event on these (skip it or let it never fire).

### 14. FRXUSD — Frax USD ($136M) — `frxusd-frax`

- Ethereum `0xcacd6fd266af91b8aed52accc382b4e165586e29`, impl `0x0000000048d2c8baf31742f6765383278bada4d5`, start 21,543,360.
- Events:
  - `AccountFrozen(address)` — non-indexed — topic `0x4f2a367e694e71282f29ab5eaa04c4c0be45ac5bf2ca74fb67068b98bdc2887d`
  - `AccountThawed(address)` — non-indexed — topic `0x74bb8c2778db9c683c274e7bfdcb56dba4f1c737411c8182363097eec281eea4`
- Note: `AccountFrozen(address)` topic hash is **identical to AUSD/ACCOUNT_FREEZE_EVENT_FAMILY** (`AccountFrozen(address indexed)` vs `AccountFrozen(address)` — event signatures don't include indexed, so the topic is the same). However **AUSD indexes the address, FRXUSD does not** — so the existing family won't decode FRXUSD correctly if used verbatim (AUSD expects address in `topics[1]`, FRXUSD has it in data).
- **New family** `FRAX_FREEZE_FAMILY`: same topic for `AccountFrozen`, but `addressTopicIndex` omitted and `addressDataIndex: 0`; for `AccountThawed` use its distinct topic.
- Alternative: extend `ACCOUNT_FREEZE_EVENT_FAMILY` with a `addressTopicIndex`/`addressDataIndex` flag per-event. Cleaner to keep families atomic and add a new one.
- FRXUSD is widely deployed via LayerZero to ~20 chains (all at `0x80eede496655fb9047dd39d9f418d5483ed600df` except Ethereum and a few others); those remote deployments may or may not share the freeze implementation — spot-check before adding.

### 15. NUSD — Neutrl ($172M) — `nusd-neutrl`

- Ethereum `0xe556aba6fe6036275ec1f87eda296be72c811bce` (not a proxy), start 23,495,846.
- Events: `AddedToDenylist(address indexed)` / `RemovedFromDenylist(address indexed)`.
- **New family** `NEUTRL_DENYLIST_FAMILY`:
  - `AddedToDenylist(address)` — topic `0x8d6233ac6005c4f3eaa99b3aebdbe7ad15476dd961858142c4080952392f979d`
  - `RemovedFromDenylist(address)` — topic `0x29e32a16a9d465ee92796d9fc7e93d2a9ab78cdc803298df7ed84b52d19cd42f`
- Burn functions exist but no confiscation event.

### 16. apxUSD — Apyx ($160M) — `apxusd-apyx`

- Ethereum `0x98a878b1cd98131b271883b390f68d2c90674665`, impl `0xdd71fd677fde2ed2579a3c45204f41a11016ccb4`, start 24,481,772.
- Event: `DenyListUpdated(address indexed caller,address indexed account)` — topic `0x3bef1e143087d517781ffa170d222e23d9e7512704132830f1c9a86fa0fd022f`. Single event covers add+remove; observing the event alone does NOT tell you the direction. Need to call the `denyList(address)` getter post-event (or subscribe both pre/post logs) to determine if the address was added or removed.
- **New family** `APYX_DENYLIST_FAMILY` (single event; downstream classifier must resolve direction via state). Treat as `eventType: "blacklist"` by default with note that direction requires a follow-up RPC read. MEDIUM complexity if direction matters; LOW if we aggregate as "list change".

### 17. GYEN — GYEN ($4.7M) — `gyen-gyen`

- Ethereum `0xc08512927d12348f6620a698105e1baac6ecd911`, impl `0x9195fef5a5dde903e641bafcf56ea4382f8eeac1`, start 9,087,222. Arbitrum at `0x589d35656641d6ab57a545f08cf473ecd9b6d5f7`.
- Events:
  - `Wipe(address indexed,uint256)` — topic `0x2d2c7da251295f4d722a8ddaf337627952c957ce21b2757c852e47fe81b3a2af` (amount in data).
  - `Pause(bool,address indexed)` — pause state toggle (not per-user).
- **No blacklist event** — only the destroy/wipe is observable.
- **New family** `GYEN_WIPE_FAMILY` with a single `destroy` event. Lower marketcap value; include only if the destroy-only signal is useful.

## Map-by-family summary (for implementation planning)

**Reuse existing families (9 additions, LOW effort):**
- `USDC_EVENT_FAMILY`: XSGD, CADC, MXNB, XUSD (StraitsX), AxCNH
- `USDT_EVENT_FAMILY`: USDA (Avalon, no-Destroy), IDRX (full), YUSD (Aegis, no-Destroy)
- `USDT0_EVENT_FAMILY`: USAT, EURR, EURQ, XAUm (no-Destroy)
- `USD1_EVENT_FAMILY`: AEUR
- `PAXG_EVENT_FAMILY`: VEUR, VCHF, VGBP (no-Wiped)
- `DENY_LIST_EVENT_FAMILY`: EURCV, USDCV (same array shape — verify topic hashes differ; if identical, reuse directly; if different, create new family but mirror the shape)

**New families required (6 families, MEDIUM effort):**
- `TRUEUSD_EVENT_FAMILY` (TUSD — bool discriminator)
- `CENTRE_BLOCKLISTED_FAMILY` (JPYC)
- `FIDELITY_RESTRICTION_FAMILY` (FIDD)
- `RUPIAH_BLACKLIST_FAMILY` (IDRT)
- `FRAX_FREEZE_FAMILY` (FRXUSD)
- `APYX_DENYLIST_FAMILY` (apxUSD — direction resolution required)
- `NEUTRL_DENYLIST_FAMILY` (NUSD)
- `SOCGEN_FREEZE_FAMILY` (EURCV, USDCV — if topic hashes differ from `DENY_LIST_EVENT_FAMILY`; they do — `AddedToDenyList` hash vs `AddressesFrozen` hash)
- `GYEN_WIPE_FAMILY` (GYEN)

**Deferred / not observable via logs (skip):**
- USDY (external blocklist contract) — HIGH complexity, separate follow-up
- EURE Monerium (no events)
- SBC Brale (`deny()` fn only)
- WUSD Worldwide (pause-only)
- AUDD Novatti (pause-only)
- AvUSD Avant (burnFrom only)
- USDz Anzen (pause-only)
- USDD Tron DAO (`deny()` fn only)
- cUSD Celo (pause-only)
- mTBILL, OUSG, USTB (role-based via RoleGranted with BLACKLISTED_ROLE — observable but requires separate role-hash filtering infrastructure; deferred)
- EURAU / CHFAU AllUnity (role-based)

## Deployment blocks reference (for startBlock in config)

Only listing starts where Etherscan v2 `getcontractcreation` returned a block; "verify" means fall back to `txlist` or manual lookup.

```
USDY  ETH    17,672,244
USDD  ETH    verify (not yet integrated)
TUSD  ETH     6,988,184
TUSD  POLY   14,389,937
TUSD  ARB     2,132,061
FRXUSD ETH   21,543,360
JPYC  ETH    22,622,960
JPYC  POLY   72,306,327
CADC  ETH    11,655,795
EURQ  ETH    verify
EURR  ETH    21,421,047
XAUm  ETH    20,624,233 (first tx)
MXNB  ETH    19,092,028
MXNB  POLY   78,027,103
MXNB  ARB   271,756,855
AxCNH ETH    23,376,261
IDRT  ETH     7,542,084
IDRX  POLY   43,038,233
AEUR  ETH    17,731,536
GYEN  ETH     9,087,222
GYEN  ARB    25,402,455
XSGD  ETH     9,739,765
XSGD  POLY   26,533,670
XSGD  ARB   242,214,396
XUSD  ETH    19,132,912
TRYB  ETH     8,181,075
TRYB  POLY   17,058,918
EURE  ETH    21,412,895
EURE  GNO    35,656,508
EURE  LIN    16,065,956
EURE  ARB   252,756,971
EURE  POLY   60,730,647
apxUSD ETH   24,481,772
FIDD  ETH    16,991,820
NUSD  ETH    23,495,846
YUSD  ETH    21,687,269
EURAU ETH    22,839,399
CHFAU ETH    24,319,783
MTBILL ETH   18,691,255
VCHF  ETH    16,097,303
VEUR  ETH    15,998,094
ZARP  ETH    16,946,508
AUDD  ETH    18,083,094
SBC   ETH    15,328,805
USAT  ETH    23,998,151
USDA  ETH    21,108,194
```

## Recommended implementation order

Phase A (batched "easy" wins — all reuse existing families, single-chain Ethereum):
1. USAT, EURR, EURQ → `USDT0_EVENT_FAMILY`
2. XSGD, CADC, MXNB, XUSD, AxCNH (Ethereum only first) → `USDC_EVENT_FAMILY`
3. USDA, YUSD, IDRT → `USDT_EVENT_FAMILY` / `RUPIAH_BLACKLIST_FAMILY`
4. AEUR → `USD1_EVENT_FAMILY`
5. VEUR, VCHF → `PAXG_EVENT_FAMILY`

Phase B (new families, still single-chain):
1. TUSD → `TRUEUSD_EVENT_FAMILY`
2. JPYC → `CENTRE_BLOCKLISTED_FAMILY`
3. FIDD → `FIDELITY_RESTRICTION_FAMILY`
4. FRXUSD → `FRAX_FREEZE_FAMILY`
5. NUSD → `NEUTRL_DENYLIST_FAMILY`
6. apxUSD → `APYX_DENYLIST_FAMILY`
7. EURCV, USDCV → `SOCGEN_FREEZE_FAMILY`
8. GYEN (destroy-only) → `GYEN_WIPE_FAMILY`
9. XAUm → `USDT0_EVENT_FAMILY` (with Destroy disabled)

Phase C (multi-chain fan-out for coins already added in A/B):
- MXNB, JPYC, XSGD, XUSD, IDRX, IDRT, TRYB, TUSD, VCHF, VGBP: add per-chain contract entries after Ethereum is proven.

Phase D (deferred):
- USDY Ondo (requires external-blocklist-contract discovery pattern)
- Role-based family for AllUnity EURAU/CHFAU, Midas mTBILL, OUSG Ondo, USTB Superstate (needs `RoleGranted`/`RoleRevoked` filtering with known role-hash constants).

## Appendix A — Keccak topic hashes computed during audit

```
BlocklistSet(address,address)                        0x7e053cdc9069fe4f629b6b3fa2a01bb53a9a8305ec11830b259d95e9e75b7304
SanctionsListSet(address,address)                    0xa19fd4029e820c57308467576d8d0296f07717cfcb98941cf8988b25dcd700e3
Blacklisted(address,bool)                            0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8
DestroyedBlackFunds(address,uint256)                 0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6
Blocklisted(address)                                 0x917c251bb231c4b997a420bebe47edad5c20e70715da16c38e9b2e172e44ab92
UnBlocklisted(address)                               0xbc3fe0fc667d12a7a22748747f024a7d971127ffc48f6622675d3e97a2591a51
Unblacklisted(address)                               0x7534c63860313c46c473e4e98328f37017e9674e2162faf1a3ad7a96236c3b7b
TransferRestrictionImposed(address)                  0x31180c9d9d89196003f30f7b6643004f76e5feb146dbf10ae71764a88cfed5ef
TransferRestrictionRemoved(address)                  0x1c425db0931b7efc6b31b2491db198b75f20cfd6885f51c35f5f2a5495ef4619
AccountFrozen(address)                               0x4f2a367e694e71282f29ab5eaa04c4c0be45ac5bf2ca74fb67068b98bdc2887d
AccountThawed(address)                               0x74bb8c2778db9c683c274e7bfdcb56dba4f1c737411c8182363097eec281eea4
AddressesFrozen(address[])                           0x07381cac78ed3e2aa4d96e0d2c80e39d1c2fff09d8f6f079fa7249b553f45425
AddressesUnFrozen(address[])                         0xb474664863a35c00b84f99fe9155ea67676b17495d6f9d6b0277787801f77a45
AddressFrozen(address)                               0x90811a8edd3b3c17eeaefffc17f639cc69145d41a359c9843994dc2538203690
AddressUnfrozen(address)                             0xc3776b472ebf54114339eec9e4dc924e7ce307a97f5c1ee72b6d474e6e5e8b7c
DenyListUpdated(address,address)                     0x3bef1e143087d517781ffa170d222e23d9e7512704132830f1c9a86fa0fd022f
AddedToDenylist(address)                             0x8d6233ac6005c4f3eaa99b3aebdbe7ad15476dd961858142c4080952392f979d
RemovedFromDenylist(address)                         0x29e32a16a9d465ee92796d9fc7e93d2a9ab78cdc803298df7ed84b52d19cd42f
Wipe(address,uint256)                                0x2d2c7da251295f4d722a8ddaf337627952c957ce21b2757c852e47fe81b3a2af
BLACKLISTED_ROLE (role constant)                     0x548c7f0307ab2a7ea894e5c7e8c5353cc750bb9385ee2e945f189a9a83daa8ed
BLACKLIST_ROLE (role constant)                       0x22435ed027edf5f902dc0093fbc24cdb50c05b5fd5f311b78c67c1cbaff60e13
BLACKLIST_OPERATOR_ROLE (role constant)              0x2fdc6683bc8d03effec5b41d3834f28bd219e06ca0a6a26fc737e44b1c7889ff
DENYLIST_MANAGER_ROLE (role constant)                0xd15a633a037a8cb1e45b365d4ebd232aae2a8d891c9de0523b8e2fe68362d066
```

## Appendix B — Data-source notes

- Market caps: DefiLlama `https://stablecoins.llama.fi/stablecoins?includePrices=true` (snapshot 2026-04-17). `circulating * price` used for USD mcap; non-USD pegs (EUR/GBP/CHF) already return per-peg price from DefiLlama and were handled accordingly.
- Contract addresses: `shared/data/stablecoins/*.json` (`contracts[]` array per coin).
- ABIs: Etherscan v2 `getabi` / `getsourcecode`, retrying via public-RPC `eth_getStorageAt` on the EIP-1967 implementation slot for L2s where Etherscan v2 proxy introspection is rate-limited.
- Deployment blocks: Etherscan v2 `getcontractcreation`. Where the API returned an empty result (common on BSC, OP, AVAX deployments via non-standard creator), a single-tx `txlist` fallback was attempted; if that also returned nothing, the integration task should re-run the lookup.
- Proxy resolution: EIP-1967 impl slot `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` + Etherscan `getsourcecode.Implementation` field for non-EIP-1967 cases (Centre FiatTokenProxy, OwnedUpgradeabilityProxy).
