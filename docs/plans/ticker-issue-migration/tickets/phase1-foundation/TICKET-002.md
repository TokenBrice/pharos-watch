---
title: "Create stablecoin-id-registry.ts with lookup maps and resolver"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Prerequisites

- TICKET-001 must be completed first (adds `llamaId` and `detailProvider` fields to `StablecoinMeta`)

## Goal

Create a centralized registry module that builds lookup maps from all stablecoin lists and provides ID resolution functions for the migration.

## Task

1. **Create `shared/lib/stablecoin-id-registry.ts`** with the following exports:

2. **Lookup maps** (built at import time from the three master lists):
   ```ts
   import { TRACKED_STABLECOINS } from "./stablecoins";
   import { SHADOW_STABLECOINS } from "./shadow-stablecoins";
   import { DEAD_STABLECOINS } from "./dead-stablecoins";
   import type { StablecoinMeta } from "../types";
   ```
   - Combine `TRACKED_STABLECOINS`, `SHADOW_STABLECOINS` into one `StablecoinMeta[]` array called `ALL_LIVE_COINS`. (Dead stablecoins use the `DeadStablecoin` type which has no `id` field and different required fields — they cannot be added to `REGISTRY_BY_ID`. Track their `llamaId` separately.)
   - `export const REGISTRY_BY_ID: Map<string, StablecoinMeta>` -- keyed by `meta.id`
   - `export const REGISTRY_BY_LLAMA_ID: Map<string, StablecoinMeta>` -- keyed by `meta.llamaId` when present (skip entries without `llamaId`)
   - `export const REGISTRY_BY_GECKO_ID: Map<string, StablecoinMeta>` -- keyed by `meta.geckoId` when present
   - `export const REGISTRY_BY_CMC_SLUG: Map<string, StablecoinMeta>` -- keyed by `meta.cmcSlug` when present
   - Also build `DEAD_BY_LLAMA_ID: Map<string, string>` mapping `dead.llamaId` to `dead.name` when `llamaId` is present (skip entries without `llamaId`) — for legacy resolution awareness, not full lookup

3. **Build-time assertions** (run at module load):
   - Assert no duplicate keys in `REGISTRY_BY_ID` (throw if `map.has(id)` before set)
   - Assert no duplicate keys in `REGISTRY_BY_LLAMA_ID` (throw if `map.has(llamaId)` before set)
   - Assert no `llamaId` collides with a DIFFERENT coin's canonical `id` in `REGISTRY_BY_ID` (this would cause ambiguity). Iterate `REGISTRY_BY_LLAMA_ID` keys; for each, check if `REGISTRY_BY_ID` has that key AND it's a different coin. A coin whose `llamaId` equals its own `id` is fine — that means the canonical ID IS the DL ID.

4. **External ID provider type and general-purpose resolver:**

   This registry is the **single place** anything in the codebase should go to resolve an external provider ID to a canonical entry. The per-provider maps above are the backing store; `resolveByExternalId` is the unified API for all "I have an ID from provider X" lookups.

   ```ts
   /** Supported external ID providers. Add new providers here as they are integrated. */
   export type ExternalIdProvider = "defillama" | "coingecko" | "cmc";

   /**
    * Resolve an external provider ID to a canonical StablecoinMeta.
    * Use this instead of ad-hoc geckoId/cmcSlug matching scattered in code.
    *
    * @example resolveByExternalId("defillama", "1") → meta for usdt-tether
    * @example resolveByExternalId("coingecko", "tether") → meta for usdt-tether
    */
   export function resolveByExternalId(
     provider: ExternalIdProvider,
     externalId: string
   ): StablecoinMeta | null {
     switch (provider) {
       case "defillama": return REGISTRY_BY_LLAMA_ID.get(externalId) ?? null;
       case "coingecko": return REGISTRY_BY_GECKO_ID.get(externalId) ?? null;
       case "cmc":       return REGISTRY_BY_CMC_SLUG.get(externalId) ?? null;
     }
   }
   ```

   When a new external data source is added in the future, the steps are:
   1. Add an optional field to `StablecoinMeta` (e.g., `dexScreenerId?: string`)
   2. Add a `REGISTRY_BY_XXX` map in this file (3 lines)
   3. Add the provider to `ExternalIdProvider` and the `switch` in `resolveByExternalId`
   4. Populate the field on relevant entries in `stablecoins.ts`

5. **Legacy resolver function (for the migration transition period):**
   ```ts
   export function resolveStablecoinId(
     input: string,
     opts?: { allowLegacy?: boolean }
   ): { canonicalId: string; matchedBy: "canonical" | "llama" } | null
   ```
   - First: check `REGISTRY_BY_ID.has(input)` -- return `{ canonicalId: input, matchedBy: "canonical" }`
   - If `opts?.allowLegacy` is true: check `REGISTRY_BY_LLAMA_ID.has(input)` -- return `{ canonicalId: meta.id, matchedBy: "llama" }`
   - Otherwise return `null`

   Note: the design doc includes `"alias"` in the matchedBy union. This is deferred to a later phase when alias maps are introduced. Phase 1 only needs `"canonical"` and `"llama"`.

6. **Helper function:**
   ```ts
   export function getLlamaId(canonicalId: string): string | null
   ```
   - Look up `REGISTRY_BY_ID.get(canonicalId)` and return `meta.llamaId ?? null`

## Import Convention

The project alias is `@shared/*` → `shared/*`. All code importing this module must use:
```ts
import { ... } from "@shared/lib/stablecoin-id-registry";
```
NOT `@shared/stablecoin-id-registry` (missing `/lib/`). See existing imports like `@shared/lib/stablecoins` for the pattern.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- File exists at `shared/lib/stablecoin-id-registry.ts`
- `grep -c 'REGISTRY_BY_ID' shared/lib/stablecoin-id-registry.ts` returns at least 3
- `grep -c 'REGISTRY_BY_CMC_SLUG' shared/lib/stablecoin-id-registry.ts` returns at least 2
- `grep -c 'resolveByExternalId' shared/lib/stablecoin-id-registry.ts` returns at least 2 (declaration + export)
- `grep -c 'resolveStablecoinId' shared/lib/stablecoin-id-registry.ts` returns at least 2
- `grep -c 'ExternalIdProvider' shared/lib/stablecoin-id-registry.ts` returns at least 2 (type + usage)
- Module can be imported without errors (no duplicate-key assertion failures -- at this point no `llamaId` values are populated yet, so `REGISTRY_BY_LLAMA_ID` will be empty, which is fine)
