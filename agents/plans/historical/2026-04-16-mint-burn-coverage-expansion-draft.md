# Mint-Burn Coverage Expansion Plan

> **Status (2026-04-17):** Superseded by `agents/plans/2026-04-17-mint-burn-comprehensive-remediation.md`.
> Tier 1 (6 Ethereum coins) shipped in commit 29accf66.
> Tier 2 (CCTP for USDC and EURC) shipped in commit 831812bb.
> Multi-chain EVM expansion is now Phase 5 of the comprehensive plan.

Generated: 2026-04-16

## Current State

- **125 of 132** Ethereum-contract stablecoins covered (94.7%)
- **126 contract configs** across Ethereum (125) and Arbitrum (1)
- 5 tokens with CCIP bridge detection, 1 with LayerZero OFT
- 58 tracked stablecoins on non-EVM chains (unreachable with current pipeline)

---

## Tier 1: Close the Ethereum Gap (6 coins, low effort)

Add the remaining 6 standard Ethereum ERC-20 stablecoins to `EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS`. All use standard `transferMintBurn()` with `isDefaultStartBlock: true`.

| stablecoinId | Symbol | Decimals | Peg | Notes |
|---|---|---|---|---|
| `ftusd-flying-tulip` | ftUSD | 6 | USD | yield-bearing, crypto-backed |
| `usdkg-gold-dollar` | USDKG | 6 | USD | rwa-backed |
| `buck-buck-assets` | BUCK | 18 | USD | yield-bearing, rwa-backed |
| `chfau-allunity` | CHFAU | 6 | CHF | rwa-backed (sibling of EURAU, already covered) |
| `mxnb-juno` | MXNB | 6 | MXN | rwa-backed |
| `cjpy-yamato` | CJPY | 18 | JPY | crypto-backed |

**Excluded:** `susdai-usd-ai` (sUSDai) -- NAV wrapper of USDai. Supply changes via staking, not issuance. The underlying USDai is already tracked on Arbitrum.

**Effort:** ~20 min. Add 6 entries to the expansion spec array, update tests.

---

## Tier 2: CCTP Bridge Detection for USDC and EURC (medium effort)

Circle's Cross-Chain Transfer Protocol (CCTP) uses Burn & Mint for cross-chain transfers. When a user bridges USDC or EURC from Ethereum, the `TokenMinterV2` burns the tokens (producing a `Transfer(user, 0x0, amount)` event). Without bridge detection, these burns inflate the effective burn volume.

### CCTP Ethereum V2 Contracts

| Contract | Address |
|---|---|
| TokenMessengerV2 | `0x28b5a0e9c621a5badaa536219b3a228c8168cf5d` |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` |

### Bridge Signals

- **Event:** `DepositForBurn(...)` from TokenMessengerV2
- **Event:** `MessageSent(bytes)` from MessageTransmitterV2

### Implementation Approach

Create a `cctpBridgeDetection()` helper in `mint-burn-contracts-helpers.ts`, similar to `ccipBridgeDetection()`:

```typescript
export function cctpBridgeDetection(): MintBurnBridgeDetectionConfig {
  return {
    protocol: "cctp",
    knownBridgePoolAddresses: [
      "0xfd78ee919681417d192449715b2594ab58f5d002", // TokenMinterV2 (burns tokens)
    ],
    knownBridgeRouterAddresses: [
      "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d", // TokenMessengerV2
    ],
    bridgeSignalTopics: [
      keccak256("DepositForBurn(...)"), // compute actual topic
      keccak256("MessageSent(bytes)"),
    ],
    bridgeSignalSelectors: [
      "0x...", // depositForBurn selector
    ],
  };
}
```

**Prerequisites:**
1. Verify that CCTP burns produce `Transfer(user, 0x0, amount)` where the counterparty is the TokenMinterV2 address (not the TokenMessengerV2)
2. Compute exact `DepositForBurn` topic hash (has many params)
3. Extend `classifyBridgeAwareBurnRows` to handle the `"cctp"` protocol (the CCIP classification path likely works with minor adjustments)

**Affected tokens:** USDC (`usdc-circle`) and EURC (`eurc-circle`). USDC already has CCIP detection but not CCTP. EURC has neither.

**Effort:** ~2-3 hours. New helper, bridge classifier extension, backfill reclassification.

**Impact:** Medium-High. USDC is the largest tracked stablecoin. CCTP bridge burns could be meaningful volume, especially for cross-chain DeFi activity.

### Validation Step Before Implementation

Before building CCTP detection, verify the actual scale:
```sql
SELECT COUNT(*), SUM(amount_usd)
FROM mint_burn_events
WHERE stablecoin_id = 'usdc-circle'
  AND direction = 'burn'
  AND burn_type = 'effective_burn'
  AND counterparty = '0xfd78ee919681417d192449715b2594ab58f5d002'
  AND timestamp >= strftime('%s','now') - 86400*30;
```
If this returns significant volume, proceed. If near-zero, deprioritize.

---

## Tier 3: Additional Bridge Protocol Detection (high effort)

Several tracked stablecoins use bridge protocols we don't yet detect:

| Protocol | Tokens | Mechanism on ETH |
|---|---|---|
| Wormhole NTT | M, wM | Lock (no zero-addr transfer -- **no detection needed**) |
| Fraxferry | FRAX, FRXUSD | Need research |
| Stargate v2 | Various | Need research |
| Across v3 | Various | Need research |

**Note:** GHO uses CCIP Lock/Release on Ethereum (verified). Bridge operations don't produce zero-address transfers. No detection needed.

**Effort:** Per-protocol research + implementation, ~3-5 hours each.

**Recommendation:** Only pursue if the Tier 2 CCTP validation query shows meaningful misclassification volume. Each new protocol requires: understanding the mechanism, identifying contracts/events, adding a classifier path, testing, and backfilling.

---

## Tier 4: Multi-Chain Expansion (very high effort)

Tokens that issue natively on non-Ethereum chains we don't yet monitor:

| Chain | Notable Tokens | Blocker |
|---|---|---|
| Tron | USDT (~$62B) | Non-EVM, needs TRC-20 adapter |
| Solana | USDC, PYUSD | Non-EVM, needs SPL adapter |
| BSC | LISUSD, FDUSD (BSC-native issuance) | EVM, needs BSC RPC integration |
| Base | USDbC, various | EVM, needs Base RPC integration |
| Arbitrum | More tokens beyond USDai | EVM, already have 1 config |

**Recommendation:** BSC and Base are the lowest-hanging fruit among non-Ethereum EVM chains since they use the same log-fetching approach. Tron and Solana require fundamentally new adapters.

---

## Priority Recommendation

1. **Tier 1** (this week): Add 6 missing Ethereum coins. Trivial effort, closes the Ethereum gap to 100%.
2. **Tier 2** (next sprint): Validate CCTP burn volume, then implement if meaningful.
3. **Tier 3** (backlog): Research Fraxferry/Stargate/Across only if specific data quality concerns surface.
4. **Tier 4** (roadmap): BSC/Base chain expansion as a dedicated initiative.
