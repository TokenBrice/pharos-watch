# Reserve-Derived Dependencies

> Design doc — 2026-02-28

## Problem

The `dependencies` field on `StablecoinMeta` is manually maintained and has drifted from the carefully curated `reserves` data. **22 coins** have mismatches where reserves reference tracked stablecoins not captured in dependencies. **11 coins** declare zero dependencies despite reserves explicitly referencing tracked stablecoins (USDC, USDT, USDtb, BUIDL, etc.).

Example — JupUSD (335):
- `reserves`: 90% USDtb, 10% USDC
- `dependencies`: `[{ id: "2", weight: 0.1 }]` — only captures the 10% USDC, misses the 90% USDtb entirely

This causes inaccurate dependency-risk scores, misleading dependency-map visualizations, and incorrect contagion modeling.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Source of truth | Reserves replace dependencies | Single source, no drift |
| Mapping method | Explicit `coinId` on ReserveSlice | Type-safe, no fragile name-matching |
| Dependency types | `depType` on ReserveSlice | Co-locates all dependency info in reserves |
| Fallback | Manual `dependencies` for coins without reserves | Gradual migration, no data loss |
| Derivation timing | Runtime (scoring time) | No generated code, no build artifacts to drift |
| Cleanup | Strip `dependencies` from migrated coins | Clean break, no dead code |

## Type Changes

### `src/lib/types.ts` — ReserveSlice

```typescript
export interface ReserveSlice {
  name: string;
  pct: number;
  risk: ReserveRisk;
  coinId?: string;           // DefiLlama ID of a tracked stablecoin
  depType?: DependencyType;  // "collateral" (default) | "wrapper" | "mechanism"
}
```

No changes to `DependencyWeight` or `StablecoinMeta.dependencies` — those types stay as-is for the fallback path.

## Derivation Function

New export in `src/lib/reserve-templates.ts`:

```typescript
export function deriveDependencies(meta: StablecoinMeta): DependencyWeight[] {
  const reserves = meta.reserves;
  if (!reserves?.length) return meta.dependencies ?? [];

  const linked = reserves.filter(r => r.coinId);
  if (linked.length === 0) return meta.dependencies ?? [];

  return linked.map(r => ({
    id: r.coinId!,
    weight: r.pct / 100,
    type: r.depType ?? "collateral",
  }));
}
```

**Priority chain**: reserves with `coinId` → manual `dependencies` → empty array.

## Weight Semantics

Reserve percentages map directly to dependency weights as `pct / 100`. Weights are **not** renormalized to sum to 1.0. This interacts with `scoreDependencyRisk()` as follows:

- Only slices with `coinId` become dependency weights
- Non-linked slices (e.g., "U.S. Treasury Bills", "ETH/stETH") contribute to the **self-backed** component: `1 - Σ(linked weights)`
- Self-backed score varies by governance: decentralized = 90, centralized-dependent = 75, centralized = 95

**Example — JupUSD**: 90% USDtb (coinId: "221") + 10% USDC (coinId: "2") → total dependency weight = 1.0, self-backed = 0. Blended score = 0.9 × USDtb_score + 0.1 × USDC_score.

**Example — USDe**: 45% ETH + 25% BTC + 10% SOL + 20% stablecoins (coinId-linked) → total dependency weight = 0.20, self-backed = 0.80. Blended score = 0.2 × stablecoin_blend + 0.8 × 75 (centralized-dependent self-backed).

## Integration Points

Every consumer of `meta.dependencies` switches to `deriveDependencies(meta)`:

| Location | What changes |
|----------|-------------|
| `src/lib/report-cards.ts` — `scoreDependencyRisk()` | Use derived dependencies for weight calculations |
| `worker/src/api/report-cards.ts` — graph edges | Build edges from derived dependencies |
| `worker/src/api/report-cards.ts` — rawInputs | Populate `rawInputs.dependencies` from derived data |
| `src/app/stablecoin/[id]/client.tsx` | Display derived dependencies in the detail page |
| `src/app/dependency-map/` | Visualization uses derived graph edges (already from API) |

## Data Migration

### Scope

Populate `coinId` (and `depType` where applicable) on all ~130 coins with curated reserves. This covers:

- **22 coins with known mismatches** (reserves reference tracked stablecoins not in dependencies)
- **11 coins with zero dependencies** but reserves referencing tracked stablecoins
- All remaining coins: add `coinId` to any reserve slice that references a tracked stablecoin

### Wrapper and Mechanism Annotations

For wrappers (sUSDe, USDC.e, wUSDM, etc.), set `depType: "wrapper"` on the relevant reserve slice.
For mechanism dependencies (e.g., crvUSD → USDT/USDC for PSM), set `depType: "mechanism"`.
All others default to `"collateral"` (omitted in config for brevity).

### Cleanup

After populating `coinId`, strip the `dependencies` field from every coin whose reserves have at least one `coinId`. If `dependencies` is still present on a coin, it means that coin has no reserve-linked data and needs the manual fallback.

## Build-Time Validation

Add a warning-level check:

1. **Unlinked stablecoin names**: If a reserve slice name contains a known stablecoin ticker (USDC, USDT, DAI, etc.) but has no `coinId`, emit a warning. Catches future omissions.
2. **Dual-source conflict**: If a coin has both `dependencies` and reserve slices with `coinId`, warn. Should not happen after cleanup.

## Migration Verification

Before merging, produce a before/after comparison:

1. Run report-card scoring with current `dependencies`
2. Run scoring with derived dependencies
3. Output a diff table: `coin | old dep-risk score | new score | Δ`

This surfaces scoring surprises and serves as a PR review artifact. One-off script, not a permanent feature.

## Affected Documentation

- `docs/report-cards.md` — update dependency-risk section to describe reserve derivation
- `docs/stability-index.md` — if PSI references dependencies, update
- `docs/architecture.md` — note ReserveSlice type changes
