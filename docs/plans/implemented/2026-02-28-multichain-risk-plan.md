# Multichain Risk Classification — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single `chainRisk` field with a two-axis model (`chainTier` × `deploymentModel`) that captures both primary chain maturity and multichain architecture risk.

**Architecture:** Two new types (`ChainTier`, `DeploymentModel`) replace `ChainRisk`. Scoring becomes multiplicative: `CHAIN_TIER_SCORE[tier] × DEPLOYMENT_MULT[model]`. The decentralization penalty switches from enum-keyed to threshold-based on the combined score.

**Tech Stack:** TypeScript strict, Next.js 16 static export, shared types imported by worker.

---

### Task 1: Add new types, rename ChainRisk → ChainTier

**Files:**
- Modify: `src/lib/types.ts:82-83` (type definition)
- Modify: `src/lib/types.ts:119` (StablecoinMeta field)
- Modify: `src/lib/types.ts:426` (RawDimensionInputs field)

**Step 1: Update the type definition**

In `src/lib/types.ts`, replace line 82-83:
```typescript
/** Chain where the core protocol operates and collateral is held */
export type ChainRisk = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";
```
with:
```typescript
/** Maturity tier of the primary chain where the protocol operates */
export type ChainTier = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";

/** How the stablecoin extends across multiple chains */
export type DeploymentModel = "single-chain" | "canonical-bridge" | "third-party-bridge" | "native-multichain";
```

**Step 2: Update StablecoinMeta**

In `src/lib/types.ts`, replace line 119:
```typescript
  chainRisk?: ChainRisk;
```
with:
```typescript
  chainTier?: ChainTier;
  deploymentModel?: DeploymentModel;
```

**Step 3: Update RawDimensionInputs**

In `src/lib/types.ts`, replace the `chainRisk` field in `RawDimensionInputs` (line 426):
```typescript
  chainRisk: ChainRisk;
```
with:
```typescript
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
```

**Step 4: Update the import of ChainRisk everywhere it appears**

Search for all `ChainRisk` imports and rename to `ChainTier`. Also add `DeploymentModel` to imports where needed. Files:
- `src/lib/report-cards.ts` — line 18: `ChainRisk` → `ChainTier`, add `DeploymentModel`
- `worker/src/api/report-cards.ts` — line 37: `ChainRisk` → `ChainTier`, add `DeploymentModel`

**Step 5: Verify types compile**

Run: `npm run build`
Expected: Compilation errors in report-cards.ts and stablecoins.ts (because they still reference old field names). This is expected — we fix them in subsequent tasks.

---

### Task 2: Update report-cards scoring engine

**Files:**
- Modify: `src/lib/report-cards.ts:216-221` (CHAIN_RISK_SCORE → CHAIN_TIER_SCORE)
- Modify: `src/lib/report-cards.ts:294-299` (CHAIN_RISK_LABEL → CHAIN_TIER_LABEL)
- Modify: `src/lib/report-cards.ts:319-337` (inferResilienceDefaults)
- Modify: `src/lib/report-cards.ts:343-354` (resolveResilienceFactors)
- Modify: `src/lib/report-cards.ts:365-397` (scoreResilience)
- Modify: `src/lib/report-cards.ts:441-467` (scoreDecentralization)

**Step 1: Replace score and label constants**

Replace `CHAIN_RISK_SCORE` (lines 216-221) with:
```typescript
const CHAIN_TIER_SCORE: Record<ChainTier, number> = {
  ethereum: 100,
  "stage1-l2": 66,
  "established-alt-l1": 20,
  unproven: 0,
};

const DEPLOYMENT_MULT: Record<DeploymentModel, number> = {
  "single-chain": 1.0,
  "canonical-bridge": 0.85,
  "third-party-bridge": 0.60,
  "native-multichain": 0.40,
};
```

Replace `CHAIN_RISK_LABEL` (lines 294-299) with:
```typescript
const CHAIN_TIER_LABEL: Record<ChainTier, string> = {
  ethereum: "Ethereum mainnet",
  "stage1-l2": "Stage 1+ L2",
  "established-alt-l1": "Established alt-L1",
  unproven: "Unproven chain",
};

const DEPLOYMENT_MODEL_LABEL: Record<DeploymentModel, string> = {
  "single-chain": "",
  "canonical-bridge": "canonical bridge",
  "third-party-bridge": "third-party bridge",
  "native-multichain": "native multichain",
};
```

