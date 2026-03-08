---
name: resilience-classify
description: Research and classify stablecoins for resilience sub-factor overrides (chainTier, deploymentModel, collateralQuality, custodyModel). Run after types/defaults are implemented to identify coins needing explicit overrides.
---

# Resilience Classification Skill

Identify stablecoins where the default inference (from backing + governance) is incorrect and apply overrides.

## When to Invoke

- After the resilience types and default inference are implemented
- When a new stablecoin is added to the tracker
- When auditing resilience scores for accuracy

## Process

### Step 1 — Identify candidates

Read all coins from `shared/lib/stablecoins.ts`. For each, apply the default inference rules (see `inferResilienceDefaults()` in `src/lib/report-cards.ts`). Flag coins where the default is likely wrong based on:

- `collateral` text containing keywords: "Solana", "tBTC", "WBTC", "delta-neutral", "perpetual", "CEX", "off-exchange", "Copper", "Ceffu", "Fireblocks", "bridged"
- `pegMechanism` text containing: "Solana", "Bitcoin L2", "not Ethereum", "Tron"
- `contracts[]` listing only non-Ethereum chains
- `contracts[]` listing multiple chains (candidate for `deploymentModel` override)
- `backing` = `crypto-backed` but collateral text mentions RWAs, bridges, or exotic strategies
- Coins on this known-override list: HYUSD, USDe, meUSD, USDD, sUSD (Synthetix), USDJ, BOLD, rwaUSDi, satUSD
- `collateral` or `pegMechanism` text mentioning: "LayerZero", "OFT", "CCIP", "Wormhole", "Axelar", "multichain", "cross-chain"

### Step 2 — Research each candidate

For each flagged coin, in parallel:
- `WebFetch` official docs for collateral composition, custody arrangement, and chain architecture
- `WebSearch` for `"{coin name}" stablecoin collateral custody chain` to find independent analysis
- Cross-reference with existing `collateral` and `pegMechanism` text fields

### Step 3 — Classify

For each coin, determine the correct tier:

| Sub-factor | Question | Tiers |
|---|---|---|
| `chainTier` | Where does the core protocol live and where is collateral held? | `ethereum` (100), `stage1-l2` (66), `established-alt-l1` (20), `unproven` (0) |
| `deploymentModel` | How does the token extend to other chains? | `single-chain` (×1.0), `canonical-bridge` (×0.85), `third-party-bridge` (×0.60), `native-multichain` (×0.40) |
| `collateralQuality` | What are the trust assumptions in backing assets? | `native` (100), `eth-lst` (66), `rwa` (50), `alt-lst-bridged-or-mixed` (20), `exotic` (0) |
| `custodyModel` | Who holds the collateral and can it be verified on-chain? | `onchain` (100), `institutional` (50), `cex` (0) |

**Classification rules:**
- **chainTier**: Based on where the protocol's smart contracts and collateral vaults live, NOT where the token is bridged to
- **deploymentModel**: Use the decision tree:
  ```
  Can the protocol mint/redeem on >1 chain independently?
    YES → native-multichain
    NO → Is the token on >1 chain?
      NO → single-chain
      YES → Does cross-chain transfer use the L2's canonical rollup bridge?
        YES → canonical-bridge
        NO → third-party-bridge (CCIP, LayerZero, Wormhole, etc.)
  ```
- **collateralQuality**: For mixed collateral, use the tier of the riskiest significant component (>15% of backing). Stablecoin portions don't count here (handled by dependency risk)
- **custodyModel**: If ANY significant portion is held off-chain by a non-institutional custodian, classify as `cex`
- When uncertain between two tiers, choose the riskier (lower score) tier

### Step 4 — Present findings

For each coin needing an override, present:

```
## {Name} ({Symbol}) — ID: {id}

### Default inference
- chainTier: {inferred} — {correct/wrong because...}
- deploymentModel: {inferred} — {correct/wrong because...}
- collateralQuality: {inferred} — {correct/wrong because...}
- custodyModel: {inferred} — {correct/wrong because...}

### Proposed overrides
- {field}: {value} — {justification with source URL}

### No override needed
- {fields where default is correct}
```

### Step 5 — Apply

After user approval, edit `shared/lib/stablecoins.ts` to add only the override fields that differ from defaults. Example:

```typescript
usd("ex-example", "Example", "EX", "crypto-backed", "decentralized", {
  // ... existing fields ...
  chainTier: "established-alt-l1",
  deploymentModel: "third-party-bridge",
  collateralQuality: "alt-lst-bridged-or-mixed",
}),
```

Run `npm run build` to verify.
