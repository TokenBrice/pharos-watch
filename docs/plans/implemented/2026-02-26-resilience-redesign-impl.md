# Resilience Dimension Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the binary blacklist-based resilience score with a 4-sub-factor weighted average (chain risk, collateral quality, custody model, blacklist capability), each 25% weight.

**Architecture:** Add three new enum types and optional fields to `StablecoinMeta`. Rewrite `scoreResilience()` to compute a 4-factor average with default inference from `backing`+`governance` when fields are absent. Update dimension weights (resilience 10%→15%, dependency risk 30%→25%). Create a Claude Code skill to research and apply overrides for ~20 coins. Update the UI to show sub-factor breakdown.

**Tech Stack:** TypeScript, React, Tailwind CSS, Recharts (existing stack — no new deps)

**Design doc:** `docs/plans/2026-02-26-resilience-redesign.md`

---

### Task 1: Add resilience types to `src/lib/types.ts`

**Files:**
- Modify: `src/lib/types.ts:70-89` (add types before `StablecoinMeta`, add fields to `StablecoinMeta`)
- Modify: `src/lib/types.ts:374-385` (add fields to `RawDimensionInputs`)

**Step 1: Add the three new enum types**

Insert these type aliases immediately before the `StablecoinMeta` interface (before line 71):

```typescript
/** Chain where the core protocol operates and collateral is held */
export type ChainRisk = "ethereum" | "stage1-l2" | "established-alt-l1" | "unproven";

/** Trust assumptions in the backing assets */
export type CollateralQuality = "native" | "eth-lst" | "alt-lst-bridged" | "exotic";

/** Where collateral is held and who controls it */
export type CustodyModel = "onchain" | "institutional" | "cex";
```

**Step 2: Add optional fields to `StablecoinMeta`**

Add these three fields after `canBeBlacklisted` (after line 88):

```typescript
  chainRisk?: ChainRisk;
  collateralQuality?: CollateralQuality;
  custodyModel?: CustodyModel;
```

**Step 3: Add new fields to `RawDimensionInputs`**

Add these after the `canBeBlacklisted` field in `RawDimensionInputs` (after line 382):

```typescript
  chainRisk: ChainRisk;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
```

These are non-optional in `RawDimensionInputs` because the worker always resolves defaults before sending to the client.

**Step 4: Verify types compile**

Run: `npm run build`
Expected: Should pass (new types are optional on `StablecoinMeta`, but `RawDimensionInputs` changes will break the worker — expected, fixed in Task 3)

Actually, the build will fail here because `RawDimensionInputs` is populated in the worker. That's fine — we'll fix it in Task 3. Just verify the types file itself has no syntax errors:

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: Errors only in `worker/src/api/report-cards.ts` (missing fields in `rawInputs`), not in `types.ts`

**Step 5: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add ChainRisk, CollateralQuality, CustodyModel types for resilience redesign"
```

---

### Task 2: Add new fields to stablecoins helper

**Files:**
- Modify: `src/lib/stablecoins.ts:2-25` (update `StablecoinOpts` and `coin()` function)

**Step 1: Add new optional fields to `StablecoinOpts`**

Add these fields to the `StablecoinOpts` interface (after the `canBeBlacklisted` field, line 20):

```typescript
  chainRisk?: import("./types").ChainRisk;
  collateralQuality?: import("./types").CollateralQuality;
  custodyModel?: import("./types").CustodyModel;
```

**Step 2: Pass new fields through in `coin()` function**

Update the `coin()` function return statement (line 24) to include the three new fields. Add them to the returned object:

```typescript
function coin(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency, governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, commodityOunces: opts?.commodityOunces, geckoId: opts?.geckoId, cmcSlug: opts?.cmcSlug, protocolSlug: opts?.protocolSlug, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction, contracts: opts?.contracts, supplyMethod: opts?.supplyMethod, dependencies: opts?.dependencies, canBeBlacklisted: opts?.canBeBlacklisted, chainRisk: opts?.chainRisk, collateralQuality: opts?.collateralQuality, custodyModel: opts?.custodyModel };
}
```

**Step 3: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(stablecoins): add chainRisk, collateralQuality, custodyModel to StablecoinOpts"
```

---

### Task 3: Rewrite `scoreResilience()` and update weights