**Step 2: Add chainInfraScore helper**

Add after the constants:
```typescript
/** Combined chain infrastructure score: tier base × deployment multiplier */
export function chainInfraScore(tier: ChainTier, model: DeploymentModel): number {
  return Math.round(CHAIN_TIER_SCORE[tier] * DEPLOYMENT_MULT[model]);
}

/** Two-part label: "Ethereum mainnet (third-party bridge)" */
export function chainInfraLabel(tier: ChainTier, model: DeploymentModel): string {
  const base = CHAIN_TIER_LABEL[tier];
  const suffix = DEPLOYMENT_MODEL_LABEL[model];
  return suffix ? `${base} (${suffix})` : base;
}
```

**Step 3: Update inferResilienceDefaults**

Replace the function (lines 319-337) — add `deploymentModel` to the return type and all return values:
```typescript
export function inferResilienceDefaults(
  backing: BackingType,
  governance: GovernanceType,
): { chainTier: ChainTier; deploymentModel: DeploymentModel; collateralQuality: CollateralQuality; custodyModel: CustodyModel } {
  if (backing === "rwa-backed" && governance === "centralized") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "rwa", custodyModel: "institutional" };
  }
  if (backing === "rwa-backed" && governance === "centralized-dependent") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "rwa", custodyModel: "institutional" };
  }
  if (backing === "crypto-backed" && governance === "decentralized") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "native", custodyModel: "onchain" };
  }
  if (backing === "crypto-backed" && governance === "centralized-dependent") {
    return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "eth-lst", custodyModel: "onchain" };
  }
  return { chainTier: "ethereum", deploymentModel: "single-chain", collateralQuality: "native", custodyModel: "onchain" };
}
```

**Step 4: Update resolveResilienceFactors**

Replace the function (lines 343-354):
```typescript
export function resolveResilienceFactors(meta: StablecoinMeta): {
  chainTier: ChainTier;
  deploymentModel: DeploymentModel;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
} {
  const defaults = inferResilienceDefaults(meta.flags.backing, meta.flags.governance);
  return {
    chainTier: meta.chainTier ?? defaults.chainTier,
    deploymentModel: meta.deploymentModel ?? defaults.deploymentModel,
    collateralQuality: meta.collateralQuality ?? defaults.collateralQuality,
    custodyModel: meta.custodyModel ?? defaults.custodyModel,
  };
}
```

**Step 5: Update scoreResilience**

In the `scoreResilience` function (lines 365-397), update to use combined score:
```typescript
export function scoreResilience(
  meta: StablecoinMeta,
  canBeBlacklisted: boolean | "possible",
): ReportCardDimension {
  const factors = resolveResilienceFactors(meta);
  const blacklistScore = canBeBlacklisted === true ? 0 : canBeBlacklisted === "possible" ? 50 : 100;
  const blacklistLabel = canBeBlacklisted === true ? "Yes" : canBeBlacklisted === "possible" ? "Possible (mutable contract)" : "No";

  const chainScore = chainInfraScore(factors.chainTier, factors.deploymentModel);
  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];

  const hasReserves = meta.reserves && meta.reserves.length > 0;
  const collateralScore = hasReserves
    ? computeCollateralQualityFromReserves(meta.reserves!)
    : COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const collateralLabel = hasReserves
    ? collateralScoreLabel(collateralScore)
    : COLLATERAL_QUALITY_LABEL[factors.collateralQuality];

  const score = Math.round(
    (chainScore + collateralScore + custodyScore + blacklistScore) / 4,
  );

  const parts = [
    `Chain: ${chainInfraLabel(factors.chainTier, factors.deploymentModel)} (${chainScore})`,
    `Collateral: ${collateralLabel} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${blacklistLabel} (${blacklistScore})`,
  ];

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
```

**Step 6: Update scoreDecentralization**

