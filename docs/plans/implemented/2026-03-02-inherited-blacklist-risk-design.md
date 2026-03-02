# Inherited Blacklist Risk Detection

**Date:** 2026-03-02
**Status:** Approved

## Problem

Coins backed heavily by blacklistable stablecoins (USDC, USDT) are currently scored "No (100)" on the blacklist sub-factor because `isBlacklistable()` only checks the coin's own governance and explicit override — it ignores reserve composition. A DAO-governed coin with 30%+ USDC backing has real, indirect freeze risk that the score doesn't reflect.

**Affected coins at 25% threshold:** DAI (33% USDC via PSM), USDS (30% USDC via PSM).

---

## Design

### 1. Type boundary

`"possible-inherited"` is a **computed** value, never authored. The manual override field stays narrow:

```ts
// StablecoinMeta (authored in stablecoins.ts) — unchanged
canBeBlacklisted?: boolean | "possible";

// RawDimensionInputs + scoreResilience param — expanded
canBeBlacklisted: boolean | "possible" | "possible-inherited";
```

No one should ever write `canBeBlacklisted: "possible-inherited"` in `stablecoins.ts`. The type system enforces this boundary.

### 2. Named threshold constant

Exported from `src/lib/report-cards.ts` alongside other scoring constants:

```ts
export const INHERITED_BLACKLIST_THRESHOLD_PCT = 25;
```

Consistent with how all other calibration choices are documented in the scoring system.

### 3. Shared `isBlacklistable` utility

Extracted to `src/lib/report-cards.ts` — the primary design decision, not a cron afterthought. All three call sites import from there, eliminating triplicated logic.

```ts
/**
 * Returns the blacklist risk tier for a coin.
 *
 * Resolution order:
 *   1. Explicit override (meta.canBeBlacklisted)
 *   2. Centralized governance → true
 *   3. Inherited: ≥ INHERITED_BLACKLIST_THRESHOLD_PCT of reserves
 *      are backed by first-order blacklistable coins (by coinId)
 *   4. false
 *
 * The `blacklistableIds` param must be built from first-order coins only
 * (explicit + centralized) to avoid recursive/circular inheritance.
 */
export function isBlacklistable(
  meta: StablecoinMeta,
  blacklistableIds?: ReadonlySet<string>,
): boolean | "possible" | "possible-inherited" {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
  if (meta.flags.governance === "centralized") return true;
  if (blacklistableIds && meta.reserves) {
    const inheritedPct = meta.reserves
      .filter(r => r.coinId && blacklistableIds.has(r.coinId))
      .reduce((sum, r) => sum + r.pct, 0);
    if (inheritedPct >= INHERITED_BLACKLIST_THRESHOLD_PCT) return "possible-inherited";
  }
  return false;
}
```

**Building the index (call sites):**

```ts
// Built once before the coin loop, using isBlacklistable without the index
// arg → only first-order (explicit + centralized), no inheritance recursion.
const blacklistableIds: ReadonlySet<string> = new Set(
  TRACKED_STABLECOINS
    .filter(m => isBlacklistable(m) === true)
    .map(m => m.id)
);
```

### 4. `scoreResilience` label update

In `src/lib/report-cards.ts`:

```ts
// Parameter type expands
canBeBlacklisted: boolean | "possible" | "possible-inherited"

// Score — inherited inherits the same penalty as mutable-contract
const blacklistScore =
  canBeBlacklisted === true ? 33
  : canBeBlacklisted === "possible" || canBeBlacklisted === "possible-inherited" ? 66
  : 100;

// Label
const blacklistLabel =
  canBeBlacklisted === true ? "Yes"
  : canBeBlacklisted === "possible" ? "Possible (mutable contract)"
  : canBeBlacklisted === "possible-inherited" ? "Possible (inherited)"
  : "No";
```

Detail string example: `"Blacklist: Possible (inherited) (66)"` — matches the existing UI parser regex.

---

## Files changed

| File | Change |
|---|---|
| `src/lib/types.ts` | Expand `RawDimensionInputs.canBeBlacklisted` to include `"possible-inherited"` |
| `src/lib/report-cards.ts` | Export `isBlacklistable`, `INHERITED_BLACKLIST_THRESHOLD_PCT`; update `scoreResilience` param + labels |
| `worker/src/api/report-cards.ts` | Remove local `isBlacklistable`; import from shared lib; build `blacklistableIds` index before coin loop |
| `worker/src/cron/daily-digest.ts` | Replace inline `canBl` logic (×2) with imported `isBlacklistable` + index |
| `worker/src/cron/sync-yield-data.ts` | Replace inline `canBl` logic (×2) with imported `isBlacklistable` + index |
| `src/lib/__tests__/report-cards.test.ts` | Add tests for `"possible-inherited"` label/score; add test for threshold boundary |
| `docs/report-cards.md` | Document inherited blacklist tier and threshold |

---

## Tests

- Existing: `"possible"` → `"Possible (mutable contract) (66)"` — unchanged
- New: coin with ≥25% blacklistable-coinId reserves + non-centralized governance → `"Possible (inherited) (66)"`
- New: coin with <25% blacklistable-coinId reserves → `"No (100)"`
- New: explicit `canBeBlacklisted: false` override always wins (bypasses reserve check)

---

## Non-changes

- Scoring weight: 66 (same as `"possible"`)
- `StablecoinMeta.canBeBlacklisted` type: unchanged (`boolean | "possible"`)
- No `ReserveSlice` schema changes
- No threshold applied to coins already returning `true` or `"possible"`