**Files:**
- Modify: `src/lib/report-cards.ts:22-31` (version + weights)
- Modify: `src/lib/report-cards.ts:222-236` (rewrite `scoreResilience()`)
- Modify: `src/lib/report-cards.ts` imports (add new types)

**Step 1: Update imports**

Add `ChainRisk`, `CollateralQuality`, `CustodyModel`, and `BackingType` to the import from `./types` (line 8-17):

```typescript
import type {
  ReportCardGrade,
  ReportCardDimension,
  DimensionKey,
  PegSummaryCoin,
  DexLiquidityData,
  StablecoinMeta,
  GovernanceType,
  BackingType,
  ChainRisk,
  CollateralQuality,
  CustodyModel,
  ReportCard,
} from "./types";
```

**Step 2: Bump methodology version and update weights**

Change line 23:
```typescript
export const METHODOLOGY_VERSION = "3.0";
```

Change lines 25-31:
```typescript
export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  pegStability: 0.25,
  liquidity: 0.25,
  resilience: 0.15,
  decentralization: 0.10,
  dependencyRisk: 0.25,
};
```

**Step 3: Add score maps and default inference**

Replace the entire `scoreResilience` function (lines 222-236) with:

```typescript
// ---------------------------------------------------------------------------
// Resilience: 4-factor model
// ---------------------------------------------------------------------------

const CHAIN_RISK_SCORE: Record<ChainRisk, number> = {
  ethereum: 100,
  "stage1-l2": 66,
  "established-alt-l1": 33,
  unproven: 0,
};

const COLLATERAL_QUALITY_SCORE: Record<CollateralQuality, number> = {
  native: 100,
  "eth-lst": 66,
  "alt-lst-bridged": 33,
  exotic: 0,
};

const CUSTODY_MODEL_SCORE: Record<CustodyModel, number> = {
  onchain: 100,
  institutional: 50,
  cex: 0,
};

const CHAIN_RISK_LABEL: Record<ChainRisk, string> = {
  ethereum: "Ethereum mainnet",
  "stage1-l2": "Stage 1+ L2",
  "established-alt-l1": "Established alt-L1",
  unproven: "Unproven chain",
};

const COLLATERAL_QUALITY_LABEL: Record<CollateralQuality, string> = {
  native: "Native assets (ETH/BTC)",
  "eth-lst": "Ethereum LSTs",
  "alt-lst-bridged": "Alt-L1 LSTs / Bridged",
  exotic: "Exotic / opaque strategy",
};

const CUSTODY_MODEL_LABEL: Record<CustodyModel, string> = {
  onchain: "Fully on-chain",
  institutional: "Institutional custodian",
  cex: "CEX / off-exchange custody",
};

/**
 * Infer default resilience sub-factors from backing + governance.
 * Only used when the field is not explicitly set on StablecoinMeta.
 */
export function inferResilienceDefaults(
  backing: BackingType,
  governance: GovernanceType,
): { chainRisk: ChainRisk; collateralQuality: CollateralQuality; custodyModel: CustodyModel } {
  if (backing === "rwa-backed" && governance === "centralized") {
    return { chainRisk: "ethereum", collateralQuality: "native", custodyModel: "institutional" };
  }
  if (backing === "crypto-backed" && governance === "decentralized") {
    return { chainRisk: "ethereum", collateralQuality: "native", custodyModel: "onchain" };
  }
  if (backing === "crypto-backed" && governance === "centralized-dependent") {
    return { chainRisk: "ethereum", collateralQuality: "eth-lst", custodyModel: "onchain" };
  }
  // algorithmic + any, or any remaining combo
  return { chainRisk: "ethereum", collateralQuality: "native", custodyModel: "onchain" };
}

/**
 * Resolve the final resilience sub-factor values for a coin.
 * Explicit overrides on meta take priority; otherwise, infer from backing + governance.
 */
export function resolveResilienceFactors(meta: StablecoinMeta): {
  chainRisk: ChainRisk;
  collateralQuality: CollateralQuality;
  custodyModel: CustodyModel;
} {
  const defaults = inferResilienceDefaults(meta.flags.backing, meta.flags.governance);
  return {
    chainRisk: meta.chainRisk ?? defaults.chainRisk,
    collateralQuality: meta.collateralQuality ?? defaults.collateralQuality,
    custodyModel: meta.custodyModel ?? defaults.custodyModel,
  };
}

/**
 * Resilience: 4-factor weighted average.
 *
 * Sub-factors (each 25% of the resilience score):
 * 1. Chain Risk — where does the protocol live?
 * 2. Collateral Quality — trust assumptions in backing assets
 * 3. Custody Model — who holds the collateral?
 * 4. Blacklist Capability — can the issuer freeze funds?
 */
export function scoreResilience(
  meta: StablecoinMeta,
  canBeBlacklisted: boolean,
): ReportCardDimension {
  const factors = resolveResilienceFactors(meta);
  const blacklistScore = canBeBlacklisted ? 0 : 100;

  const chainScore = CHAIN_RISK_SCORE[factors.chainRisk];
  const collateralScore = COLLATERAL_QUALITY_SCORE[factors.collateralQuality];
  const custodyScore = CUSTODY_MODEL_SCORE[factors.custodyModel];

  const score = Math.round(
    (chainScore + collateralScore + custodyScore + blacklistScore) / 4,
  );

  // Build detail: list each sub-factor on its own line
  const parts = [
    `Chain: ${CHAIN_RISK_LABEL[factors.chainRisk]} (${chainScore})`,
    `Collateral: ${COLLATERAL_QUALITY_LABEL[factors.collateralQuality]} (${collateralScore})`,
    `Custody: ${CUSTODY_MODEL_LABEL[factors.custodyModel]} (${custodyScore})`,
    `Blacklist: ${canBeBlacklisted ? "Yes" : "No"} (${blacklistScore})`,
  ];

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
```

