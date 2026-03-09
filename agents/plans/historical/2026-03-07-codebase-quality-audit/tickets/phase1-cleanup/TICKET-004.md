---
title: "Default detailProvider in stablecoins.ts coin() helper"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Add `detailProvider: "defillama"` as the default in the `coin()` helper function, then remove the explicit `detailProvider: "defillama"` from all ~129 coin entries that use this default value. Keep explicit `detailProvider` only for entries using `"coingecko"` or `"commodity"`.

## Context

`shared/lib/stablecoins.ts` has 148 stablecoin entries. 129 of them explicitly set `detailProvider: "defillama"` which is the overwhelmingly common case. The `coin()` helper function builds the entry — adding a default there eliminates 129 lines of redundant property declarations.

## Task

### 1. Update the `coin()` helper function

In **`shared/lib/stablecoins.ts`**, find the `coin()` function (near line ~36). It builds a `StablecoinMeta` object. Add `detailProvider: "defillama"` as the default, allowing callers to override:

```ts
// Before (conceptual):
function coin(input: CoinInput): StablecoinMeta {
  return {
    detailProvider: input.detailProvider,
    // ... other fields
  };
}

// After:
function coin(input: CoinInput): StablecoinMeta {
  return {
    detailProvider: input.detailProvider ?? "defillama",
    // ... other fields
  };
}
```

Read the actual function to understand its structure before modifying.

### 2. Remove redundant `detailProvider: "defillama"` from coin entries

Search for all occurrences of `detailProvider: "defillama"` in the file and remove them. These are the ~129 entries using the default value.

**DO NOT** remove `detailProvider` from entries using `"coingecko"` or `"commodity"` — those are intentional overrides that must remain.

### 3. Verify non-default entries are preserved

After cleanup, verify that entries with `detailProvider: "coingecko"` and `detailProvider: "commodity"` still exist and are unchanged. The audit found these start around lines 3146 and 3375.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -c 'detailProvider.*defillama' shared/lib/stablecoins.ts` returns at most 2 (the default in coin() + possibly a comment)
- `grep -c 'detailProvider.*coingecko' shared/lib/stablecoins.ts` returns the same count as before (verify >0)
- `grep -c 'detailProvider.*commodity' shared/lib/stablecoins.ts` returns the same count as before (verify >0)
- The coin() function has `?? "defillama"` or equivalent defaulting logic
