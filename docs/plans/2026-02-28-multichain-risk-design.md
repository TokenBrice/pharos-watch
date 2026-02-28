# Multichain Risk Classification Design

**Date:** 2026-02-28
**Status:** Approved

## Problem

The current `chainRisk` field is a single enum (`"ethereum" | "stage1-l2" | "established-alt-l1" | "unproven"`) that captures only the maturity of a stablecoin's primary chain. It ignores _how_ a stablecoin extends across chains, which is a distinct risk axis.

**Example:** BOLD mints on Ethereum but bridges via Chainlink CCIP to Arbitrum/Base/Optimism/Avalanche. rwaUSDi can mint natively on multiple chains. Both currently default to `chainRisk: "ethereum"` (score 100), but the multichain architecture itself adds trust assumptions and attack surface.

## Design

### Two-Axis Model

Replace the single `chainRisk` field with two independent fields:

| Field | Type | Purpose |
|-------|------|---------|
| `chainTier` | `ChainTier` | Maturity of the primary chain (where core minting/logic lives) |
| `deploymentModel` | `DeploymentModel` | How the token extends to other chains |

```typescript
type ChainTier = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";

type DeploymentModel =
  | "single-chain"         // No multichain presence, or irrelevant bridged copies
  | "canonical-bridge"     // Bridges via L2 canonical rollup bridges (inherits rollup security)
  | "third-party-bridge"   // Bridges via CCIP, LayerZero, Wormhole, etc.
  | "native-multichain";   // Independent minting/redeeming on multiple chains
```

### Scoring

Combined score = `CHAIN_TIER_SCORE[chainTier] × DEPLOYMENT_MULT[deploymentModel]`

**Chain tier base scores (unchanged):**

| Tier | Score |
|------|-------|
| ethereum | 100 |
| stage1-l2 | 66 |
| established-alt-l1 | 20 |
| unproven | 0 |

**Deployment model multipliers:**

| Model | Multiplier |
|-------|-----------|
| single-chain | 1.00 |
| canonical-bridge | 0.85 |
| third-party-bridge | 0.60 |
| native-multichain | 0.40 |

**Full score matrix:**

| Deployment Model | ETH (100) | L2 (66) | Alt-L1 (20) | Unproven (0) |
|------------------|-----------|---------|-------------|--------------|
| single-chain | 100 | 66 | 20 | 0 |
| canonical-bridge | 85 | 56 | 17 | 0 |
| third-party-bridge | 60 | 40 | 12 | 0 |
| native-multichain | 40 | 26 | 8 | 0 |

This combined score replaces `chainScore` in:
- **Resilience** (25% weight sub-factor)
- **Decentralization** penalty (threshold-based, see below)

### Decentralization Penalty

Keyed off the combined chain infrastructure score using threshold bands:

| Combined Score | Penalty |
|---------------|---------|
| 80–100 | 0 |
| 50–79 | −15 |
| 15–49 | −50 |
| 0–14 | −65 |

Notable implications:
- Ethereum + single-chain (100) → 0 penalty
- Ethereum + canonical-bridge (85) → 0 penalty
- Ethereum + third-party-bridge (60) → −15 penalty
- Ethereum + native-multichain (40) → −50 penalty
- Stage1-L2 + single-chain (66) → −15 penalty

### Display Labels

Two-part label: `"{ChainTier label}"` with optional deployment suffix. Single-chain gets no suffix.

| Combination | Label |
|-------------|-------|
| ethereum + single-chain | "Ethereum mainnet" |
| ethereum + canonical-bridge | "Ethereum mainnet (canonical bridge)" |
| ethereum + third-party-bridge | "Ethereum mainnet (third-party bridge)" |
| ethereum + native-multichain | "Ethereum mainnet (native multichain)" |
| unproven + third-party-bridge | "Unproven chain (third-party bridge)" |

### Classification Decision Tree

```
Can the protocol mint/redeem on >1 chain independently?
  YES → native-multichain
  NO → Is the token on >1 chain?
    NO → single-chain
    YES → Does cross-chain transfer use the L2's canonical rollup bridge?
      YES → canonical-bridge
      NO → third-party-bridge (CCIP, LayerZero, Wormhole, etc.)
```

### Defaults

When neither field is set, `inferResilienceDefaults()` returns:
- `chainTier: "ethereum"`
- `deploymentModel: "single-chain"`

This preserves current behavior — coins without overrides score exactly 100 as they do today.

## Migration

### Type Changes

- Rename `ChainRisk` → `ChainTier` (same values, same semantics)
- Rename `chainRisk` field → `chainTier` on `StablecoinMeta`
- Add `DeploymentModel` type and `deploymentModel` field to `StablecoinMeta`
- Update `inferResilienceDefaults()`, `resolveResilienceFactors()`, `scoreResilience()`, `scoreDecentralization()`

### Data Migration

- All ~47 existing `chainRisk: "xxx"` overrides become `chainTier: "xxx"` — no value changes
- All get implicit `deploymentModel: "single-chain"` unless explicitly overridden
- Known coins needing `deploymentModel` overrides (initial set):
  - **BOLD** (269): `third-party-bridge` (Chainlink CCIP)
  - **rwaUSDi** (340): `native-multichain`
  - **satUSD** (279): already `unproven`, likely `third-party-bridge` or `native-multichain` (LayerZero OFT)

### Score Impact Analysis (Migration Gate)

Before merging, compute before/after scores for all coins. The invariant:
- Coins WITHOUT a new `deploymentModel` override → identical scores to today
- Only coins WITH an explicit `deploymentModel` override → scores change

### Documentation Updates

- `docs/report-cards.md` — update chain risk section with two-axis model
- `resilience-classify` skill — update to classify `deploymentModel` alongside `chainTier`

### Decentralization Penalty Band Calibration

Validate that the threshold boundaries (80/50/15) don't create disproportionate cliff effects. Key check: Ethereum + third-party-bridge (60, penalty −15) vs Ethereum + native-multichain (40, penalty −50) — a 35-point penalty jump for one tier of deployment model difference should feel proportional to the actual risk difference.