**Step 4: Verify build**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: Errors in `worker/src/api/report-cards.ts` (call signature changed, `rawInputs` missing fields) — fixed in Task 4. No errors in `src/lib/report-cards.ts`.

**Step 5: Commit**

```bash
git add src/lib/report-cards.ts
git commit -m "feat(report-cards): rewrite scoreResilience with 4-factor model, update weights to v3.0"
```

---

### Task 4: Update worker API handler

**Files:**
- Modify: `worker/src/api/report-cards.ts:284-308` (update `computeCard` to pass meta + populate rawInputs)

**Step 1: Update imports**

Add `resolveResilienceFactors` to the import from `report-cards` (line 10-20):

```typescript
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  GRADE_THRESHOLDS,
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  resolveResilienceFactors,
} from "../../../src/lib/report-cards";
```

**Step 2: Update `computeCard` — pass meta to `scoreResilience()`**

In the `computeCard` function (line 290), change:
```typescript
    resilience: scoreResilience(canBeBlacklisted),
```
to:
```typescript
    resilience: scoreResilience(meta, canBeBlacklisted),
```

**Step 3: Update `rawInputs` to include resolved resilience factors**

After line 284 (`const canBeBlacklisted = isBlacklistable(meta);`), add:
```typescript
    const resilienceFactors = resolveResilienceFactors(meta);
```

Then update the `rawInputs` object (lines 297-308) to include the three new fields after `canBeBlacklisted`:

```typescript
  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    depegEventCount: peg?.eventCount ?? 0,
    lastEventAt: peg?.lastEventAt ?? null,
    liquidityScore: liq?.liquidityScore ?? null,
    concentrationHhi: liq?.concentrationHhi ?? null,
    bluechipGrade: rating?.grade ?? null,
    canBeBlacklisted,
    chainRisk: resilienceFactors.chainRisk,
    collateralQuality: resilienceFactors.collateralQuality,
    custodyModel: resilienceFactors.custodyModel,
    governanceTier: meta.flags.governance as GovernanceType,
    dependencies: meta.dependencies ?? [],
  };
```

**Step 4: Update defunct card rawInputs**

Update the defunct card `rawInputs` (around line 219-224) to include the new fields:
```typescript
      rawInputs: {
        pegScore: null, activeDepeg: false, depegEventCount: 0, lastEventAt: null,
        liquidityScore: null, concentrationHhi: null, bluechipGrade: null,
        canBeBlacklisted: false,
        chainRisk: "ethereum" as const,
        collateralQuality: "native" as const,
        custodyModel: "onchain" as const,
        governanceTier: "centralized" as GovernanceType, dependencies: [],
      },
```