Replace the function (lines 441-467) with threshold-based penalty:
```typescript
export function scoreDecentralization(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): ReportCardDimension {
  const quality = resolveGovernanceQuality(governance, meta);
  let score = GOVERNANCE_QUALITY_SCORE[quality];

  // Chain infrastructure penalty (threshold-based on combined score)
  const factors = meta ? resolveResilienceFactors(meta) : undefined;
  const infraScore = factors
    ? chainInfraScore(factors.chainTier, factors.deploymentModel)
    : 100; // no meta = assume ethereum single-chain

  let penalty = 0;
  if (infraScore >= 80) penalty = 0;
  else if (infraScore >= 50) penalty = -15;
  else if (infraScore >= 15) penalty = -50;
  else penalty = -65;

  if (quality !== "single-entity" && penalty < 0) {
    score = Math.max(0, score + penalty);
  }

  let detail = GOVERNANCE_QUALITY_LABEL[quality];
  if (penalty < 0 && factors) {
    detail += ` (${chainInfraLabel(factors.chainTier, factors.deploymentModel)}: ${penalty} penalty)`;
  }

  return { grade: scoreToGrade(score), score, detail };
}
```

---

### Task 3: Update worker API report-cards handler

**Files:**
- Modify: `worker/src/api/report-cards.ts:37` (import)
- Modify: `worker/src/api/report-cards.ts:215` (defunct card raw inputs)
- Modify: `worker/src/api/report-cards.ts:305` (live card raw inputs)

**Step 1: Update import**

Replace `ChainRisk` with `ChainTier, DeploymentModel` in the import statement at line 37.

**Step 2: Update defunct card rawInputs**

At line 215, replace:
```typescript
chainRisk: "ethereum" as ChainRisk,
```
with:
```typescript
chainTier: "ethereum" as ChainTier,
deploymentModel: "single-chain" as DeploymentModel,
```

**Step 3: Update live card rawInputs**

At line 305, replace:
```typescript
chainRisk: resilienceFactors.chainRisk,
```
with:
```typescript
chainTier: resilienceFactors.chainTier,
deploymentModel: resilienceFactors.deploymentModel,
```

---

### Task 4: Rename chainRisk → chainTier in stablecoins.ts data

**Files:**
- Modify: `src/lib/stablecoins.ts` (all ~47 occurrences of `chainRisk:`)

**Step 1: Bulk rename**

Find-and-replace all `chainRisk:` with `chainTier:` in `src/lib/stablecoins.ts`. This is a safe mechanical rename — the values remain identical.

**Step 2: Add deploymentModel overrides for known coins**

Add `deploymentModel` to these coins:
- **BOLD** (ID 269): add `deploymentModel: "third-party-bridge",` — uses Chainlink CCIP
- **rwaUSDi** (ID 340): add `deploymentModel: "native-multichain",` — independent minting on multiple chains
- **satUSD** (ID 279): already `chainTier: "unproven"`, add `deploymentModel: "third-party-bridge",` — uses LayerZero OFT

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean compile, no errors.

---

### Task 5: Update portfolio client stub

**Files:**
- Modify: `src/app/portfolio/client.tsx:265`

**Step 1: Replace chainRisk stub**

At line 265, replace:
```typescript
chainRisk: "ethereum",
```
with:
```typescript
chainTier: "ethereum",
deploymentModel: "single-chain",
```

---

### Task 6: Update documentation

**Files:**
- Modify: `docs/report-cards.md`
- Modify: `docs/api-reference.md`
- Modify: `.claude/skills/resilience-classify/SKILL.md`

**Step 1: Update report-cards.md**

Update the Resilience section's Chain Risk row in the sub-factor table to reflect the two-axis model:
- Replace single-row "Chain Risk" with description of two-axis `chainTier × deploymentModel`
- Add the deployment multiplier table
- Update the decentralization chain-risk penalty section to describe threshold-based scoring

**Step 2: Update api-reference.md**

Search for `chainRisk` in `docs/api-reference.md` and replace with `chainTier` + `deploymentModel` in the `RawDimensionInputs` field documentation.

**Step 3: Update resilience-classify skill**

In `.claude/skills/resilience-classify/SKILL.md`:
- Update skill description to reference `chainTier` + `deploymentModel` instead of `chainRisk`
- Add `deploymentModel` classification criteria to the classification table
- Add the decision tree from the design doc

---

### Task 7: Full build verification and score impact analysis

**Step 1: Build frontend**

Run: `npm run build`
Expected: Clean compile, zero errors.

**Step 2: Type-check worker**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean compile, zero errors.

**Step 3: Commit all changes**

```bash
git add -A
git commit -m "feat: replace chainRisk with chainTier + deploymentModel two-axis model

Multichain architecture risk now captured separately from primary chain
maturity. Deployment model multiplier: single-chain (1.0), canonical-bridge
(0.85), third-party-bridge (0.60), native-multichain (0.40).

Decentralization penalty now threshold-based on combined infrastructure score."
```
