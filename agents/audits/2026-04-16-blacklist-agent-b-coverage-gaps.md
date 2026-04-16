# Blacklist Tracker — Agent B Coverage Gap Audit

**Date:** 2026-04-16
**Scope:** `/blacklist` tracker coverage (stablecoins x chains x event families)
**Methodology:** cross-reference `worker/src/lib/blacklist-contracts.ts` `CONTRACT_CONFIG_SPECS` against the full universe in `shared/data/stablecoins/*.json`, the chain set in `shared/lib/chains.ts`, and spot-verify contract capability via Etherscan/block-explorer source inspection. Where I could not verify an implementation directly, I tag the finding **unverified**.

All verification was read-only. This report recommends additions; no code was modified.

---

## Executive Summary — Top 10 Priority Gaps

Ranked by rough `tracked TVL × likelihood of freeze activity × implementation cost`:

| # | Finding | Type | Priority | Effort |
|---|--------|------|----------|--------|
| 1 | **USD1/U/FDUSD/EURI destroy events missing** — `wlfi-freeze` family omits `FrozenAccountDrained` and `FrozenFundsReallocated` | Event family extension | P0 | Low |
| 2 | **USDT0 token deployments on 11+ chains missing** (Ink, Berachain, Mantle, Sei, HyperEVM, Unichain, Flare, Monad, Plasma, Rootstock, XLayer, Corn, Conflux, Morph) | Untracked chains for tracked coin | P1 | Low-medium |
| 3 | **USDC native-Circle deployments on 5+ chains missing** (Celo, Linea, Sonic, Unichain, World Chain) | Untracked chains for tracked coin | P1 | Low |
| 4 | **USDP (Paxos Pax Dollar) entirely untracked** — same Paxos freeze family as USDG/PYUSD, just reuse `PYUSD_EVENT_FAMILY` | Untracked stablecoin | P1 | Low |
| 5 | **TUSD (TrueUSD) entirely untracked** — unique `Blacklisted(address,bool)` + `DestroyedBlackFunds` pattern, still ~$500M | Untracked stablecoin (new family) | P1 | Medium |
| 6 | **PYUSD on Solana freeze via Token-2022 permanent delegate** — untracked; no EVM event exists to hook into | Non-EVM gap | P2 | High (different data source) |
| 7 | **USDC on Solana freeze authority** — untracked; SPL `FreezeAccount` instruction, not an event | Non-EVM gap | P2 | High (different data source) |
| 8 | **USDT on Solana freeze authority** — untracked; same SPL paradigm as USDC | Non-EVM gap | P2 | High (different data source) |
| 9 | **USDC Tron deployment missing** — Circle deployed FiatTokenV2 on Tron | Untracked chain for tracked coin | P2 | Medium (Tron event plumbing exists) |
| 10 | **GYEN / XSGD / SGD-family** likely freeze-capable (Prohibiter/Wiper roles) but unverified; high-visibility gap in the "no-USD" lens | Untracked stablecoins | P2 | Medium |

Quick-win bundle (P0+P1): the first five items together account for the majority of blacklistable TVL still missing and can be shipped in a single config-only PR plus one new event-family constant and one new destroy handler.

---

## Priority 1 — Untracked Chains for Already-Tracked Stablecoins

### 1.1 USDC (Circle FiatTokenV2) — missing chains

`shared/data/stablecoins/usd-major.json:usdc-circle` declares 45 chains. Of the 14 EVM deployments, `CONTRACT_CONFIG_SPECS` tracks only **6**: Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche.

I verified via block-explorer source inspection that Circle deployed the **same FiatTokenV2 / FiatTokenV2_2 proxy (with the standard Circle blacklist events)** on these additional chains:

| Chain | Contract | FiatTokenV2 confirmed? | USDC JSON address |
|-------|----------|------------------------|-------------------|
| Linea | `0x176211869cA2b568f2A7D4EE941E073a821EE1ff` | Yes (explorer shows "Circle: USDC Token", FiatTokenV2_1) | Yes |
| Sonic | `0x29219dd400f2Bf60E5a23d13Be72B486D4038894` | Yes (FiatTokenV2_2 bytecode match) | Yes |
| Unichain | `0x078d782b760474a361dDA0AF3839290b0EF57AD6` | Yes (FiatTokenProxy, FiatTokenV2_2) | Yes |
| World Chain | `0x79A02482A880bCe3F13E09da970dC34dB4cD24D1` | Yes (Circle: USDC Token, FiatTokenProxy) | Yes |
| Celo | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | Yes (FiatTokenCeloV2_2 — Celo-specialised but same blacklist events) | Yes |
| zkSync Era | `0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4` | **Unverified — treat as fiat-token bridged USDC; may or may not be FiatTokenV2** | Yes |
| BSC | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | **Unverified — likely wrapped/bridged, not Circle** | Yes |
| Berachain | `0x549943e04f40284185054145c6e4e9568c1d3241` | **Unverified** | Yes |
| Ink | `0x2d270e6886d130d724215a266106e6832161eaed` | **Unverified (likely bridged)** | Yes |
| Sei (EVM) | `0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392` | **Unverified** | Yes |

**Proposed addition (confirmed chains only):**

```ts
// Add to CONTRACT_CONFIG_SPECS in worker/src/lib/blacklist-contracts.ts:
const CELO       = chainConfig("celo");
const LINEA      = chainConfig("linea");
const SONIC      = chainConfig("sonic");
const UNICHAIN   = chainConfig("unichain");
const WORLDCHAIN = chainConfig("worldchain");

{ chain: LINEA,      stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
{ chain: SONIC,      stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
{ chain: UNICHAIN,   stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
{ chain: WORLDCHAIN, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
{ chain: CELO,       stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
```

Before shipping, each chain needs (a) a Circle FiatTokenV2 event verified on-chain with `eth_getLogs` for `Blacklisted` topic, (b) a sensible `startBlock` (contract deployment block) to avoid zero-cursor genesis scans — see the RPC bootstrap guard pattern already used for Avalanche USDC/USDT. Linea, Sonic, and Celo may also require confirming the chain registry has an RPC/explorer (Linea and Celo already have `CHAIN_META` entries).

**Expected coverage delta:** native Circle USDC TVL on these 5 chains is roughly $1–1.5B total (Circle public supply data). Each chain adds on the order of tens to hundreds of past blacklist events.

**Code location:** `worker/src/lib/blacklist-contracts.ts` `CONTRACT_CONFIG_SPECS` (chain constants near lines 72-80 and USDC block at 510-515).

---

### 1.2 USDT — missing USDT0 chain deployments