**Step 5: Verify both frontend and worker compile**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Both pass with no errors.

**Step 6: Commit**

```bash
git add worker/src/api/report-cards.ts
git commit -m "feat(worker): pass meta to scoreResilience, include resolved factors in rawInputs"
```

---

### Task 5: Update stress test `computeStressedGrades`

**Files:**
- Modify: `src/lib/report-cards.ts:414-419` (update minimal meta construction in stress test)

The stress test builds a minimal `StablecoinMeta` for `scoreDependencyRisk`. The resilience dimension is NOT recomputed in stress tests (it's based on static metadata). However, the minimal meta object needs to be valid now that `scoreResilience` takes a `StablecoinMeta`.

No code change needed — the stress test only calls `scoreDependencyRisk`, not `scoreResilience`. Verify this is the case by reading the function. If correct, skip to the commit.

**Step 1: Verify no changes needed**

Read `computeStressedGrades()` and confirm it only recomputes `dependencyRisk`, not `resilience`. The existing code at line 420 calls `scoreDependencyRisk(meta, overallScores)` — resilience is not touched.

No changes needed. Move to Task 6.

---

### Task 6: Update UI — sub-factor breakdown

**Files:**
- Modify: `src/components/report-card.tsx:90-123` (add sub-factor details for resilience)

**Step 1: Add import for `RawDimensionInputs` and resilience label maps**

Update imports at top of file. Add:

```typescript
import {
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  METHODOLOGY_VERSION,
} from "@/lib/report-cards";
```

The sub-factor detail is already in the `detail` string (e.g. "Chain: Ethereum mainnet (100). Collateral: Native assets (100). ..."). We'll parse and display it as a sub-factor breakdown when the dimension is `resilience`.

**Step 2: Add resilience sub-factor display**

In the dimension breakdown section (lines 91-123), after each dimension row, add a conditional sub-factor breakdown for resilience. Replace the mapping block:

```tsx
          <div className="space-y-2">
            {DIMENSION_ORDER.map((key) => {
              const dim = card.dimensions[key];
              return (
                <div key={key}>
                  <div
                    className="flex items-center justify-between rounded-lg border px-3 py-2"
                  >
                    <span className="text-sm font-medium">
                      {DIMENSION_LABELS[key]}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-xs font-semibold ${REPORT_CARD_GRADE_COLORS[dim.grade]}`}
                      >
                        {dim.grade}
                      </Badge>
                      <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                        {dim.score !== null ? (
                          <>
                            {dim.score}
                            <span className="text-xs">/100</span>
                          </>
                        ) : (
                          "\u2014"
                        )}
                      </span>
                    </div>
                  </div>
                  {/* Sub-factor breakdown for resilience */}
                  {key === "resilience" && dim.score !== null && (
                    <div className="ml-4 mt-1 space-y-0.5">
                      {dim.detail.split(". ").map((part) => {
                        const match = part.match(/^(.+?):\s*(.+?)\s*\((\d+)\)$/);
                        if (!match) return null;
                        const [, label, desc, scoreStr] = match;
                        const subScore = parseInt(scoreStr, 10);
                        return (
                          <div
                            key={label}
                            className="flex items-center justify-between text-xs text-muted-foreground"
                          >
                            <span>
                              {label}: <span className="text-foreground/70">{desc}</span>
                            </span>
                            <span className="tabular-nums">{subScore}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Passes.

**Step 4: Commit**

```bash
git add src/components/report-card.tsx
git commit -m "feat(ui): show resilience sub-factor breakdown in report card detail"
```

---

### Task 7: Create `resilience-classify` skill

**Files:**
- Create: `.claude/skills/resilience-classify/SKILL.md`

**Step 1: Create skill directory and file**

```markdown
---
name: resilience-classify
description: Research and classify stablecoins for resilience sub-factor overrides (chainRisk, collateralQuality, custodyModel). Run after types/defaults are implemented to identify coins needing explicit overrides.
---

# Resilience Classification Skill

Identify stablecoins where the default inference (from backing + governance) is incorrect and apply overrides.

## When to Invoke

- After the resilience types and default inference are implemented
- When a new stablecoin is added to the tracker
- When auditing resilience scores for accuracy

## Process

### Step 1 — Identify candidates

Read all coins from `src/lib/stablecoins.ts`. For each, apply the default inference rules (see `inferResilienceDefaults()` in `src/lib/report-cards.ts`). Flag coins where the default is likely wrong based on:

- `collateral` text containing keywords: "Solana", "tBTC", "WBTC", "delta-neutral", "perpetual", "CEX", "off-exchange", "Copper", "Ceffu", "Fireblocks", "bridged"
- `pegMechanism` text containing: "Solana", "Bitcoin L2", "not Ethereum", "Tron"
- `contracts[]` listing only non-Ethereum chains
- `backing` = `crypto-backed` but collateral text mentions RWAs, bridges, or exotic strategies
- Coins on this known-override list: HYUSD, USDe, meUSD, USDD, sUSD (Synthetix), USDJ

### Step 2 — Research each candidate

For each flagged coin, in parallel:
- `WebFetch` official docs for collateral composition, custody arrangement, and chain architecture
- `WebSearch` for `"{coin name}" stablecoin collateral custody chain` to find independent analysis
- Cross-reference with existing `collateral` and `pegMechanism` text fields

### Step 3 — Classify

For each coin, determine the correct tier:

| Sub-factor | Question | Tiers |
|---|---|---|
| `chainRisk` | Where does the core protocol live and where is collateral held? | `ethereum` (100), `stage1-l2` (66), `established-alt-l1` (33), `unproven` (0) |
| `collateralQuality` | What are the trust assumptions in backing assets? | `native` (100), `eth-lst` (66), `alt-lst-bridged` (33), `exotic` (0) |
| `custodyModel` | Who holds the collateral and can it be verified on-chain? | `onchain` (100), `institutional` (50), `cex` (0) |

**Classification rules:**
- **chainRisk**: Based on where the protocol's smart contracts and collateral vaults live, NOT where the token is bridged to
- **collateralQuality**: For mixed collateral, use the tier of the riskiest significant component (>15% of backing). Stablecoin portions don't count here (handled by dependency risk)
- **custodyModel**: If ANY significant portion is held off-chain by a non-institutional custodian, classify as `cex`
- When uncertain between two tiers, choose the riskier (lower score) tier

### Step 4 — Present findings

For each coin needing an override, present:

```
## {Name} ({Symbol}) — ID: {id}

### Default inference
- chainRisk: {inferred} — {correct/wrong because...}
- collateralQuality: {inferred} — {correct/wrong because...}
- custodyModel: {inferred} — {correct/wrong because...}

### Proposed overrides
- {field}: {value} — {justification with source URL}

### No override needed
- {fields where default is correct}
```

### Step 5 — Apply

After user approval, edit `src/lib/stablecoins.ts` to add only the override fields that differ from defaults. Example:

```typescript
usd("123", "Example", "EX", "crypto-backed", "decentralized", {
  // ... existing fields ...
  chainRisk: "established-alt-l1",
  collateralQuality: "alt-lst-bridged",
}),
```

Run `npm run build` to verify.
```

**Step 2: Commit**

```bash
git add .claude/skills/resilience-classify/SKILL.md
git commit -m "feat(skill): add resilience-classify skill for researching coin overrides"
```

---

### Task 8: Apply known overrides in `src/lib/stablecoins.ts`

**Files:**
- Modify: `src/lib/stablecoins.ts` (add override fields to ~6 known coins)

**Step 1: Invoke the `resilience-classify` skill**

Run: `/resilience-classify`

This will identify all coins needing overrides and present them for approval. The design doc lists these as known:

| Coin | `chainRisk` | `collateralQuality` | `custodyModel` |
|---|---|---|---|
| HYUSD | `established-alt-l1` | `alt-lst-bridged` | — |
| USDe | — | `exotic` | `cex` |
| meUSD | `unproven` | `alt-lst-bridged` | — |
| USDD | — | `alt-lst-bridged` | — |
| sUSD (Synthetix) | — | `exotic` | — |
| USDJ | `unproven` | `alt-lst-bridged` | — |

The skill may find additional coins needing overrides beyond these 6.

**Step 2: Apply approved overrides**

For each coin, add only the fields that differ from the defaults. Find the coin entry in `src/lib/stablecoins.ts` and add the override fields to its opts object.

**Step 3: Verify build**

Run: `npm run build`
Expected: Passes.

**Step 4: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(stablecoins): add resilience overrides for ~20 coins"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/report-cards.md:15-41` (update resilience section and weight table)

**Step 1: Update weight table**

Update the dimension table (lines 11-17) to reflect new weights:

```markdown
| Dimension | Weight | Source | Scoring |
|-----------|--------|--------|---------|
| **Peg Stability** | 25% | `pegScore` from peg summary | Passthrough. Cap at 65 if active depeg. +3 bonus if no events in 12+ months. NAV tokens → NR |
| **Liquidity** | 25% | `liquidityScore` from DEX liquidity | Passthrough. −5 if HHI > 0.5, −10 if HHI > 0.8 |
| **Resilience** | 15% | Token metadata (4 sub-factors) | Weighted avg of chain risk, collateral quality, custody model, and blacklist capability |
| **Decentralization** | 10% | Governance type from stablecoin metadata | `decentralized` → 95, `centralized-dependent` → 70, `centralized` → 50 |
| **Dependency Risk** | 25% | Upstream stablecoin scores | Non-dependent → 95. CeFi-Dependent → blended score (upstream × weight + self-backed × 75), −10 if any < 75. NR if unmapped |
```

**Step 2: Replace resilience details section**

Replace lines 34-41 with:

```markdown
### Resilience Details

4-factor weighted average (each sub-factor 25% of the resilience score):

| Sub-factor | Scoring | Tiers |
|---|---|---|
| **Chain Risk** | Where does the core protocol operate? | Ethereum (100), Stage 1+ L2 (66), Established alt-L1 (33), Unproven (0) |
| **Collateral Quality** | Trust assumptions in backing assets | Native ETH/BTC (100), Ethereum LSTs (66), Alt-L1 LSTs/bridged (33), Exotic/opaque (0) |
| **Custody Model** | Who holds collateral? | On-chain (100), Institutional custodian (50), CEX/off-exchange (0) |
| **Blacklist Capability** | Can issuer freeze funds? | Not blacklistable (100), Blacklistable (0) |

**Default inference:** When sub-factor fields aren't explicitly set on `StablecoinMeta`, defaults are inferred from `backing` + `governance`:

| Backing + Governance | Chain Risk | Collateral Quality | Custody Model |
|---|---|---|---|
| `rwa-backed` + `centralized` | ethereum | native | institutional |
| `crypto-backed` + `decentralized` | ethereum | native | onchain |
| `crypto-backed` + `centralized-dependent` | ethereum | eth-lst | onchain |
| `algorithmic` + any | ethereum | native | onchain |

Explicit overrides exist for ~20 coins where defaults are incorrect (e.g. HYUSD on Solana, USDe with CEX custody).

Data sources: `chainRisk`, `collateralQuality`, `custodyModel` optional fields on `StablecoinMeta`. `canBeBlacklisted` field (falls back to governance type).
```

**Step 3: Update RawDimensionInputs mention**

In the API section (line 91), update the `RawDimensionInputs` description to mention the new fields:

```markdown
- **`RawDimensionInputs`**: Raw scoring inputs per card (`pegScore`, `activeDepeg`, `liquidityScore`, `concentrationHhi`, `bluechipGrade`, `canBeBlacklisted`, `chainRisk`, `collateralQuality`, `custodyModel`, `governanceTier`, `dependencies`, etc.) — enables client-side stress test recomputation.
```

**Step 4: Verify docs read correctly**

Read the updated file to ensure formatting is correct.

**Step 5: Commit**

```bash
git add docs/report-cards.md
git commit -m "docs: update report-cards.md for resilience 4-factor redesign (v3.0)"
```

---

### Task 10: Final verification

**Step 1: Full build**

Run: `npm run build`
Expected: Clean pass.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean pass.

**Step 3: Visual spot-check**

Run: `npm run dev`

Open `http://localhost:3000/stablecoin/1` (USDT) — verify the report card shows resilience sub-factor breakdown. Check that the resilience score is `63` (chain 100 + collateral 100 + custody 50 + blacklist 0 = 250/4 = 63).

Open `http://localhost:3000/report-cards` — verify the grade distribution has shifted as expected. USDC/USDT should score slightly higher overall (resilience went from 0 to 63).

**Step 4: Commit any remaining fixes**

If anything is broken, fix it and commit.
