---
title: "Add llamaId and detailProvider fields to StablecoinMeta type"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Extend the `StablecoinMeta` interface and the `coin()` helper with two new optional fields (`llamaId`, `detailProvider`) that decouple internal IDs from external data-provider IDs.

## Task

1. **`shared/types/index.ts`** (line ~108-135, `StablecoinMeta` interface):
   - After line 109 (`id: string;`), add:
     ```ts
     /** DefiLlama numeric stablecoin ID (for API calls to stablecoins.llama.fi) */
     llamaId?: string;
     /** Data provider for detail page fetching -- replaces id-prefix heuristics */
     detailProvider?: "defillama" | "coingecko" | "commodity";
     ```
   - Update the inline comment on `id` from `// DefiLlama numeric ID` to `// Stablecoin ID (canonical ticker-issuer format in future; currently legacy)`

2. **`shared/types/index.ts`** (line ~71, `DependencyWeight.id`):
   - Change the inline comment from `// DefiLlama ID of upstream stablecoin` to `// Stablecoin ID (canonical ticker-issuer format in future; currently legacy)`

3. **`shared/types/index.ts`** (line ~82, `ReserveSlice.coinId`):
   - Change the inline comment from `// DefiLlama ID of a tracked stablecoin (links to dependency graph)` to `// Stablecoin ID (canonical ticker-issuer format in future; currently legacy) — links to dependency graph`

4. **`shared/lib/stablecoins.ts`** (line ~4-30, `StablecoinOpts` interface):
   - Add two new optional fields to the interface:
     ```ts
     llamaId?: string;
     detailProvider?: "defillama" | "coingecko" | "commodity";
     ```

5. **`shared/lib/stablecoins.ts`** (line ~32-33, `coin()` function):
   - In the returned object literal, add pass-through for both fields:
     ```ts
     llamaId: opts?.llamaId, detailProvider: opts?.detailProvider,
     ```

## Acceptance Criteria

- `npm run build` exits 0 (frontend type-check + build)
- `cd worker && npx tsc --noEmit` exits 0 (worker type-check)
- `npm test` exits 0 (no regressions)
- `grep -c 'llamaId' shared/types/index.ts` returns at least 2 (DeadStablecoin existing + new StablecoinMeta field)
- `grep -c 'detailProvider' shared/types/index.ts` returns at least 1
- `grep 'llamaId' shared/lib/stablecoins.ts` shows the field in both `StablecoinOpts` and `coin()`