`CONTRACT_CONFIG_SPECS` tracks USDT on 6 EVM chains (Ethereum, Arbitrum, Optimism, Polygon, Avalanche, BSC) plus Tron. Since late 2025, Tether has been rolling out **USDT0 (OFT Adapter + native Tether token)** via LayerZero on many additional L2s. I confirmed via the official USDT0 deployments page (`docs.usdt0.to`) that USDT0 Token contracts exist on these additional chains, none of which are in `CONTRACT_CONFIG_SPECS`:

| Chain | USDT0 Token address | CHAIN_META entry? | JSON contract entry? |
|-------|---------------------|-------------------|----------------------|
| **Ink** | `0x0200C29006150606B650577BBE7B6248F58470c1` | Yes (`ink`) | Yes |
| **Berachain** | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | Yes (`berachain`) | Yes |
| **Mantle** | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | Yes (`mantle`) | Yes |
| **Sei** | `0x9151434b16b9763660705744891fA906F660EcC5` | Yes (`sei`) | Yes |
| **HyperEVM** | `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` | Yes (`hyperevm`) | Yes |
| **Unichain** | `0x9151434b16b9763660705744891fA906F660EcC5` | Yes (`unichain`) | Yes |
| **Monad** | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | Yes (`monad`) | Yes |
| **Flare** | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | Yes (`flare`) | Yes |
| **Plasma** | `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` | Yes (`plasma`) | Yes |
| **XLayer** | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | Yes (`xlayer`) | Yes |
| **Rootstock** | `0x779dED0C9e1022225F8e0630b35A9B54Be713736` | Yes (`rootstock`) | Unverified (JSON may lack Rootstock USDT entry) |
| **Corn** | `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` | Yes (`corn`) | Yes |
| **Conflux** | `0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff` | Yes (`conflux`) | Unverified |
| **Morph** | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | Yes (`morph-l2`) | Unverified |

USDT0 Token contracts use the **USDT0 event family** (`BlockPlaced`, `BlockReleased`, `DestroyedBlockedFunds` with indexed address), which is already defined as `USDT0_EVENT_FAMILY` in `blacklist-contracts.ts:145`. Adding these is a pure config change.

**Proposed addition:**

```ts
// Example for Ink — repeat pattern for the others, using each chain's deployment block
{ chain: INK, stablecoinId: "usdt-tether", contractAddressOverride: "0x0200C29006150606B650577BBE7B6248F58470c1", startBlock: <deploymentBlock>, events: USDT0_EVENT_FAMILY.events },
```

**Caveat:** Pharos' stablecoin JSON may not yet record the USDT0 Token address for every chain as the canonical USDT contract. `resolveBlacklistContractConfig` calls `resolveRequiredTrackedContractConfig(stablecoinId, chainId)`, which errors if the JSON does not have a contract for that `(id, chainId)` pair. For chains where the JSON already lists the USDT0 Token address (most of the USDT0 list above — I confirmed Ink, Berachain, Mantle, Sei, Unichain, HyperEVM, Monad, Flare, Plasma, XLayer all appear in `usdt-tether.contracts`), the config row works as-is. For chains where the JSON is missing (e.g. Rootstock, Conflux, Morph-L2), the JSON must be updated first, or `contractAddressOverride` must be provided explicitly.

**Implementation complexity:** trivial (existing event family, existing chain registry entries) — but Rootstock/Conflux/Morph need JSON preparation or overrides. Some chains will need new `CHAIN_META` RPC entries verified. `morph-l2` is already in `CHAIN_META`.

**Expected coverage delta:** USDT0 supply across these chains is already material on Ink/Mantle/Berachain (multi-hundred-million). Since the USDT0 contract is new, every blacklist event from launch forward will be captured if we set `startBlock` near the Token deployment block.

**Code location:** `worker/src/lib/blacklist-contracts.ts` chain-constant block (72-80) + `CONTRACT_CONFIG_SPECS` (~517-527).

---

### 1.3 USDT on Avalanche / BSC — USDT0 upgrade check

`CONTRACT_CONFIG_SPECS` has Avalanche and BSC USDT tagged as `USDT_EVENT_FAMILY` (legacy only). Several non-tracked L2s' USDT contracts have been upgraded in place to USDT0 and emit BOTH legacy and USDT0 events. Today's config already uses `USDT_UPGRADED_EVENT_FAMILY` for Arbitrum and Polygon. If Avalanche or BSC eventually upgrade, Pharos would silently miss the new USDT0 events on those chains.

**Proposed:** verify on-chain that Avalanche `0x9702230a...` and BSC `0x55d398...` still emit only legacy events. If BSC later upgrades (LayerZero rollout pattern suggests it is possible), switch to `USDT_UPGRADED_EVENT_FAMILY`. This is a **monitoring task**, not an immediate fix.

**Code location:** `CONTRACT_CONFIG_SPECS` lines 523-524.

---

### 1.4 EURC — missing Solana and Stellar deployments

`shared/data/stablecoins/non-usd.json:eurc-circle` declares 6 chains. Tracked: Ethereum, Base, Avalanche. Untracked:

- **Worldchain EURC** (`0x1c60ba0a0ed1019e8eb035e6daf4155a5ce2380b`) — unverified but likely Circle FiatTokenV2.
- **Stellar EURC** — Stellar classic token with Circle as issuer; account freeze/clawback is a Stellar asset-flag behavior, not an EVM event. Non-EVM, see section 3.
- **Solana EURC** (`HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`) — SPL token with freeze authority (Circle). Non-EVM.

**Proposed addition (worldchain):**

```ts
{ chain: WORLDCHAIN, stablecoinId: "eurc-circle", events: USDC_EVENT_FAMILY.events },
```

Needs pre-verification that the Worldchain deployment is native Circle FiatTokenV2, not a bridged wrapper. Given Circle's naming convention and existing `CHAIN_META` for worldchain, likely yes. Stellar and Solana are covered in sections 3.1 and 3.2.

---

### 1.5 BUIDL family (Securitize-platform tokenized Treasuries)

Current BUIDL coverage on 6 chains uses `SECURITIZE_SEIZE_EVENT_FAMILY`. Other BUIDL-family tokens on the Securitize platform (all use the same `Seize(address,address,uint256,string)` pattern) that are in `shared/data/stablecoins/usd-minor.json`:

