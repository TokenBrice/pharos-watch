# Redemption Backstop Iteration 4 — Plan

**Goal:** Add drift-check for the configured-coin total and per-route-family counts in `docs/redemption-backstops.md`. Prevents silent drift when redemption backstop configs are added or removed.

**Scope:** One new function in `scripts/lib/doc-sync/checks.ts`, one import, one call wired into `runDocSyncChecks`. No production code change.

---

## Audit Context

`docs/redemption-backstops.md` lines 23-24:

```
- **Configured coins:** 147
- **Route families:** 81 `offchain-issuer`, 21 `stablecoin-redeem`, 19 `collateral-redeem`, 15 `queue-redeem`, 8 `psm-swap`, 3 `basket-redeem`
```

These numbers match the current source (verified by running a vitest count harness that imports `REDEMPTION_BACKSTOP_CONFIGS` directly). But nothing keeps them in sync. The existing guards cover:

- `scripts/check-doc-counts.mjs` — tracked, shadow, adapters, bluechip slugs, live-enabled stablecoins
- `scripts/check-doc-sync.ts` — methodology versions + many threshold constants

Neither checks redemption backstop config counts. A future PR adding or removing a config entry would silently drift the doc numbers.

The doc-sync framework (`scripts/lib/doc-sync/`) is the right home for this check because:
- It already imports from `@shared/lib/` at runtime via tsx
- It already version-checks `docs/redemption-backstops.md` (methodology-manifest.ts:19-21)
- Adding one more function is a smaller diff than extending the regex-parsing `.mjs` script, and it can import the config object directly at runtime instead of re-implementing `expandIds` expansion as a string parser

---

## Task

**Files:**
- Modify: `scripts/lib/doc-sync/checks.ts` (add import, add function, wire into runner)

### Step 1: Add import

Add this import to the top import block of `scripts/lib/doc-sync/checks.ts`:

```typescript
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstops";
```

### Step 2: Add the check function

Add the function anywhere before `runDocSyncChecks` (after the other check functions):

```typescript
function checkRedemptionBackstopsDoc(failures: Failure[]): void {
  const file = "docs/redemption-backstops.md";
  const doc = read(file);

  const familyCounts: Record<string, number> = {};
  for (const config of Object.values(REDEMPTION_BACKSTOP_CONFIGS)) {
    familyCounts[config.routeFamily] = (familyCounts[config.routeFamily] ?? 0) + 1;
  }
  const totalExpected = Object.keys(REDEMPTION_BACKSTOP_CONFIGS).length;

  const totalFound = getFirstNumberFromText(
    findLineValue(doc, /- \*\*Configured coins:\*\* (\d+)/) ?? "",
  );
  expectNumber(failures, file, "configured coins total", totalFound, totalExpected);

  const familyLine = findLineValue(doc, /- \*\*Route families:\*\* ([^\n]+)/) ?? "";
  const familyOrder = [
    "offchain-issuer",
    "stablecoin-redeem",
    "collateral-redeem",
    "queue-redeem",
    "psm-swap",
    "basket-redeem",
  ] as const;
  for (const family of familyOrder) {
    const pattern = new RegExp(`(\\d+)\\s+\`${family}\``);
    const match = familyLine.match(pattern);
    const found = match ? Number(match[1]) : null;
    expectNumber(failures, file, `${family} family count`, found, familyCounts[family] ?? 0);
  }

  const seenInDoc = new Set(
    Array.from(familyLine.matchAll(/`([a-z-]+)`/g), (m) => m[1]),
  );
  for (const family of Object.keys(familyCounts)) {
    if (!seenInDoc.has(family)) {
      failures.push({
        file,
        label: `${family} family listed in doc`,
        expected: "present",
        found: "missing",
      });
    }
  }
}
```

### Step 3: Wire into `runDocSyncChecks`

Add `checkRedemptionBackstopsDoc(failures);` to the list of calls inside `runDocSyncChecks`:

```typescript
export function runDocSyncChecks(): Failure[] {
  const failures: Failure[] = [];

  checkMethodologyVersions(failures);
  checkReportCardsDoc(failures);
  checkDepegDoc(failures);
  checkDewsDoc(failures);
  checkLiquidityDoc(failures);
  checkWorkerLimitsDoc(failures);
  checkChainsApiDoc(failures);
  checkChainsPageDoc(failures);
  checkRedemptionBackstopsDoc(failures);

  return failures;
}
```

### Step 4: Run the check

```bash
npm run check:doc-sync
```

Expected: `Doc sync check passed.`

### Step 5: Negative test

Temporarily change one number in `docs/redemption-backstops.md` (e.g., `147` → `148`), re-run `npm run check:doc-sync`, confirm it fails with a clear error. Revert.

### Step 6: Full merge gate + push

```bash
npm run test:merge-gate
git push origin main
```

---

## Self-Review

- [x] No production code change (scripts only)
- [x] Uses existing `@shared/lib/redemption-backstops` export — no API surface change
- [x] Uses existing `doc-sync` helpers (`read`, `findLineValue`, `getFirstNumberFromText`, `expectNumber`) — no new infrastructure
- [x] Covers both total AND per-family counts — catches drift at any granularity
- [x] The extra "listed in doc" guard catches the case where a new route family is added to code but forgotten in the doc
- [x] No methodology version bump (documentation guard only)
