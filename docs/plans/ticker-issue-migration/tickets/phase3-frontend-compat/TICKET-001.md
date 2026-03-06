---
title: "Add localStorage portfolio migration for legacy IDs + re-key MAJOR_CENTRALIZED_IDS"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Migrate existing user portfolio data in `localStorage` from legacy stablecoin IDs to canonical ticker-issuer IDs on first read, and re-key `MAJOR_CENTRALIZED_IDS`.

## Task

### 1. Read the file first

**Read `src/hooks/use-portfolio.ts` fully** before making any changes. Key things to note:
- `loadFromStorage()` (line ~109) reads `localStorage.getItem("pharos:portfolio")`, parses JSON, validates shape
- `saveToStorage()` (line ~129) writes back
- `getInitialPortfolioState()` (line ~138) calls `loadFromStorage()` for the non-URL path
- `MAJOR_CENTRALIZED_IDS` (line ~240) is a `Set` of numeric ID strings

### 2. Add the migration function

Add a `migratePortfolioIds` function that resolves legacy IDs to canonical:

```ts
import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";

function migratePortfolioIds(holdings: PortfolioHolding[]): PortfolioHolding[] {
  let changed = false;
  const migrated: PortfolioHolding[] = [];
  for (const h of holdings) {
    const resolved = resolveStablecoinId(h.coinId, { allowLegacy: true });
    if (!resolved) {
      // Unknown ID — drop silently (stale/removed coin)
      changed = true;
      continue;
    }
    if (resolved.canonicalId !== h.coinId) changed = true;
    // Merge duplicates (two legacy IDs could resolve to the same canonical)
    const existing = migrated.find(m => m.coinId === resolved.canonicalId);
    if (existing) {
      existing.amount += h.amount;
    } else {
      migrated.push({ coinId: resolved.canonicalId, amount: h.amount });
    }
  }
  return changed ? migrated : holdings; // Return original ref if no changes (avoids unnecessary save)
}
```

### 3. Integrate into `loadFromStorage()`

Call the migration **inside** the existing `loadFromStorage()` function (NOT with raw `localStorage` access). After the `parsed.filter(...)` validation, add migration:

```ts
function loadFromStorage(): PortfolioHolding[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const validated = parsed.filter(
      (h): h is PortfolioHolding =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as PortfolioHolding).coinId === "string" &&
        typeof (h as PortfolioHolding).amount === "number" &&
        (h as PortfolioHolding).amount > 0,
    );
    // Migrate legacy IDs to canonical format
    const migrated = migratePortfolioIds(validated);
    if (migrated !== validated) {
      saveToStorage(migrated); // Write back migrated data immediately
    }
    return migrated;
  } catch {
    return [];
  }
}
```

This is idempotent — running on already-migrated data is a no-op (canonical IDs resolve to themselves, `changed` stays false, original reference is returned).

### 4. Re-key `MAJOR_CENTRALIZED_IDS` (line ~240)

Use the mapping table at `./DESIGN-MAPPING-TABLE.ts` (copied to the worktree root by the orchestrator). Re-key every entry:

```ts
// Before:
const MAJOR_CENTRALIZED_IDS = new Set([
  "1",   // USDT — Tether
  "2",   // USDC — Circle
  "11",  // USDP — Paxos
  ...
]);
// After:
const MAJOR_CENTRALIZED_IDS = new Set([
  "usdt-tether",   // USDT — Tether
  "usdc-circle",   // USDC — Circle
  "usdp-paxos",    // USDP — Paxos
  ...
]);
```

Translate every ID in the set using the mapping table. Keep the comments.

**This is done here** (not in P3-master-switchover TICKET-004) because this ticket already modifies `use-portfolio.ts`, avoiding merge conflicts between parallel worktrees.

## Acceptance Criteria

- `npm run build` exits 0
- `npm test` exits 0
- `grep -n 'migratePortfolioIds' src/hooks/use-portfolio.ts` shows the function defined AND called inside `loadFromStorage`
- `grep -n 'resolveStablecoinId' src/hooks/use-portfolio.ts` returns at least 1 match (import + usage)
- The migration is inside `loadFromStorage()`, not standalone localStorage access: `awk '/^function loadFromStorage/,/^}/' src/hooks/use-portfolio.ts | grep -q 'migratePortfolioIds'` — this will fail if migration is NOT integrated into the function
- `grep '"[0-9]\+"' src/hooks/use-portfolio.ts` returns 0 matches (no purely-numeric string IDs remain anywhere in the file)
- `grep -c 'usdt-tether\|usdc-circle\|usdp-paxos' src/hooks/use-portfolio.ts` returns at least 3 (MAJOR_CENTRALIZED_IDS re-keyed)