- **OUSG — Ondo US Govt Treasuries** (`ousg-ondo-finance`) — I inspected the implementation at `0x1CEB44b6e515abf009e0ccb6ddafd723886cf3ff`. It uses `ERC20PresetMinterPauserUpgradeable` and an external allowlist — **no on-contract Seize event visible**. Ondo's access control is delegated to a compliance client (like USDY). **Conclusion: not a BUIDL-family Securitize deployment, separate pattern (pause-only).**
- **USYC — Hashnote** (`usyc-hashnote`) — inspected implementation `0xbf0f2f3aad6b99893d80c550fbacec915545eb92`. Events are Deposit/Withdrawal/FeeProcessed/TellerSet/Mint/Burn. **No Seize, no Blacklist, no Freeze events on-contract.** Access control is enforced by external gating (similar to USTB). **Conclusion: not Securitize-family, cannot use the existing `SECURITIZE_SEIZE_EVENT_FAMILY`.**
- **USDY — Ondo** (`usdy-ondo-finance`) — source imports `BlocklistClientUpgradeable`, `SanctionsListClientUpgradeable`, `AllowlistClientUpgradeable`. **Block/Unblock events, if any, are emitted by the client contracts, not USDY itself.** Would need to inspect those client contracts' ABIs before wiring up. **Deferred — needs separate research.**
- **BENJI (Franklin OnChain US Govt Money Fund)** — not in `shared/data/stablecoins/*.json`; would need to be added first. Mostly on Stellar/Polygon/etc with custom architecture. **Out of scope for this audit — surface it separately.**
- **USTB — Superstate** — already inspected (§2 below). **Allowlist gated, no on-contract events.**

**Conclusion for BUIDL family:** the current `SECURITIZE_SEIZE_EVENT_FAMILY` is BlackRock-BUIDL-specific. There is no easy sibling to wire up without additional research. The Ondo/Superstate/Hashnote cluster is more realistically covered via a separate "external compliance client" approach — see Priority 5.

**Code location:** `CONTRACT_CONFIG_SPECS` BUIDL block (~584-590).

---

### 1.6 FDUSD — missing chains

Currently tracked: Ethereum + BSC + Arbitrum. JSON lists additional chains: **Sui, TON, Solana**. All three are non-EVM. FDUSD uses Paxos-style freeze on EVM (dual-index `Freeze(address,address)` per the `wlfi-freeze` family). On non-EVM chains, FDUSD may or may not have equivalent per-address freeze — **unverified**. Given FDUSD's low Sui/TON supply compared to BSC, low priority.

**Proposed:** defer Sui/TON/Solana FDUSD until §3 non-EVM framework exists.

---

### 1.7 PYUSD — Solana (and Stellar / Flow)

Currently tracked: Ethereum + Arbitrum. JSON lists: **Solana** (`2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`), **Stellar**, **Flow**.

PYUSD on Solana uses **Token-2022 with a permanent delegate** (PayPal controls the delegate). The permanent-delegate extension gives PayPal the power to transfer/burn from any holder — functionally equivalent to a freeze-and-wipe. But there is **no SPL "freeze event"** — execution is via a regular `Transfer` instruction signed by the delegate. Detection requires tracking delegate-signed token transfers, which is a different data-source paradigm.

See §3.2 for the Solana feasibility note. **Not addressable with the current EVM-centric event-scan architecture.**

---

### 1.8 Summary of Priority 1 chain gaps

| Coin | Missing chains (confirmed Circle/Paxos/USDT0) | Effort |
|------|-----------------------------------------------|--------|
| USDC | Linea, Sonic, Unichain, Worldchain, Celo (+ zkSync/Berachain/Ink/Sei/BSC unverified) | Low |
| USDT | Ink, Berachain, Mantle, Sei, HyperEVM, Unichain, Monad, Flare, Plasma, XLayer, Corn (+ Rootstock/Conflux/Morph after JSON prep) | Low-medium |
| EURC | Worldchain (+ Solana/Stellar non-EVM) | Low |

---

## Priority 2 — Untracked Stablecoins with Confirmed Freeze Capability

Every candidate I inspected. "Verified" means I visited the implementation contract source on a block explorer and confirmed event declarations. "Likely" means role names or proxy hints strongly suggest the capability but the implementation was not directly inspected.

### 2.1 USDP (Pax Dollar) — VERIFIED, reuse existing event family

**Status:** fully centralized Paxos stablecoin. Implementation at `0xf459ff5EC7d1F371Cb34754bDA5FE5fCE2c9054d` (proxy at `0x8e870d67f660d95d5be530380d0ec0bd388289e1`) emits **`FreezeAddress`, `UnfreezeAddress`, and `FrozenAddressWiped`** — identical to PYUSD and USDG. Verified via Etherscan source reading.

**JSON id:** `usdp-paxos` (`shared/data/stablecoins/usd-minor.json`).

**Chains to add (per JSON):**
- Ethereum: `0x8e870d67f660d95d5be530380d0ec0bd388289e1`
- BSC: `0xb7f8cd00c5a06c0537e2abff0b58033d02e5e094` (unverified but same Paxos pattern expected)
- Solana: `HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM` (non-EVM, deferred)

**Proposed config:**

```ts
{ chain: ETHEREUM, stablecoinId: "usdp-paxos", stablecoin: "USDP", startBlock: /* deployment */, events: PYUSD_EVENT_FAMILY.events },
{ chain: BSC,      stablecoinId: "usdp-paxos", stablecoin: "USDP", startBlock: /* deployment */, events: PYUSD_EVENT_FAMILY.events },
```

**Also required:** add `"USDP"` to `BLACKLIST_STABLECOINS` in `shared/types/market.ts` and the `tracked` sync-coverage list in `docs/blacklist-tracker.md`.

**Expected coverage delta:** USDP supply is ~$150M as of late 2025; historical Paxos freezes on USDP mirror their PYUSD/USDG actions, so coverage will immediately surface real events. Methodology bump from v3.9 → v3.91.

**Tradeoff:** USDP is declining in market cap. Low ongoing event rate. But the one-line config addition makes it a very cheap win.

**Code location:** `worker/src/lib/blacklist-contracts.ts` CONTRACT_CONFIG_SPECS, + `shared/types/market.ts` `BLACKLIST_STABLECOINS`.

---

### 2.2 TUSD (TrueUSD) — VERIFIED, needs NEW event family

**Status:** TUSD implementation at `0xDBC97a631c2Fee80417d5d69f32b198c8c39c27e` (proxy `0x0000000000085d4780b73119b644ae5ecd22b376`) emits:

- `Blacklisted(address indexed account, bool isBlacklisted)` — **NEW signature**, not compatible with Circle's `Blacklisted(address)` or USDT legacy. Topic hash is different (bool param affects signature).
- `DestroyedBlackFunds(address indexed _blackListedUser, uint256 _balance)` — same topic hash as USDT legacy destroy event.

