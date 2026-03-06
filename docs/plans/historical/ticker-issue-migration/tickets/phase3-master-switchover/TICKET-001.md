---
title: "Switch id values in TRACKED_STABLECOINS to canonical ticker-issuer format"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Replace all `id` values in `TRACKED_STABLECOINS` with their canonical `ticker-issuer` equivalents.

## Task

1. **Reference mapping:** Use the mapping table at `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator). The `ID_MAPPING` array has `oldId` and `newId` for each entry.

2. **`shared/lib/stablecoins.ts`:** For every entry in `TRACKED_STABLECOINS`, change the first argument (the `id`) from the old format to the canonical format:

   ```ts
   // Before:
   usd("1", "Tether", "USDT", "rwa-backed", "centralized", { llamaId: "1", detailProvider: "defillama", ... })
   // After:
   usd("usdt-tether", "Tether", "USDT", "rwa-backed", "centralized", { llamaId: "1", detailProvider: "defillama", ... })

   // Before:
   usd("cg-ustb", "Superstate USTB", "USTB", ..., { detailProvider: "coingecko", ... })
   // After:
   usd("ustb-superstate", "Superstate USTB", "USTB", ..., { detailProvider: "coingecko", ... })

   // Before:
   other("gold-xaut", "Tether Gold", "XAUT", ..., "GOLD", { detailProvider: "commodity", ... })
   // After:
   other("xaut-tether", "Tether Gold", "XAUT", ..., "GOLD", { detailProvider: "commodity", ... })
   ```

3. Apply ALL 148+ mappings from `ID_MAPPING`. Cross-reference each `oldId` against the current `id` values in `stablecoins.ts`.

4. **Pre-check:** Before running this ticket, verify that ALL `// TODO: verify issuer` comments in the mapping table have been resolved. Run `grep -c '// TODO: verify issuer' ./DESIGN-MAPPING-TABLE.ts` — must return 0. If any remain, STOP and report them.

5. **Also update cross-references within `stablecoins.ts`:**

   **`reserves[].coinId` references (~116 occurrences across the file):** Many entries have `reserves` arrays with `coinId` fields referencing other stablecoins by legacy ID. These must also be migrated:
   ```ts
   // Before:
   reserves: [{ name: "USDT (PSM vaults)", pct: 16, risk: "low", coinId: "1" }]
   // After:
   reserves: [{ name: "USDT (PSM vaults)", pct: 16, risk: "low", coinId: "usdt-tether" }]
   ```
   Use the mapping table to translate every `coinId` value. Some `coinId` values reference `cg-*` IDs (e.g., `coinId: "cg-ousg"`) — these also need canonical IDs.

   **`dependencies[].id` references (8 stablecoins, 12 individual ID refs across ~7 lines):** Some entries have `dependencies` arrays with `id` fields (note: some lines have multiple `{ id: }` objects):
   ```ts
   // Before:
   dependencies: [{ id: "1", weight: 0.10 }, { id: "2", weight: 0.10 }]
   // After:
   dependencies: [{ id: "usdt-tether", weight: 0.10 }, { id: "usdc-circle", weight: 0.10 }]
   ```

   **Do NOT change** any other field (name, symbol, flags, llamaId, detailProvider, geckoId, etc.). Only the `id` argument and `coinId`/`dependencies[].id` cross-references change.

6. Update the file header comment that says `IDs are DefiLlama numeric IDs (string)` to say `IDs use canonical ticker-issuer format`.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `grep -c '"usdt-tether"' shared/lib/stablecoins.ts` returns at least 1
- `grep -c '"usdc-circle"' shared/lib/stablecoins.ts` returns at least 1
- No remaining legacy IDs in the `id` position (first argument to `usd()`, `eur()`, `other()`):
  - `grep -E '^\s+(usd|eur|other)\("[0-9]' shared/lib/stablecoins.ts` returns 0 matches (catches all three helper functions, not just `usd()`)
  - `grep -E '^\s+(usd|eur|other)\("cg-' shared/lib/stablecoins.ts` returns 0 matches
  - `grep -E '^\s+other\("(gold|silver)-' shared/lib/stablecoins.ts` returns 0 matches
- `grep 'coinId: "[0-9]' shared/lib/stablecoins.ts` returns 0 matches (no remaining numeric coinId cross-references)
- `grep 'coinId: "cg-' shared/lib/stablecoins.ts` returns 0 matches (no remaining cg- prefix coinId cross-references)
- `grep -c 'coinId:' shared/lib/stablecoins.ts` returns the same count before and after the change (no coinId references were accidentally deleted)
- `grep '{ id: "[0-9]' shared/lib/stablecoins.ts` returns 0 matches (no remaining numeric dependency IDs)
- `grep -c '// TODO: verify issuer' ./DESIGN-MAPPING-TABLE.ts` returns 0 (all issuer TODOs in the mapping table resolved before this ticket runs)
