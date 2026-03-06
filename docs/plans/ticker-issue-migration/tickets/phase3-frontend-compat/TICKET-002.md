---
title: "Add compare page ?coins= backward compatibility for legacy IDs"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Ensure the compare page accepts legacy numeric IDs in the `?coins=` query parameter and normalizes them to canonical IDs.

## Task

### 1. Read the file first

**Read `src/app/compare/client.tsx` fully.** Key things to note:
- Line ~64: `SYMBOL_TO_COIN` maps lowercased symbols to `CoinOption` — used for presets and legacy fallback
- Line ~68: `ID_TO_COIN` maps `coin.id` to `CoinOption` — used for direct ID lookups
- Line ~80: `COMPARISON_PRESETS` use lowercase **symbols** (not IDs) in their `coins` arrays
- Line ~134: `selectedIds` useMemo parses `?coins=`, tries `ID_TO_COIN.get(trimmed)` first, then falls back to `SYMBOL_TO_COIN.get(trimmed.toLowerCase())`

### 2. Add legacy ID resolution

The current lookup chain is: `ID_TO_COIN` (exact ID match) → `SYMBOL_TO_COIN` (symbol fallback). After migration, old numeric IDs won't be in `ID_TO_COIN` anymore. Add a third fallback using the registry:

```ts
import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";
```

In the `selectedIds` useMemo (line ~134), update the `.map()` callback:

```ts
.map((s) => {
  const trimmed = s.trim();
  // 1. Direct canonical ID match
  const byId = ID_TO_COIN.get(trimmed);
  if (byId) return byId;
  // 2. Symbol fallback (used by presets)
  const bySym = SYMBOL_TO_COIN.get(trimmed.toLowerCase());
  if (bySym) return bySym;
  // 3. Legacy ID resolution (e.g., "1" → "usdt-tether")
  const resolved = resolveStablecoinId(trimmed, { allowLegacy: true });
  return resolved ? ID_TO_COIN.get(resolved.canonicalId) ?? null : null;
})
```

### 3. URL normalization

When legacy IDs are resolved, update the URL to use canonical IDs so bookmarks use the new format. Add a URL replacement effect that computes canonical params **inline** from `searchParams` (do NOT depend on `selectedIds` — that would create a render-loop anti-pattern since `selectedIds` is a new array reference on every recomputation):

```ts
// Normalize legacy IDs in the URL to canonical format
useEffect(() => {
  const param = searchParams.get("coins");
  if (!param) return;
  const canonicalSegments = param.split(",").map((s) => {
    const trimmed = s.trim();
    const byId = ID_TO_COIN.get(trimmed);
    if (byId) return byId.id;
    const bySym = SYMBOL_TO_COIN.get(trimmed.toLowerCase());
    if (bySym) return bySym.id;
    const resolved = resolveStablecoinId(trimmed, { allowLegacy: true });
    return resolved ? resolved.canonicalId : null;
  }).filter(Boolean);
  const canonicalParam = canonicalSegments.join(",");
  if (canonicalParam && param !== canonicalParam) {
    replaceParams((params) => {
      params.set("coins", canonicalParam);
    });
  }
}, [searchParams, replaceParams]);
```

This normalizes `/compare/?coins=1,2` → `/compare/?coins=usdt-tether,usdc-circle` on first load.

**Deduplication:** Two different legacy IDs could resolve to the same canonical ID (e.g., `?coins=1,usdt` both resolving to `usdt-tether`). Add `.filter((id, i, arr) => arr.indexOf(id) === i)` after the resolution `.filter(Boolean)` to deduplicate.

### 4. Presets are fine

The `COMPARISON_PRESETS` use **symbols** (e.g., `["usdt", "usdc", "dai", "usds"]`), not IDs. These resolve via `SYMBOL_TO_COIN` which is keyed by `coin.symbol.toLowerCase()` and unaffected by the ID migration. **Do not change presets.**

### 5. API calls

The compare page fetches detail data at line ~258: `` `/api/stablecoin/${id}` ``. After the resolution in step 2, `selectedIds` will contain canonical IDs, so API calls will use them automatically. No separate change needed.

## Acceptance Criteria

- `npm run build` exits 0
- `npm test` exits 0
- `grep -n 'resolveStablecoinId' src/app/compare/client.tsx` returns at least 1 match
- `grep -n 'allowLegacy' src/app/compare/client.tsx` returns at least 1 match
- Presets unchanged: `grep -c 'coins:' src/app/compare/client.tsx` returns same count as before