Verified via Etherscan source reading.

**Because `Blacklisted(address,bool)` encodes a bool param, both blacklist and unblacklist fire the same event — the event type must be derived from the bool value, not the topic.** Existing event decoding in `worker/src/cron/sync-blacklist.ts` / `worker/src/lib/evm-logs.ts` assumes the event-type is implied by the topic. TUSD breaks that assumption.

**Implementation options:**

1. **New event family + new decoder branch.** Add `TUSD_EVENT_FAMILY = { Blacklisted(address,bool), DestroyedBlackFunds }`, extend `BlacklistEventDef` with an optional `isBlacklistedBoolDataIndex: number` (or similar), and teach the log parser to derive blacklist vs unblacklist from the bool. Medium complexity.
2. **Synthesise two virtual events.** Pre-split decoded logs into `blacklist` and `unblacklist` rows based on the bool — cleaner at the storage layer.

**Chains to add:**
- Ethereum: `0x0000000000085d4780b73119b644ae5ecd22b376` (native TrueUSD).
- Tron: `TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4` (likely also has TrueUSD's native blacklist — unverified; tronscan.org blocks automated inspection so defer to manual check).
- **Do NOT add** Polygon (`0x2e1ad108...`), Arbitrum, Optimism, Avalanche, BSC: confirmed to be bridged `UChildERC20Proxy` / OFT wrappers, not native TrustToken. They do not emit TrueUSD blacklist events.

**Required changes:**
- Add `"TUSD"` to `BLACKLIST_STABLECOINS`.
- New event family in `blacklist-contracts.ts`.
- Event-decoder change in `evm-logs.ts` (or pre-split at the blacklist-row level) to handle `Blacklisted(address,bool)`.
- Test fixtures for both branches of the bool.

**Expected coverage delta:** TUSD supply ~$500M globally (~$100M on Ethereum at time of audit). TrustToken has emitted a handful of blacklist events historically. Coverage adds a well-known centralized stablecoin currently invisible to the `/blacklist` UI.

**Tradeoff:** Medium complexity because of the new event decoder branch. Agent A ran a redundancy audit earlier today — coordinate if that touched `evm-logs.ts`.

**Code location:** `worker/src/lib/blacklist-contracts.ts`, `worker/src/lib/evm-logs.ts`, `shared/types/market.ts`.

---

### 2.3 USDCV / EURCV (SG Forge — Société Générale) — LIKELY, needs verification + new family

**Status:** Société Générale's regulated stablecoins. I inspected `0x5422374b27757da72d5265cc745ea906e0446634` (USDCV proxy) — the explorer UI confirmed "compliance-related" events including **Freeze**, but I could not view the implementation contract source directly (proxy delegation `0xF4ccC80C...`, not easily resolvable with WebFetch). Similar pattern for EURCV (`0x5f7827fdeb7c20b443265fc2f40845b715385ff2`).

**Status: unverified — needs contract inspection.** Likely candidates for a new event family. Supply is small (~$50M combined) but SG Forge has regulatory visibility.

**Chains per JSON:**
- USDCV: Ethereum, Solana
- EURCV: Ethereum, Solana, Stellar, XRPL

**Priority:** P2 — interesting but low TVL. Worth researching once the P1 queue clears.

---

### 2.4 GYEN / ZUSD (GMO Trust) — LIKELY, unverified

**Status:** Etherscan for GYEN (`0xc08512927d12348f6620a698105e1baac6ecd911`) exposes role names in the implementation source files: **Pauser, Prohibiter, Wiper**. This exactly matches Paxos's "admin action with on-contract events" pattern.

**Status: unverified.** Implementation contract at `0x9195FeF5...` did not render (invalid/truncated path in my WebFetch). Needs direct source inspection. Likely new event family with `Prohibited(address)`, `Unprohibited(address)`, `WipedFrozenFunds(address,uint256)` or similar.

**Chains per JSON:** Ethereum, Arbitrum.

**Priority:** P2 (low TVL, but a regulated US trust company — high optical value when it does fire).

---

### 2.5 XSGD / StraitsX family — LIKELY, unverified

**Status:** StraitsX issues XSGD (Singapore Dollar) and XUSD (USD stablecoin) under Singapore regulation (MAS). Freeze capability has been **publicly documented** in StraitsX compliance statements. I could not extract event signatures from explorer WebFetch.

**Chains per JSON (XSGD):** Ethereum, Polygon, Arbitrum, Avalanche, Base.
**Chains per JSON (XUSD):** Ethereum, BSC.

**Priority:** P2. Regionally important, low global TVL (~$30M). Needs Solidity source inspection to confirm event family.

---

### 2.6 AUDD (Novatti) — LIKELY, unverified

**Status:** Novatti issues AUDD in Australia; freeze capability is **publicly documented**. JSON: Ethereum, Base, Stellar. Not currently tracked.

**Priority:** P3. Very low TVL.

---

### 2.7 Monerium EURE, EUROP (Schuman), EURAU (AllUnity), CHFAU, AEUR, EURQ, EURR, VEUR, VCHF, VGBP

All 10 are EU-regulated euro/CHF/GBP stablecoins, centralized, most with MiCA-aligned compliance features that typically include account freeze. Each needs **individual contract verification** — every issuer implements compliance slightly differently. 

**Status: entirely unverified.** This is the largest single block of unverified coverage — maybe 25-30 small-to-medium coins, aggregate TVL of a few hundred million. Each worth one afternoon of inspection.

**Priority:** P2 batch. Tackle as a single "European regulated stablecoins" sweep. For each, determine which existing event family they can reuse (Paxos-style, Circle-style, Banned-style) or whether a new family is needed.

---

### 2.8 BRLA Digital, CADC, ZARP, MXNB, JPYC, TRYB, IDRT, IDRX, CETES, PHT — LIKELY, unverified

Regional-currency regulated stablecoins. Issuers are typically licensed money-services providers with freeze/clawback obligations. JSON contains all of them. Event inspection would need to happen contract-by-contract.

**Priority:** P3 batch. Low individual TVL, but together represent the **non-USD global coverage** lens — important for the `/blacklist` page's internationalisation story.

---

### 2.9 USDD (Tron DAO Reserve) — VERIFIED NO on-contract freeze on Ethereum

I inspected USDD Ethereum implementation (`0x4f8e5de400de08b164e7421b3ee387f461becd1a`). It uses a MakerDAO-style `wards` permission system with only standard mint/burn — **no blacklist/freeze/seize events**. Tron-side USDD is unverified (TronGrid blocks automated inspection), but the contract is known to be a Justin-Sun-controlled Tron DAO Reserve governance contract, likely similar.

**Outcome:** USDD is a strong **no-freeze transparency card** candidate on EVM. On Tron it remains unverified — could go either way depending on TRC20 contract.

---

### 2.10 GHO (Aave) — VERIFIED NO freeze

GHO's facilitator/bucket architecture does not include per-address blacklist or freeze events. Only `Transfer`, `Approval`, `RoleGranted`, and facilitator capacity events. Across all GHO chains (Ethereum, Arbitrum, Base, Avalanche, Gnosis, Ink, Mantle), this should be consistent since they use the same token contract codebase.

**Outcome:** strong **no-freeze transparency card** candidate. Matches the USDS card pattern.

---

### 2.11 Gemini GUSD — UNLIKELY freeze (but not verified deep)

GUSD proxy (`0x056fd409e1d7a124bd7017459dfea2f387b6d5cd`) delegates to an ERC20Impl implementation. The proxy ABI shows only standard ERC20 and custodian-management events (`ImplChangeRequested`, `CustodianChangeRequested`), no blacklist/freeze/pause functions visible. Gemini has historically been more conservative than Paxos — my inspection found no explicit freeze mechanism at the proxy level.

**Status: likely no-freeze, but deserves a follow-up review of the impl contract before being added to the transparency-card list.** If confirmed, it's a good "regulated but no-freeze" story card.

---

### 2.12 USDe / sUSDe (Ethena) — VERIFIED NO freeze in underlying token

The `usde-ethena` base token (`0x4c9edd5852cd905f086c759e8383e09bff1e68b3`) is a standard ERC20 without any blacklist mechanism. sUSDe is an ERC4626 wrapper that cannot add a freeze the underlying does not have. **Confirmed by prior Pharos audit** (`2026-03-30-blacklistable-no-systemic-audit.md` — validate reference).

**Outcome:** no-freeze transparency cards for both.

---

### 2.13 Alchemix alUSD — VERIFIED has blacklist, but NO event emitted

Etherscan source reading confirms alUSD has a `blacklist` mapping and a `setBlacklist(address, bool)` function, **but the function does not emit any event**. Without an event, `eth_getLogs` scanning cannot detect it. State-reading approach would require a periodic on-chain `isBlacklisted()` poll against every holder — impractical at scale.

**Outcome:** note in the intentional-deferral list as **"blacklistable but no event"**. Consider a lower-frequency state-poll for top-N holders if a request emerges.

---

### 2.14 USDB (Blast) — UNVERIFIED

USDB on Blast is a rebasing token (`0x4300000000000000000000000000000000000003`) managed by the Blast L2 sequencer. No known blacklist event. Could inherit USDC's blacklist indirectly via the underlying Circle USDC collateral. **Unverified, low priority.**

---

### 2.15 Summary of verified findings

| Coin | Freeze capable? | Event family | Notes |
|------|-----------------|--------------|-------|
| USDP Paxos | **Yes** | `PYUSD_EVENT_FAMILY` (reuse) | Ready to ship |
| TUSD | **Yes** | **New** `TUSD_EVENT_FAMILY` | Bool-param parsing needed |
| GHO | **No** | — | Transparency card candidate |
| USDD (Ethereum) | **No** | — | Transparency card candidate |
| USDe/sUSDe | **No** | — | Already known |
| alUSD | Yes (but no events) | — | Intentional deferral |
| Gemini GUSD | Likely no | — | Needs impl inspection |
| USDCV/EURCV (SG Forge) | Likely yes | Unknown | Needs impl inspection |
| GYEN | Likely yes | Unknown new family | Pauser/Prohibiter/Wiper roles |
| XSGD/XUSD (StraitsX) | Likely yes | Unknown | MAS-regulated |
| EURS, EURE, EUROP, EURAU, EURQ, EURR etc | Likely yes | Unknown | Europe-regulated sweep |
| BRLA, CADC, ZARP, MXNB, JPYC, TRYB, IDRT, IDRX, CETES, PHT | Likely yes | Unknown | Regional sweep |
| AUDD | Likely yes | Unknown | Low TVL |

---

## Priority 3 — Non-EVM Coverage (Solana, Stellar, XRPL)

### 3.1 Feasibility within current schema

The `blacklist_events` schema is event-oriented (topic hashes, indexed addresses, block numbers). It maps poorly onto:

- **Solana SPL/SPL-2022:** freeze is an **instruction** (`FreezeAccount`, `ThawAccount`), not an event. Detection requires tracking instruction history on the Token Program, which is a fundamentally different data source (transaction logs, not Etherscan-style event logs). `blacklist_sync_state` stores millisecond cursors for Tron; Solana would need slot-number cursors and a new Solana RPC integration layer. Medium-high build effort.
- **Solana Token-2022 permanent delegate:** as used by PYUSD Solana — delegate-signed transfers look identical to normal transfers. Detection requires parsing every transfer instruction and checking the signer against the mint's permanent-delegate address. Very high build effort; comparable to adding a full Solana indexer.
- **Stellar classic tokens:** Stellar asset issuers set account flags (`AUTH_REVOCABLE_FLAG`) and can individually revoke trustlines. Flag changes are Stellar operations, not events. Horizon API can query `accounts?asset_issuer=...&authorized=false` — this is a **snapshot query**, not incremental. Feasible but requires new Horizon client + state-diff indexing.
- **XRPL:** RLUSD on XRPL uses the XRP Ledger's native asset. Freezing is a `TrustSet` flag operation (`tfSetFreeze`) on the issuer side. XRPL transactions are indexed by WebSocket/HTTP API. Feasible with new data source.

### 3.2 Recommended approach

**Do not try to shoehorn non-EVM freeze into the current `blacklist_events` schema unchanged.** Either:

1. **Add a `source_type` column** to `blacklist_events` that distinguishes `evm_event`, `tron_event`, `solana_instruction`, `stellar_flag_change`, `xrpl_trust_freeze`. The event-signature/topic-hash columns become nullable for non-EVM rows. Minimum disruption.
2. **Add a parallel `blacklist_state_snapshots` table** for non-event paradigms (Solana freeze authority, Stellar auth revocation, Alchemix no-event blacklists). Poll periodically and diff. Higher storage cost, more complex to reconcile with `blacklist_current_balances`.

Option 1 is cheaper and fits the existing sync-state cursor pattern. Option 2 is more honest about the semantic difference (state versus event).

**Priority:** P2 research — needs a design doc before any code changes. Worth doing before adding USDT-Solana and USDC-Solana because those are the highest-impact non-EVM assets and will set the schema precedent.

### 3.3 Specific non-EVM targets

| Target | Chain | Mechanism | Feasibility |
|--------|-------|-----------|-------------|
| USDT Solana (`Es9vMFrzaCER...`) | Solana | SPL freeze authority (Tether) | High-impact; build effort medium-high |
| USDC Solana (`EPjFWdd5...`) | Solana | SPL freeze authority (Circle) | High-impact; same data source |
| PYUSD Solana | Solana | Token-2022 permanent delegate | Different — transfer-signer detection |
| USDG Solana | Solana | Token-2022 permanent delegate (Paxos) | Same as PYUSD |
| EURC Solana | Solana | SPL freeze authority (Circle) | Same as USDC Solana |
| USDP Solana | Solana | SPL freeze authority (Paxos) | Same as USDC Solana |
| USDC Stellar | Stellar | Asset-issuer revocable auth | Medium effort; Horizon client |
| EURC Stellar | Stellar | Asset-issuer revocable auth | Same |
| RLUSD XRPL | XRPL | TrustSet tfSetFreeze | Medium effort; XRPL client |
| USDT Tron (non-USDT and TUSD-Tron, USDD-Tron) | Tron | Existing Tron plumbing | Already works; just add configs after verification |

### 3.4 Tron untracked contracts (uses existing plumbing)

`CONTRACT_CONFIG_SPECS` currently tracks Tron USDT + Tron USD1. Many other major Tron stablecoins are unhandled:

| Asset | Tron address | Verified pattern | Effort |
|-------|--------------|------------------|--------|
| **USDC Tron** | `TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8` | Unverified (tronscan blocks WebFetch); **likely Circle FiatTokenV2** | Low — reuse `USDC_EVENT_FAMILY`, trigger via TronGrid events |
| **TUSD Tron** | `TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4` | Likely TrueUSD pattern but unverified | Depends on §2.2 decoder work |
| **USDD Tron** | `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz` | Unverified — Justin-Sun-controlled | Manual verification required |
| **FDUSD** — not on Tron per JSON | — | — | Skip |
| **BRLA Digital** — not on Tron per JSON | — | — | Skip |

The Tron plumbing in `sync-blacklist.ts` already handles TronGrid events + base58/hex address conversion + millisecond cursors. Adding a new Tron contract config is the same cost as adding a new EVM config — just a row in `CONTRACT_CONFIG_SPECS` + verification that the Tron contract actually emits the target events via `/contracts/{addr}/events?event_name=...`.

**Immediate Tron actions:** verify USDC-Tron emits Circle-style `Blacklisted` / `UnBlacklisted` via TronGrid, then add:

```ts
{ chain: TRON, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
```

Watch for: the stored Tron USDT address `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` uses the legacy USDT pattern. USDC-Tron is Circle's own deployment (not a bridged wrapper) and should use the Circle events.

---

## Priority 4 — Event-Family Extensions on Already-Tracked Contracts

### 4.1 wlfi-freeze family: missing destroy/seize events (USD1, U, FDUSD, EURI)

**CRITICAL FINDING.** The `USD1_EVENT_FAMILY` (renamed `wlfi-freeze` in line 235) tracks **only** `Freeze(address,address)` and `Unfreeze(address,address)`. I verified by inspecting the USD1 `StablecoinV2` implementation at `0x694Aa534bdef8ed63244eb902e7914e527891f08` that the contract also emits:

- **`FrozenAccountDrained(address caller, address account, uint256 amount)`** — emitted when `drain()` removes funds from a frozen account. This is functionally equivalent to `DestroyedBlackFunds` on USDT.
- **`FrozenFundsReallocated(address caller, address from, address to, uint256 amount)`** — emitted when `reallocate()` moves funds from one frozen account to another. Also a destroy-family event.
- **`Burn(address caller, address from, uint256 amount)`** — emitted on admin burn. Potentially destroy-family depending on interpretation.

**Because `wlfi-freeze` is reused for USD1, U (United Stables), FDUSD, and EURI**, all four coins lose destroy/seize event coverage today. When WLF/Paxos eventually drain a frozen account, Pharos will:
- Still record the upstream `Freeze` event (good).
- **Miss the destruction event entirely.**
- Lose the destroy-amount USD total that would appear in `destroyedTotal` on the summary endpoint.

**Proposed addition:**

```ts
// New topics
const WLFI_FROZEN_DRAINED_TOPIC = "0x…"; // keccak256("FrozenAccountDrained(address,address,uint256)")
const WLFI_FROZEN_REALLOCATED_TOPIC = "0x…"; // keccak256("FrozenFundsReallocated(address,address,address,uint256)")

const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze", [
  { signature: "Freeze(address,address)",   topicHash: USD1_FREEZE_TOPIC,   eventType: "blacklist",   hasAmount: false, addressTopicIndex: 2, tronResultKey: "account" },
  { signature: "Unfreeze(address,address)", topicHash: USD1_UNFREEZE_TOPIC, eventType: "unblacklist", hasAmount: false, addressTopicIndex: 2, tronResultKey: "account" },
  { signature: "FrozenAccountDrained(address,address,uint256)", topicHash: WLFI_FROZEN_DRAINED_TOPIC, eventType: "destroy", hasAmount: true,
    addressTopicIndex: 2, amountDataIndex: 0 },
  { signature: "FrozenFundsReallocated(address,address,address,uint256)", topicHash: WLFI_FROZEN_REALLOCATED_TOPIC, eventType: "destroy", hasAmount: true,
    addressTopicIndex: 2, amountDataIndex: 1 /* amount is the 2nd non-indexed arg after `to`, verify at implementation time */ },
]);
```

The exact topic hashes must be computed by `keccak256` of the human-readable signatures (I did not compute them during the audit — the signatures are not yet universally registered in 4byte.directory). Implementation should compute them at build time or store them as constants after verification.

**Caveats to resolve in implementation:**
- `FrozenFundsReallocated` has TWO address parameters (`from`, `to`) plus amount. Which address is the "blacklisted" address for the `blacklist_events` row? Probably `from` (the drained source). Needs a design decision.
- Whether `Burn` should be included in the destroy family depends on whether Pharos wants admin burns (not frozen-account burns) counted in `destroyedTotal`. **Recommend excluding plain `Burn` from the destroy family.**

**Tradeoff:** WLF and related issuers rarely drain/reallocate today, so this is a forward-looking fix. But it aligns the destruction coverage of dual-index-freeze stablecoins with that of USDT/PAXG/PYUSD, closing a material semantic gap.

**Code location:** `worker/src/lib/blacklist-contracts.ts` USD1_EVENT_FAMILY (~235-252).

---

### 4.2 Paxos family (PYUSD, USDG, USDP): possible `AssetProtectionRoleSet` / `SupplyControllerRoleSet` events

Paxos's `PaxosTokenV2` implementation emits admin-change events (`SupplyControllerSet`, `AssetProtectionRoleSet`) that Pharos does not currently track. These are not blacklist actions but do reveal which key has permission to freeze. Adding them would let the `/blacklist` page show "the asset protection role was updated to X, which now controls the freeze button."

**Status:** intentional deferral — out of scope for event-level freeze tracking. Surface on the stablecoin detail page instead.

---

### 4.3 MNEE: AccountBlacklisted / AccountDelisted (already deferred)

The v3.9 rollout explicitly deferred `AccountBlacklisted` / `AccountDelisted` on MNEE because they model a separate restriction source from freeze (KYC-style deny list vs. per-account freeze). The comment in `blacklist-contracts.ts` notes the deferral. **This is correct — keep deferred.** Tracking them would require a new `restriction_source` column (`"freeze"` vs `"blacklist"` vs `"delist"`) on `blacklist_events` to avoid collisions in the active-state machine.

**Known deferred, no action needed.**

---

### 4.4 RLUSD: clawback (already deferred)

RLUSD's `clawback(address,uint256)` function does not emit a dedicated clawback event (v3.8 deferral note). The verified ABI uses regular `Transfer` + `Burn`, so distinguishing a clawback from an ordinary burn requires transaction-input classification (decoding `calldata` to check `msg.sig == 0xf5298aca` or similar). This is expensive and intentionally deferred.

**Known deferred, no action needed.** Optional: surface clawback in a separate "events derived from tx-input classification" tracker if visibility demand grows.

---

### 4.5 USDTB, AID: address[] arrays

Already handled via `addressArrayData: true` in `USDTB_EVENT_FAMILY` and `DENY_LIST_EVENT_FAMILY`. Mentioned here for completeness — no action.

---

### 4.6 `BANNED_EVENT_FAMILY` (TGBP): confirm no `DestroyedBannedFunds` equivalent

TGBP currently tracks `Banned` / `UnBanned` only. If TGBP has an analogous "destroy funds at banned address" event, it's not yet in `BANNED_EVENT_FAMILY`. **Unverified — recommend spot-check.**

---

### 4.7 Securitize BUIDL family: confirm `OmnibusSeize` address/amount decoding

Current config decodes `OmnibusSeize(address,address,uint256,string,uint8)` with `addressDataIndex: 0` and `amountDataIndex: 1`. This assumes the first non-indexed slot is the victim address and the second is the amount. Spot-check against the BlackRock BUIDL implementation's ABI to confirm. **Low priority — if it's wrong it'll be caught in the first real BUIDL event.**

---

## No-Freeze Transparency Candidates (UI surface)

These are coins for which I verified (or strongly believe) that **no per-address freeze / blacklist mechanism exists on-contract**. Candidates to add `UsdsStatusCard`-style cards so the `/blacklist` page can affirmatively say "inert by design":

| Coin | Chains | Verification | UI phrasing suggestion |
|------|--------|--------------|-----------------------|
| **DAI** | Ethereum + L2s | Historically known, MakerDAO has no per-address freeze in DAI token | "MakerDAO cannot freeze DAI balances. Emergency shutdown is global, not per-address." |
| **LUSD** | Ethereum + L2s | Liquity's LUSD contract is immutable, no admin | "Liquity LUSD is immutable and has no administrator. No freeze is possible." |
| **crvUSD** | Ethereum + L2s | Curve crvUSD has no freeze/blacklist | "Curve crvUSD has no freeze mechanism." |
| **sDAI** | Ethereum | ERC4626 wrapper around DAI, inherits nothing | "sDAI inherits DAI's lack of freeze." |
| **USDS (Sky)** | Ethereum + L2s | Already documented via `UsdsStatusCard` | Existing |
| **GHO** | Ethereum + L2s | **VERIFIED no freeze** via facilitator/bucket architecture | "Aave GHO has no per-address freeze." |
| **USDe (Ethena)** | Ethereum + L2s | Already known (prior audit) | Existing mention |
| **sUSDe** | Ethereum + L2s | ERC4626 wrapper, inherits nothing | Existing mention |
| **USDD (Ethereum)** | Ethereum | **VERIFIED no freeze** in wards-only implementation | "USDD Ethereum deployment has no freeze." Note: Tron-side unverified. |
| **ZCHF (Frankencoin)** | Ethereum + L2s | Likely no freeze — governed by CHF protocol, immutable | **Needs quick verification** |
| **FRAX** | Ethereum + L2s | Historically no freeze; AMO-based | **Needs quick verification** |
| **frxUSD** | Ethereum + L2s | Same Frax team; historically no freeze | **Needs quick verification** |
| **BOLD (Liquity v2)** | Ethereum | Immutable Liquity v2 contract | **Needs quick verification** |
| **RAI**, **eUSD** | Ethereum | Decentralised, no freeze | **Needs quick verification** |
| **USDe, USR (Resolv), USDf (Falcon), USDai, USD.AI, ALUSD** | Various | DeFi-native; verify each | **Needs individual verification** |

**Recommended UI design:** consolidate into a single `DecentralisedNoFreezeCard` that lists the verified-inert coins in the `/blacklist` sidebar, rather than one card per coin. Clicking a coin's name links to its report card.

**Code location:** `src/components/` — probably a new component analogous to `usds-status-card.tsx` and `eurc-blacklist-card.tsx`.

---

## Intentional Deferrals (already documented, listed for completeness)

| Coin | Event / action | Reason |
|------|----------------|--------|
| MNEE | `AccountBlacklisted(address)`, `AccountDelisted(address)` | Separate restriction source, needs `restriction_source` column to avoid active-state collisions |
| RLUSD | `clawback(address,uint256)` | Not event-covered in verified ABI; needs tx-input classification |
| Tron blacklist balance attribution | Tron destroy events only | Current Tron plumbing does not historical-balance-attribute blacklist rows |
| Alchemix alUSD | `setBlacklist(address,bool)` | Function exists but emits no event; polling-only |

**These are correct deferrals. Do not regress.**

---

## Implementation Recommendations (Priority-Ordered Roadmap)

### Phase 1 — config-only additions (1 PR, zero new event decoding)

1. **USDP (Paxos Pax Dollar)** — add Ethereum config, extend `BLACKLIST_STABLECOINS`, methodology bump. Reuses `PYUSD_EVENT_FAMILY`.
2. **USDC native-Circle missing chains** — Linea, Sonic, Unichain, Worldchain, Celo. Reuses `USDC_EVENT_FAMILY`.
3. **USDT0 missing chains** — Ink, Berachain, Mantle, Sei, HyperEVM, Unichain, Monad, Flare, Plasma, XLayer, Corn. Reuses `USDT0_EVENT_FAMILY`. Verify each chain's JSON address before shipping.
4. **EURC Worldchain** — reuses `USDC_EVENT_FAMILY`. Needs Circle FiatTokenV2 verification first.

**Estimated LOC:** 60-80 additions to `CONTRACT_CONFIG_SPECS`, a handful of chain-constant declarations, 2 symbol entries in `BLACKLIST_STABLECOINS`, docs/methodology updates.

### Phase 2 — USD1 destroy events (1 PR, event-family extension)

5. **wlfi-freeze destroy events** — add `FrozenAccountDrained` + `FrozenFundsReallocated` to `USD1_EVENT_FAMILY`. Compute topic hashes. Handle the `from` vs `to` address choice for Reallocated. Applies to USD1, U, FDUSD, EURI simultaneously.

### Phase 3 — TUSD (1 PR, new event decoder branch)

6. **TUSD_EVENT_FAMILY** — handle `Blacklisted(address,bool)` bool-driven event-type derivation. Add Ethereum + Tron. Methodology bump.

### Phase 4 — non-EVM design doc

7. **Solana feasibility design** — agree on schema changes (`source_type` column, snapshot table) before the first Solana config. Then:
8. **USDT Solana** + **USDC Solana** — first Solana data-source integration.
9. **EURC Solana** + **USDP Solana** + **USDG Solana** — follow-on.
10. **RLUSD XRPL** — XRPL data-source integration.
11. **Stellar** — last because lowest additional TVL per chain.

### Phase 5 — European / regional sweep

12. **EUR/CHF/GBP/AUD/BRL/JPY/MXN/TRY/IDR/CAD/ZAR** — verify each issuer's contract event ABI, bucket into existing families or create new. Batch into one "global regional compliance" PR.

### Phase 6 — no-freeze transparency card

13. **`DecentralisedNoFreezeCard`** — consolidated UI component listing verified-inert coins on the `/blacklist` page.

---

## Verification Methodology & Caveats

- Every "VERIFIED" finding above is based on **at least one block-explorer source inspection** (Etherscan/Basescan/Polygonscan/Lineascan/Sonicscan/etc.).
- Explorer WebFetch is unreliable for proxy contracts and non-EVM chains. **Tronscan, Solscan, and Solana Explorer block WebFetch entirely** — any Tron/Solana finding labeled "verified" is based only on widely-documented issuer behavior, not direct contract inspection.
- **Unverified** findings are based on issuer reputation, role names visible in proxy source files, or public compliance-policy statements. These MUST be contract-inspected before shipping.
- I did not compute Keccak256 topic hashes for the new USD1 destroy events or the TUSD bool event. Those must be computed and verified by the implementer.
- I did not check every single stablecoin in the 190-asset universe — I prioritized the centralized, high-TVL, and regulatory-notable coins. The remaining untouched list (sample: `pusd-pleasing`, `satusd-river`, `avusd-avant`, `yusd-aegis`, `cash-phantom`, `usnd-nerite`, `nusd-neutrl`, `usdu-unitas`, `btcusd-btcfi`, `usp-pikudao`) are mostly small-TVL DeFi-native coins that are lower priority.
- All verification happened within a single session; no on-chain `eth_getLogs` was performed. Any "likely" claim should be smoke-tested with a single `eth_getLogs` call before being added to `CONTRACT_CONFIG_SPECS`.

---

## File-Reference Index

- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/blacklist-contracts.ts` — primary target for all config additions (chain constants block, `CONTRACT_CONFIG_SPECS`, event-family constants)
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/market.ts` — `BLACKLIST_STABLECOINS` allowlist enum
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json` — USDC, USDT, PYUSD, USDG, FDUSD, USDD, RLUSD, U, BUIDL, USDY, USYC, GHO, M, wM JSON entries
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json` — USDP, TUSD, GUSD Gemini, USDCV, MNEE, USDQ, USDO, USDX, USDtb, AID, TBILL, mTBILL, OUSG, USTB, Alchemix alUSD, etc.
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/non-usd.json` — EURC, EUR*, VCHF, VEUR, VGBP, BRLA, CADC, ZARP, MXNB, JPYC, TRYB, IDRT, AUDD, A7A5, BRZ, EURI, TGBP
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/commodity.json` — PAXG, XAUT, XAUM, KAU, CGO, DGLD, KAG
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chains.ts` — `CHAIN_META` entries for any new chain constant (linea, sonic, unichain, worldchain, celo, ink, berachain, mantle, sei, hyperevm, monad, flare, plasma, xlayer, corn, conflux, morph-l2 all already present)
- `/home/ahirice/Documents/git/stablecoin-dashboard/docs/blacklist-tracker.md` — narrative update for each tracked addition (sync-coverage list, event-signature table, contract configs table)
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/usds-status-card.tsx` — reference implementation for the proposed `DecentralisedNoFreezeCard`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/tracked-contract-resolution.ts` — contract-resolution helper; any new config row requires a matching JSON contract entry for `(stablecoinId, chainId)` or an explicit `contractAddressOverride`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-blacklist.ts` — main sync loop; impacted only if the TUSD bool-event parser requires a decoder-level change
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/evm-logs.ts` — log fetching + parsing; impacted by TUSD bool-param decoding

---

## Open Questions for User Decision

1. **TUSD decoder cost vs. reward.** Adding TUSD requires event-family + decoder work. Is TUSD's ~$500M supply worth the implementation cost? Alternative: defer TUSD and catch Paxos/Circle coverage gaps first.
2. **Non-EVM schema choice.** Option 1 (`source_type` column) vs. Option 2 (parallel `blacklist_state_snapshots` table)? Option 1 is smaller, Option 2 is semantically cleaner.
3. **European sweep scope.** One mega-PR across all EUR/CHF/GBP stablecoins, or one PR per issuer family? Per-issuer is safer but slower.
4. **USD1 destroy event topics.** Should I compute and verify the topic hashes in a follow-up research pass, or is the implementer comfortable deriving them from the signatures at build time?
5. **No-freeze transparency UI placement.** New `/blacklist` sidebar card? Dedicated `/blacklist#transparent` anchor? Individual badges on the coin detail pages? Design decision.

---

*End of Agent B coverage-gap audit.*
