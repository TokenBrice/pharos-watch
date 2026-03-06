---
title: "Switch id values in SHADOW stablecoins"
agent: "codex"
reasoning_effort: "medium"
done: false
---

## Goal

Replace all `id` values in `SHADOW_STABLECOINS` with their canonical `ticker-issuer` equivalents.

## Task

### 1. `shared/lib/shadow-stablecoins.ts` (2 entries)

Use the `SHADOW_ID_MAPPING` from `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator):

- `id: "3"` → `id: "ust-terra"` (the `llamaId: "3"` field added in Phase 1 stays unchanged — it's the DL API identifier)
- `id: "iron-finance"` → `id: "iron-iron-finance"` (no `llamaId` exists for this entry — it has no DL stablecoin ID)

Shadow stablecoins are `StablecoinMeta` objects with an `id` field (the first argument to the `coin()` helper). Only the `id` changes — all other fields stay the same.

### 2. Dead stablecoins — NO CHANGES NEEDED

The `DeadStablecoin` type does NOT have an `id` field. Dead stablecoins only have `name`, `symbol`, `llamaId?`, `logo?`, `pegCurrency`, `causeOfDeath`, `deathDate`, `peakMcap?`, `epitaph?`, `obituary`, `sourceUrl`, `sourceLabel`. There is nothing to re-key in `dead-stablecoins.ts`.

Dead stablecoin entries in `data/logos.json` and `data/ai-summaries.json` are re-keyed in TICKET-003 of this worktree.

### 3. Collision awareness

The mapping table was designed to avoid collisions. As a sanity check, verify the new canonical IDs don't collide with tracked stablecoins:
- `grep -c '"ust-terra"' shared/lib/stablecoins.ts` returns 0
- `grep -c '"iron-iron-finance"' shared/lib/stablecoins.ts` returns 0

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep '"iron-finance"' shared/lib/shadow-stablecoins.ts` returns 0 (replaced with canonical)
- `grep '[^a-zA-Z]id: "3"' shared/lib/shadow-stablecoins.ts` returns 0 (id changed to canonical; `llamaId: "3"` remains unchanged — the `[^a-zA-Z]` prefix excludes `llamaId`)
- `grep '"ust-terra"' shared/lib/shadow-stablecoins.ts` returns at least 1 match
