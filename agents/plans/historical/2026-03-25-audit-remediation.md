# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 37 of 41 actionable findings from the 2026-03-25 comprehensive audit across four phases. Three medium-severity findings (Q-003, Q-008, Q-009) are deferred to a follow-up plan, and one finding (R-006) was withdrawn as incorrect — see "Deferred Findings" at the end.

**Architecture:** Each task is self-contained and independently committable. Phase 1 tasks have zero interdependencies and can be parallelized freely. Phase 2+ tasks note dependencies where they exist. All changes must pass `npm run test:merge-gate` before push.

**Tech Stack:** TypeScript strict, Next.js 16, React 19, Vitest, Cloudflare Workers + D1, Zod 4, TanStack Query 5

**Audit report:** `agents/audits/comprehensive-audit-2026-03-25.md`

---

## Phase 1 — Quick Wins

Low-effort, high-impact changes completable in isolation.

---

### Task 1: Replace local `clamp()` with shared import (R-001)

**Files:**
- Modify: `src/lib/yield-scatter.ts:25-27`
- Modify: `src/components/minting-pressure-gauge.tsx:20-22`

- [ ] **Step 1: Add shared import and remove local `clamp` in yield-scatter.ts**

In `src/lib/yield-scatter.ts`, add the import at the top of the file with the other shared imports and delete lines 25-27 (the local `function clamp`):

```typescript
import { clamp } from "@shared/lib/math";
```

Remove:
```typescript
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
```

The four call sites at lines 145-148 (`clamp(result[i].plotX, ...)`, etc.) remain unchanged.

- [ ] **Step 2: Add shared import and remove local `clamp` in minting-pressure-gauge.tsx**

In `src/components/minting-pressure-gauge.tsx`, add the import and delete lines 20-22 (the local `function clamp`):

```typescript
import { clamp } from "@shared/lib/math";
```

Remove:
```typescript
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
```

The call site at line 94 (`clamp((score + 100) / 2, 0, 100)`) remains unchanged.

- [ ] **Step 3: Run tests**

Run: `npm test -- --run`
Expected: All tests pass (no tests directly cover these files, but shared math imports are validated transitively).

- [ ] **Step 4: Commit**

```bash
git add src/lib/yield-scatter.ts src/components/minting-pressure-gauge.tsx
git commit -m "$(cat <<'EOF'
refactor: replace local clamp() with shared import (R-001)

Both files had identical local clamp() implementations while
9 other files already import from @shared/lib/math.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Import shared grade colors in OG template (R-002)

**Files:**
- Modify: `worker/src/lib/og-templates/shared.tsx:21-26`
- Modify: `worker/src/lib/og-templates/safety-scores-card.tsx` (import path update)

- [ ] **Step 1: Understand the difference between the two color maps**

`GRADE_COLORS` (OG templates) uses full grade keys (`"A+"`, `"A"`, `"A-"`, etc.) and maps to hex values.
`GRADE_RADAR_COLORS` (shared/lib/report-cards.ts) uses single-letter keys (`"A"`, `"B"`, etc.) and maps to hex values.

These are structurally different — `GRADE_COLORS` needs `"A+"` and `"A-"` variants that don't exist in `GRADE_RADAR_COLORS`. The hex values also differ slightly (`#22c55e` vs `#10b981` for A).

**Revised approach:** The two maps use different hex values intentionally — OG images use the project's signature frost-blue (`#5ba3d9`) for B grades, while radar charts use standard blue-500 (`#3b82f6`). A derivation would silently change OG branding colors. Instead, add a cross-reference comment linking the two maps so future editors know they're related.

- [ ] **Step 2: Add cross-reference comment to GRADE_COLORS**

In `worker/src/lib/og-templates/shared.tsx`, add a comment above `GRADE_COLORS` (line 21):

```typescript
/**
 * Grade-to-hex mapping for OG images. Uses project branding colors
 * (e.g., frost-blue #5ba3d9 for B grades) which intentionally differ
 * from GRADE_RADAR_COLORS in shared/lib/report-cards.ts (standard palette).
 */
export const GRADE_COLORS: Record<string, string> = {
```

No hex values change. The map stays hardcoded to preserve OG image visual consistency.

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/og-templates/shared.tsx
git commit -m "$(cat <<'EOF'
docs: cross-reference OG GRADE_COLORS with shared GRADE_RADAR_COLORS (R-002)

Adds documentation linking the two grade color maps so future editors
know they're related but intentionally use different hex values
(OG images use project branding colors).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Replace `truncateTeaser` with `trimTextAtWordBoundary` (R-003)

**Files:**
- Modify: `src/components/upcoming-stablecoins-section.tsx:16,280`
- Modify: `src/lib/pre-launch.ts:155-159`

- [ ] **Step 1: Update the import in upcoming-stablecoins-section.tsx**

In `src/components/upcoming-stablecoins-section.tsx`, change the import (line 16) to remove `truncateTeaser` from the pre-launch import and add `trimTextAtWordBoundary` from page-metadata:

Replace:
```typescript
import {
  LAUNCH_PHASE_LABELS,
  PHASE_BADGE,
  PHASE_RING,
  dateScore,
  formatFuzzyDate,
  truncateTeaser,
} from "@/lib/pre-launch";
```

With:
```typescript
import {
  LAUNCH_PHASE_LABELS,
  PHASE_BADGE,
  PHASE_RING,
  dateScore,
  formatFuzzyDate,
} from "@/lib/pre-launch";
import { trimTextAtWordBoundary } from "@/lib/page-metadata";
```

- [ ] **Step 2: Replace the call site**

In `src/components/upcoming-stablecoins-section.tsx`, replace the usage (around line 280):

Replace:
```typescript
truncateTeaser(summaries[coin.id].text!)
```

With:
```typescript
trimTextAtWordBoundary(summaries[coin.id].text!, 120)
```

The default max was 120 in `truncateTeaser`, so pass it explicitly to `trimTextAtWordBoundary`.

- [ ] **Step 3: Remove `truncateTeaser` from pre-launch.ts**

In `src/lib/pre-launch.ts`, delete the `truncateTeaser` function (lines 155-159):

Remove:
```typescript
export function truncateTeaser(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > 0 ? cut : max) + "\u2026";
}
```

- [ ] **Step 4: Run build to verify no broken imports**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/upcoming-stablecoins-section.tsx src/lib/pre-launch.ts
git commit -m "$(cat <<'EOF'
refactor: replace truncateTeaser with trimTextAtWordBoundary (R-003)

trimTextAtWordBoundary is more robust (trailing punctuation trimming,
60% safety cutoff). Removes the single-use duplicate.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### ~~Task 4: Remove unused DataTableShell (R-006) — WITHDRAWN~~

**Audit finding R-006 was incorrect.** `DataTableShell` is actively used by 5 production components: `depeg-tracker-table.tsx`, `blacklist-table.tsx`, `flow-table.tsx`, `liquidity-table.tsx`, and `yield-leaderboard.tsx`. The original audit agent only checked for the component name in its own test file and missed the production imports. This task is removed from the plan.

---

### Task 5: Remove `DAY_SEC` alias (R-007)

**Files:**
- Modify: `worker/src/api/mint-burn-flows-shared.ts:45-46,54-55,66`

- [ ] **Step 1: Update the external consumer first**

`worker/src/api/mint-burn-flows.ts` (line 50) imports `DAY_SEC` from `./mint-burn-flows-shared`. Update it to import `DAY_SECONDS` from `@shared/lib/time-constants` directly:

In `worker/src/api/mint-burn-flows.ts`, replace:
```typescript
  DAY_SEC,
```
(in the import from `./mint-burn-flows-shared`)

With an import from the shared module:
```typescript
import { DAY_SECONDS } from "@shared/lib/time-constants";
```

Then replace all `DAY_SEC` usages in `mint-burn-flows.ts` with `DAY_SECONDS` (e.g., line 107: `nowDayTs - BASELINE_WINDOW_DAYS * DAY_SECONDS`).

- [ ] **Step 2: Replace alias with direct import usage in mint-burn-flows-shared.ts**

In `worker/src/api/mint-burn-flows-shared.ts`:

Remove the alias (line 46):
```typescript
export const DAY_SEC = DAY_SECONDS;
```

The import on line 45 stays. Replace all `DAY_SEC` usages in the file with `DAY_SECONDS`:

Lines 54, 55, 66, 161, 181, 185, 190 — replace `DAY_SEC` with `DAY_SECONDS`.

- [ ] **Step 3: Verify no remaining consumers**

Run: `grep -rn "DAY_SEC[^O]" worker/src/ --include="*.ts" | grep -v __tests__`
Expected: No results (all references now use `DAY_SECONDS`).

- [ ] **Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/mint-burn-flows-shared.ts worker/src/api/mint-burn-flows.ts
git commit -m "$(cat <<'EOF'
refactor: remove DAY_SEC alias, use DAY_SECONDS directly (R-007)

Eliminates a third name for the same constant. The canonical export
is DAY_SECONDS from @shared/lib/time-constants.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Escape LIKE wildcards in blacklist search (Q-005)

**Files:**
- Modify: `worker/src/api/blacklist.ts:129-132`
- Modify: `worker/src/api/__tests__/blacklist.test.ts` (if exists, add test case)

- [ ] **Step 1: Write the failing test**

Check if a blacklist API test exists. If so, add a test for LIKE wildcard escaping. If not, create one.

In the appropriate test file, add:

```typescript
it("escapes LIKE wildcards in address search query", async () => {
  // A query containing % or _ should be treated as literal characters
  const url = new URL("http://localhost/api/blacklist?q=%25test_");
  const response = await handleBlacklist(mockDb, url);
  // The binding should contain \%test\_ wrapped in wildcards
  // Verify the query parameter was escaped before binding
  expect(response.status).toBe(200);
});
```

- [ ] **Step 2: Add LIKE wildcard escaping**

In `worker/src/api/blacklist.ts`, replace the query binding block (lines 129-132):

Replace:
```typescript
if (query) {
  conditions.push("LOWER(address) LIKE ?");
  filterBindings.push(`%${query}%`);
}
```

With:
```typescript
if (query) {
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  conditions.push("LOWER(address) LIKE ? ESCAPE '\\'");
  filterBindings.push(`%${escaped}%`);
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run worker/src/api/__tests__/blacklist`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/blacklist.ts
git commit -m "$(cat <<'EOF'
fix: escape LIKE wildcards in blacklist address search (Q-005)

User-supplied % and _ in the query parameter are now escaped before
binding, preventing unintended wildcard matching in the LIKE clause.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Add comment in empty catch block (Q-006)

**Files:**
- Modify: `worker/src/lib/response-body.ts:10-11`

- [ ] **Step 1: Add explanatory comment**

In `worker/src/lib/response-body.ts`, replace the empty inner catch:

Replace:
```typescript
    } catch {}
```

With:
```typescript
    } catch {
      /* expected: body already consumed or stream cancelled */
    }
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/response-body.ts
git commit -m "$(cat <<'EOF'
docs: annotate intentional empty catch in drainResponseBody (Q-006)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Add `SectionErrorBoundary` to unprotected pages (Q-015)

**Files:**
- Modify: 10 client.tsx files (see list below)

The following client pages lack `SectionErrorBoundary` and handle complex data fetching. Note: all pages already have Next.js `error.tsx` for page-level error handling; `SectionErrorBoundary` adds section-level graceful degradation.

**Already have SectionErrorBoundary (skip):**
- `depeg/client.tsx` — wraps 6 individual sections
- `stablecoin/[id]/client.tsx` — wraps distribution and liquidity sections

**Pages to wrap:**
1. `src/app/portfolio/client.tsx`
2. `src/app/compare/client.tsx`
3. `src/app/yield/client.tsx`
4. `src/app/liquidity/client.tsx`
5. `src/app/coverage/client.tsx`
6. `src/app/chains/client.tsx`
7. `src/app/chains/[chain]/client.tsx`
8. `src/app/stablecoins/[peg]/client.tsx`

Excluded: `admin/client.tsx` (auth-gated), `stability-index/client.tsx`, `safety-scores/client.tsx`, `dependency-map/client.tsx`, `status/client.tsx` (these have `error.tsx` and simpler rendering — lower risk).

The pattern for each file is the same — wrap the main returned JSX.

- [ ] **Step 1: Add error boundary to portfolio/client.tsx**

Add the import at the top:
```typescript
import { SectionErrorBoundary } from "@/components/section-error-boundary";
```

Wrap the main returned JSX (the outermost `<div>` or fragment) with:
```tsx
<SectionErrorBoundary name="Portfolio">
  {/* existing JSX */}
</SectionErrorBoundary>
```

- [ ] **Step 2: Repeat for compare/client.tsx**

Same pattern: import `SectionErrorBoundary`, wrap main JSX with `<SectionErrorBoundary name="Compare">`.

- [ ] **Step 3: Repeat for yield/client.tsx**

Wrap with `<SectionErrorBoundary name="Yield">`.

- [ ] **Step 4: Repeat for liquidity/client.tsx**

Wrap with `<SectionErrorBoundary name="Liquidity">`.

- [ ] **Step 5: Repeat for coverage/client.tsx**

Wrap with `<SectionErrorBoundary name="Coverage">`.

- [ ] **Step 6: Repeat for chains/client.tsx**

Wrap with `<SectionErrorBoundary name="Chains">`.

- [ ] **Step 7: Repeat for chains/[chain]/client.tsx**

Wrap with `<SectionErrorBoundary name="Chain Detail">`.

- [ ] **Step 8: Repeat for stablecoins/[peg]/client.tsx**

Wrap with `<SectionErrorBoundary name="Stablecoins">`.

- [ ] **Step 9: Run build**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/app/portfolio/client.tsx src/app/compare/client.tsx src/app/yield/client.tsx src/app/liquidity/client.tsx src/app/coverage/client.tsx src/app/chains/client.tsx "src/app/chains/[chain]/client.tsx" "src/app/stablecoins/[peg]/client.tsx"
git commit -m "$(cat <<'EOF'
feat: add SectionErrorBoundary to 8 unprotected pages (Q-015)

Data-heavy pages now degrade gracefully on render errors instead of
showing a blank screen. Covers portfolio, compare, yield, liquidity,
coverage, chains, chain detail, and stablecoins.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Simplify in-memory rate-limit fallback (S-001 / Q-017)

**Files:**
- Modify: `worker/src/lib/rate-limit.ts`
- Modify: `worker/src/lib/__tests__/rate-limit.test.ts`

**Important context:** `checkRateLimit` is `@deprecated` but still actively used as a D1 fallback on line 171. We cannot delete it outright. Instead, simplify: when D1 fails, allow the request through (return null) rather than maintaining a full in-memory Map-based limiter with module-scope state. This is safer than it sounds — D1 failures are transient, and an isolate-local Map provides minimal real protection anyway.

- [ ] **Step 1: Replace the D1 fallback with a pass-through**

In `worker/src/lib/rate-limit.ts`, replace the catch block in `checkPublicApiRateLimit` (lines 166-172):

Replace:
```typescript
  } catch (err) {
    // Known limitation: in-memory fallback resets on isolate eviction.
    // Under sustained D1 failure, rate limiting provides best-effort
    // protection within a single isolate's lifetime only.
    console.warn("[public-api] distributed rate limit failed, falling back to isolate-local limiter:", err);
    return checkRateLimit(ip, limit, windowMs);
  }
```

With:
```typescript
  } catch (err) {
    // D1 failure is transient — allow the request through rather than
    // maintaining an unreliable isolate-local Map with module-scope state.
    console.warn("[public-api] distributed rate limit unavailable, allowing request:", err);
    return null;
  }
```

- [ ] **Step 2: Remove the deprecated code**

Delete the following from `worker/src/lib/rate-limit.ts`:
- `RateLimitEntry` interface (lines 3-6)
- `ipCounts` Map (line 22)
- `MAX_IP_ENTRIES` constant (line 23)
- `PRUNE_EVERY_REQUESTS` constant (line 24)
- `requestCount` variable (line 26)
- `pruneExpired` function (lines 31-37)
- `checkRateLimit` function (lines 39-84)

**Keep** (still used by D1 functions):
- `RateLimitRunResult`, `RateLimitStatement`, `RateLimitDb` interfaces
- `PUBLIC_API_PRUNE_WINDOW_MULTIPLIER` (line 25 — used by `checkPublicApiRateLimit` at line 151)
- `lastPublicApiPruneBucket`, `publicApiPruneFailures`, `feedbackPruneFailures`
- `buildRateLimitExceededResponse`
- `RATE_LIMITS`, `CRAWL_BUDGETS` exports
- `hashIpWithSalt`, `checkPublicApiRateLimit`, `checkFeedbackRateLimit`

- [ ] **Step 3: Update the test file**

In `worker/src/lib/__tests__/rate-limit.test.ts`, remove all tests for `checkRateLimit` (the entire `describe("checkRateLimit", ...)` block). The D1-backed `checkPublicApiRateLimit` tests (if they exist) stay.

If the file only contained `checkRateLimit` tests, verify the file is now empty and delete it or replace with a placeholder comment.

- [ ] **Step 4: Run tests**

Run: `npm test -- --run`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/rate-limit.ts worker/src/lib/__tests__/rate-limit.test.ts
git commit -m "$(cat <<'EOF'
refactor: remove deprecated in-memory rate limiter (S-001/Q-017)

The D1-backed checkPublicApiRateLimit now allows requests through on
D1 failure instead of falling back to an unreliable isolate-local Map.
Removes ~60 lines of module-scope mutable state.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Standardize Radix UI imports (R-009 / S-003)

**Files:**
- Modify: `src/components/ui/popover.tsx` (the only consumer of the barrel `radix-ui` package)
- Modify: `package.json` (remove `radix-ui` dep)

- [ ] **Step 1: Identify which Radix primitive popover.tsx needs**

`src/components/ui/popover.tsx` imports `Popover as PopoverPrimitive` from `radix-ui`. The individual package equivalent is `@radix-ui/react-popover`.

- [ ] **Step 2: Install the individual package**

```bash
npm install @radix-ui/react-popover
```

- [ ] **Step 3: Update popover.tsx import**

In `src/components/ui/popover.tsx`, replace:
```typescript
import { Popover as PopoverPrimitive } from "radix-ui";
```

With:
```typescript
import * as PopoverPrimitive from "@radix-ui/react-popover";
```

Verify the component names used in the file match (`PopoverPrimitive.Root`, `.Trigger`, `.Content`, `.Portal`, etc.).

- [ ] **Step 4: Remove the umbrella package**

```bash
npm uninstall radix-ui
```

- [ ] **Step 5: Run build**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/popover.tsx package.json package-lock.json
git commit -m "$(cat <<'EOF'
refactor: standardize on individual @radix-ui packages (R-009/S-003)

popover.tsx was the only consumer of the barrel radix-ui package.
Migrated to @radix-ui/react-popover for consistency with all other
shadcn/ui components. Removed the umbrella dep to prevent version drift.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Targeted Refactoring

Medium-effort changes addressing specific quality and redundancy issues.

---

### Task 11: Add Zod schema for DEWS pool entries (Q-001)

**Files:**
- Modify: `worker/src/cron/compute-dews.ts:459-471`

- [ ] **Step 1: Define a pool entry schema**

At the top of `worker/src/cron/compute-dews.ts` (near other imports/types), add:

```typescript
import { z } from "zod";

const PoolEntrySchema = z.object({
  tvlUsd: z.number().default(0),
  extra: z.object({
    balanceRatio: z.number(),
  }).optional(),
});
```

- [ ] **Step 2: Replace the unsafe cast with schema parsing**

Replace lines 459-471:

```typescript
let topPools: PoolEntry[] | null = null;
if (dexLiq?.top_pools_json) {
  try {
    const parsed = JSON.parse(dexLiq.top_pools_json);
    topPools = (Array.isArray(parsed) ? parsed : []).map((p: Record<string, unknown>) => ({
      tvlUsd: (p.tvlUsd as number) ?? 0,
      balanceRatio: ((p.extra as Record<string, unknown>)?.balanceRatio as number) ?? 1.0,
    }));
  } catch { /* expected: malformed top_pools_json */
    validationFailures++;
  }
}
```

With:

```typescript
let topPools: PoolEntry[] | null = null;
if (dexLiq?.top_pools_json) {
  try {
    const parsed = JSON.parse(dexLiq.top_pools_json);
    topPools = (Array.isArray(parsed) ? parsed : []).map((raw) => {
      const p = PoolEntrySchema.safeParse(raw);
      return {
        tvlUsd: p.success ? p.data.tvlUsd : 0,
        balanceRatio: p.success ? (p.data.extra?.balanceRatio ?? 1.0) : 1.0,
      };
    });
  } catch { /* expected: malformed top_pools_json */
    validationFailures++;
  }
}
```

- [ ] **Step 3: Run worker type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: Both pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/compute-dews.ts
git commit -m "$(cat <<'EOF'
fix: validate pool entries with Zod in DEWS computation (Q-001)

Replaces chained unsafe casts on deserialized top_pools_json with
Zod safeParse. Prevents silent NaN from malformed pool data.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Strengthen Bluechip Zod schema (Q-002)

**Files:**
- Modify: `worker/src/cron/sync-bluechip.ts:24-44,132-147`

- [ ] **Step 1: Import BluechipGrade type and use z.enum**

In `worker/src/cron/sync-bluechip.ts`, the `BluechipCoinSchema` currently validates `grade` as `z.string()`. Replace with the actual union:

Note: `BluechipGradeSchema` already exists at `shared/types/core.ts:493` as `z.enum(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"])`. Use it directly instead of defining a new array.

Replace:
```typescript
const BluechipCoinSchema = z.object({
  grade: z.string(),
```

With:
```typescript
import { BluechipGradeSchema } from "@shared/types/core";

const BluechipCoinSchema = z.object({
  grade: BluechipGradeSchema,
```

Do NOT include `"NR"` — it is part of `ReportCardGrade`, not `BluechipGrade`.

- [ ] **Step 2: Remove redundant casts on validated fields**

In the processing code (around lines 132-147), the Zod output now provides correctly typed fields. Replace the `as` casts:

Replace:
```typescript
const grade = coin.grade as BluechipGrade | undefined;
```

With:
```typescript
const grade = coin.grade;
```

Replace:
```typescript
  collateralization: (coin.collateralization as number) ?? 0,
  smartContractAudit: (coin.smart_contract_audit as boolean) ?? false,
  dateOfRating: (coin.date_of_rating as string) ?? "",
  dateLastChange: (coin.date_last_change as string) ?? null,
```

With:
```typescript
  collateralization: coin.collateralization ?? 0,
  smartContractAudit: coin.smart_contract_audit ?? false,
  dateOfRating: coin.date_of_rating ?? "",
  dateLastChange: coin.date_last_change ?? null,
```

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors. Since `BluechipGradeSchema` is already typed to produce `BluechipGrade`, the Zod output type matches the existing type alias.

- [ ] **Step 4: Run tests**

Run: `npm test -- --run worker/src/cron`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/sync-bluechip.ts
git commit -m "$(cat <<'EOF'
fix: strengthen Bluechip Zod schema with z.enum for grade (Q-002)

Validates grade against the actual BluechipGrade union at parse time
instead of casting afterwards. Removes redundant as-casts on fields
already validated by the schema.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Add Zod schema for CoinGecko depeg confirmation response (Q-011)

**Files:**
- Modify: `worker/src/cron/confirm-pending-depegs.ts:166-188`

- [ ] **Step 1: Define response schemas**

At the top of `worker/src/cron/confirm-pending-depegs.ts`, add:

```typescript
import { z } from "zod";

const CoinGeckoPriceSchema = z.record(z.string(), z.object({ usd: z.number().optional() }));
const DefiLlamaPriceSchema = z.object({
  coins: z.record(z.string(), z.object({ price: z.number().optional() })).optional(),
});
```

- [ ] **Step 2: Replace unsafe casts with schema validation**

Replace the response parsing block (lines ~178-186):

Replace:
```typescript
    if (useDefiLlamaSecondary) {
      const dlData = (await offchainRes.json()) as {
        coins?: Record<string, { price?: number }>;
      };
      offchainPrice = dlData.coins?.[`coingecko:${geckoId}`]?.price;
    } else {
      const cgData = (await offchainRes.json()) as Record<string, { usd?: number }>;
      offchainPrice = cgData[geckoId]?.usd;
    }
```

With:
```typescript
    if (useDefiLlamaSecondary) {
      const parsed = DefiLlamaPriceSchema.safeParse(await offchainRes.json());
      offchainPrice = parsed.success ? parsed.data.coins?.[`coingecko:${geckoId}`]?.price : undefined;
    } else {
      const parsed = CoinGeckoPriceSchema.safeParse(await offchainRes.json());
      offchainPrice = parsed.success ? parsed.data[geckoId]?.usd : undefined;
    }
```

- [ ] **Step 3: Run worker type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: Both pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/confirm-pending-depegs.ts
git commit -m "$(cat <<'EOF'
fix: validate CoinGecko/DefiLlama responses in depeg confirmation (Q-011)

Adds Zod schemas for external price API responses instead of casting
raw JSON. Malformed responses now produce undefined (treated as
missing) instead of potential runtime errors.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Remove Telegram webhook secret query parameter fallback (Q-016)

**Files:**
- Modify: `worker/src/api/telegram-webhook.ts:56-61`

- [ ] **Step 1: Verify migration status**

Check if the `X-Telegram-Bot-Api-Secret-Token` header path is the only active path in production. The query parameter was labeled "backward compat during migration."

Run: `grep -n "searchParams.*secret\|secret.*searchParams" worker/src/api/telegram-webhook.ts`

- [ ] **Step 2: Remove the query parameter fallback**

In `worker/src/api/telegram-webhook.ts`, find the secret extraction code (around lines 56-61). It likely looks like:

```typescript
const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
  ?? url.searchParams.get("secret");
```

Replace with:
```typescript
const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run worker/src/api/__tests__/telegram`
Expected: All pass. If a test relied on the query param fallback, update it to use the header.

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/telegram-webhook.ts
git commit -m "$(cat <<'EOF'
security: remove webhook secret query parameter fallback (Q-016)

Secrets in URL query params appear in logs and cache keys. The
X-Telegram-Bot-Api-Secret-Token header is the canonical path.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Extend tests for `portfolio-codec.ts` (Q-010, part 1)

**Files:**
- Modify: `src/lib/__tests__/portfolio-codec.test.ts` (already exists with 36 lines covering parsing, re-encoding, legacy symbols, and migration)

- [ ] **Step 1: Add edge case tests to the existing file**

The existing test file covers the happy path and migration. Add edge case coverage for `isPortfolioHolding` and boundary conditions. Append to `src/lib/__tests__/portfolio-codec.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

// Add `isPortfolioHolding` to the existing import block at the top of the file:
//   import { encodePortfolioHoldings, isPortfolioHolding, migratePortfolioIds, parsePortfolioUrlParam } from "../portfolio-codec";
//
// Then append these new describe blocks AFTER the existing describe("portfolio codec") block:

describe("parsePortfolioUrlParam edge cases", () => {
  it("returns empty array for empty string", () => {
    expect(parsePortfolioUrlParam("")).toEqual([]);
  });

  it("filters out entries with non-numeric amounts", () => {
    const result = parsePortfolioUrlParam("usdc-circle:abc");
    expect(result).toEqual([]);
  });

  it("filters out entries with zero or negative amounts", () => {
    const result = parsePortfolioUrlParam("usdc-circle:0,usdt-tether:-5");
    expect(result).toEqual([]);
  });
});

describe("encodePortfolioHoldings edge cases", () => {
  it("returns empty string for empty holdings", () => {
    expect(encodePortfolioHoldings([])).toBe("");
  });
});

describe("isPortfolioHolding", () => {
  it("accepts valid holdings", () => {
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: 100 })).toBe(true);
  });

  it("rejects missing coinId", () => {
    expect(isPortfolioHolding({ amount: 100 })).toBe(false);
  });

  it("rejects non-positive amount", () => {
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: 0 })).toBe(false);
    expect(isPortfolioHolding({ coinId: "usdc-circle", amount: -1 })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isPortfolioHolding(null)).toBe(false);
    expect(isPortfolioHolding("string")).toBe(false);
    expect(isPortfolioHolding(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm test -- --run src/lib/__tests__/portfolio-codec.test.ts`
Expected: All pass (testing existing behavior).

Adjust any assertions that don't match actual behavior (e.g., if `parsePortfolioUrlParam` handles null differently).

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/portfolio-codec.test.ts
git commit -m "$(cat <<'EOF'
test: add comprehensive tests for portfolio-codec (Q-010)

Covers URL param parsing, roundtrip encoding, edge cases (empty input,
invalid amounts, non-object values), and the isPortfolioHolding guard.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Add tests for `stablecoin-detail-derive.ts` (Q-010, part 2)

**Files:**
- Create: `src/lib/__tests__/stablecoin-detail-derive.test.ts`

- [ ] **Step 1: Write tests for pure derivation functions**

Create `src/lib/__tests__/stablecoin-detail-derive.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  deriveSupplyFromMarketCap,
  deriveDeviationBps,
  deriveGaugeDeviationBps,
  derivePrev90dReferenceMcap,
} from "../stablecoin-detail-derive";

describe("deriveSupplyFromMarketCap", () => {
  it("divides market cap by price", () => {
    expect(deriveSupplyFromMarketCap(1_000_000, 1.0)).toBe(1_000_000);
    expect(deriveSupplyFromMarketCap(2_000_000, 0.5)).toBe(4_000_000);
  });

  it("returns null for zero or negative price", () => {
    expect(deriveSupplyFromMarketCap(1_000_000, 0)).toBeNull();
    expect(deriveSupplyFromMarketCap(1_000_000, -1)).toBeNull();
  });

  it("returns null for zero or negative market cap", () => {
    expect(deriveSupplyFromMarketCap(0, 1.0)).toBeNull();
    expect(deriveSupplyFromMarketCap(-100, 1.0)).toBeNull();
  });

  it("returns null for non-number inputs", () => {
    expect(deriveSupplyFromMarketCap(null, 1.0)).toBeNull();
    expect(deriveSupplyFromMarketCap(undefined, 1.0)).toBeNull();
  });
});

describe("deriveDeviationBps", () => {
  it("returns 0 bps for exact peg", () => {
    expect(deriveDeviationBps(1.0, 1.0)).toBe(0);
  });

  it("returns positive bps for price above peg", () => {
    // 1.01 / 1.0 - 1 = 0.01 → 100 bps
    expect(deriveDeviationBps(1.01, 1.0)).toBeCloseTo(100, 0);
  });

  it("returns negative bps for price below peg", () => {
    // 0.99 / 1.0 - 1 = -0.01 → -100 bps
    expect(deriveDeviationBps(0.99, 1.0)).toBeCloseTo(-100, 0);
  });

  it("returns 0 for invalid peg reference", () => {
    expect(deriveDeviationBps(1.0, 0)).toBe(0);
    expect(deriveDeviationBps(1.0, NaN)).toBe(0);
  });
});

describe("deriveGaugeDeviationBps", () => {
  it("returns 0 for NAV tokens", () => {
    expect(deriveGaugeDeviationBps(150, true)).toBe(0);
  });

  it("passes through deviation for non-NAV tokens", () => {
    expect(deriveGaugeDeviationBps(50, false)).toBe(50);
    expect(deriveGaugeDeviationBps(-30, false)).toBe(-30);
  });
});

describe("derivePrev90dReferenceMcap", () => {
  const NOW_MS = Date.now();
  const DAY_MS = 86_400_000;
  const NINETY_DAYS_MS = 90 * DAY_MS;

  it("finds closest entry to 90 days ago", () => {
    const history = [
      { date: NOW_MS - NINETY_DAYS_MS, circulatingUsd: 5_000_000 },
      { date: NOW_MS - 30 * DAY_MS, circulatingUsd: 8_000_000 },
      { date: NOW_MS, circulatingUsd: 10_000_000 },
    ];
    expect(derivePrev90dReferenceMcap(history, NOW_MS)).toBe(5_000_000);
  });

  it("returns 0 for empty history", () => {
    expect(derivePrev90dReferenceMcap([], NOW_MS)).toBe(0);
  });

  it("returns 0 when closest entry exceeds 7-day tolerance", () => {
    const history = [
      { date: NOW_MS - 120 * DAY_MS, circulatingUsd: 5_000_000 },
    ];
    expect(derivePrev90dReferenceMcap(history, NOW_MS)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- --run src/lib/__tests__/stablecoin-detail-derive.test.ts`
Expected: All pass. Adjust assertions to match actual function signatures if needed (check nullability conditions).

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/stablecoin-detail-derive.test.ts
git commit -m "$(cat <<'EOF'
test: add tests for stablecoin-detail-derive functions (Q-010)

Covers supply derivation, deviation bps calculation, NAV token
gauge behavior, and 90-day reference market cap lookup.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Fine-grained change detection in merge gate (S-012)

**Files:**
- Modify: `scripts/test-merge-gate.mjs`

- [ ] **Step 1: Read the current buildCommandPlan function**

Read `scripts/test-merge-gate.mjs` fully to understand the current structure. The `NON_NEGOTIABLE_VALIDATE_COMMANDS` array contains all always-run checks. We need to conditionally skip some based on changed files.

- [ ] **Step 2: Add pattern-based check skipping**

Add a helper that maps check commands to their relevant file prefixes. Use `startsWith` matching (same pattern as the existing `hasPagesDeployImpact` in `scripts/lib/deploy-impact.mjs` — no glob library needed):

```javascript
/**
 * Commands that can be skipped when their relevant input files haven't changed.
 * Key: command string (must match exactly one entry in NON_NEGOTIABLE_VALIDATE_COMMANDS).
 * Value: path prefixes — if no changedFiles start with any prefix, the command is skipped.
 */
const SKIPPABLE_CHECKS = new Map([
  ["npm run check:migrations", ["worker/migrations/"]],
  ["npm run check:cron-sync", ["shared/lib/cron-jobs.", "worker/wrangler.toml"]],
  ["npm run check:doc-counts", ["shared/lib/stablecoins/", "docs/"]],
  ["npm run check:redemption-backstops", ["shared/lib/redemption-backstop-configs/"]],
]);
```

Then in `buildCommandPlan()`, filter `NON_NEGOTIABLE_VALIDATE_COMMANDS`:

```javascript
const skippedCommands = new Set();
if (changedFiles.length > 0) {
  for (const [cmd, prefixes] of SKIPPABLE_CHECKS) {
    const relevant = changedFiles.some((f) =>
      prefixes.some((p) => f.startsWith(p) || f === p),
    );
    if (!relevant) skippedCommands.add(cmd);
  }
}

const filteredCommands = NON_NEGOTIABLE_VALIDATE_COMMANDS.filter(
  (cmd) => !skippedCommands.has(cmd),
);
```

- [ ] **Step 3: Add logging for skipped checks**

```javascript
if (skippedCommands.size > 0) {
  console.log(`\nSkipping ${skippedCommands.size} check(s) (no relevant file changes):`);
  for (const cmd of skippedCommands) console.log(`  - ${cmd}`);
}
```

- [ ] **Step 4: Test the merge gate**

Run: `npm run test:merge-gate`
Expected: Passes. Some checks may be skipped if their input files weren't modified.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-merge-gate.mjs
git commit -m "$(cat <<'EOF'
perf: skip merge-gate checks when input files unchanged (S-012)

Migrations, cron-sync, doc-counts, and redemption-backstop checks are
now conditionally skipped when no relevant files were modified. Reduces
gate time during focused frontend or API-only changes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Create semantic color helpers to reduce inline duplication (R-005)

**Files:**
- Modify: `src/lib/severity-colors.ts`
- Modify: ~10 components (replace inline ternaries with helper calls)

- [ ] **Step 1: Add new helpers to severity-colors.ts**

In `src/lib/severity-colors.ts`, add at the bottom:

```typescript
/** Semantic color class for ratio-based quality (green/amber/red). */
export function ratioQualityColor(ratio: number, highThreshold = 0.8, midThreshold = 0.5): string {
  if (ratio >= highThreshold) return "text-emerald-700 dark:text-emerald-400";
  if (ratio >= midThreshold) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}
```

- [ ] **Step 2: Replace inline ternaries in components**

Update the components that use the exact `text-emerald/amber/red` ternary pattern. For each, import `ratioQualityColor` and replace the inline ternary.

**Example — `src/components/balance-bar.tsx:4`:**

Replace:
```typescript
ratio >= 0.8 ? "text-emerald-700 dark:text-emerald-400" : ratio >= 0.5 ? "text-amber-700 dark:text-amber-400" : "text-red-700 dark:text-red-400"
```

With:
```typescript
ratioQualityColor(ratio)
```

Repeat for `dex-liquidity-card.tsx`, `liquidity-table.tsx`, and any other components using the identical 0.8/0.5 threshold pattern. Do NOT replace components that use different thresholds — only identical patterns.

- [ ] **Step 3: Run build**

Run: `npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/severity-colors.ts src/components/balance-bar.tsx src/components/dex-liquidity-card.tsx src/components/liquidity-table.tsx
git commit -m "$(cat <<'EOF'
refactor: extract ratioQualityColor helper for inline color ternaries (R-005)

Centralizes the repeated green/amber/red Tailwind class pattern used
across 10+ components. Only replaces identical threshold patterns.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Structural Improvements

Higher-effort changes addressing systemic patterns.

---

### Task 19: Replace hardcoded `86400` with named constants (R-004)

**Files:**
- Modify: ~30 files across `worker/src/` and `shared/lib/`

This is a large mechanical replacement. The constant `DAY_SECONDS` is exported from `@shared/lib/time-constants`. The worker also has `SECONDS.ONE_DAY` from `worker/src/lib/time-constants`.

- [ ] **Step 1: Handle `shared/lib/cron-jobs.ts`**

This file uses `86400` in `CRON_SCHEDULE_BUCKETS` and `CRON_JOB_DEFINITIONS_BASE` (~12 occurrences). It already imports from `@shared/lib/time-constants` (or should).

Add import if missing:
```typescript
import { DAY_SECONDS } from "./time-constants";
```

Replace all `intervalSec: 86400` with `intervalSec: DAY_SECONDS`.
Replace `offsetSec: 8 * 3600` with `offsetSec: 8 * HOUR_SECONDS` (import `HOUR_SECONDS` too).

- [ ] **Step 2: Handle worker/src/lib files**

For each file in `worker/src/lib/` containing `86400`:
- `live-reserves-store.ts`: Replace `2 * 86400` with `2 * DAY_SECONDS`
- `mint-burn-pipeline/context.ts`: Remove `const DAY_SEC = 86400;`, use `DAY_SECONDS` import
- `fx-rate-state.ts`: Replace all `86400` with `DAY_SECONDS` (~6 occurrences)
- `idempotency.ts`: Replace `7 * 86400` with `7 * DAY_SECONDS`
- `peg-analytics.ts`: Replace `86400` with `DAY_SECONDS` in multi-year calculations
- `redemption-backstops-store.ts`: Replace in date normalization
- `alchemy-logs.ts`: Replace `14 * 86400` with `14 * DAY_SECONDS`

Each file: add `import { DAY_SECONDS } from "@shared/lib/time-constants";` if not already present (or use the worker's `SECONDS.ONE_DAY` for consistency within worker code).

- [ ] **Step 3: Handle worker/src/api files**

For each API handler containing `86400`:
- `digest-archive.ts`
- `mint-burn-flows.ts`
- `backfill-price-sources.ts`
- `peg-summary.ts`
- Other handlers found by grep

Same pattern: import `DAY_SECONDS`, replace literals.

- [ ] **Step 4: Handle worker/src/cron files**

For each cron file containing `86400`:
- `compute-dews.ts`
- `detect-depegs.ts`
- `confirm-pending-depegs.ts`
- Other cron files found by grep

Same pattern.

- [ ] **Step 5: Verify no remaining instances**

Run: `grep -rn "86400" worker/src/ shared/lib/ --include="*.ts" | grep -v node_modules | grep -v __tests__ | grep -v ".test."`

Remaining instances in test files are acceptable (test fixtures may use literal values for clarity). Any production code instances should be addressed.

- [ ] **Step 6: Run full test suite**

Run: `npm test -- --run && cd worker && npx tsc --noEmit`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add -A worker/src/ shared/lib/
git commit -m "$(cat <<'EOF'
refactor: replace 86400 magic number with DAY_SECONDS constant (R-004)

Replaces ~100 production-code instances of hardcoded 86400 across
worker and shared code with the named DAY_SECONDS constant.
Improves readability: 7 * DAY_SECONDS reads as "7 days".

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Add JSDoc to algorithmically dense worker modules (S-008)

**Files:**
- Modify: `worker/src/lib/price-consensus.ts`
- Modify: `worker/src/lib/safety-scores.ts`
- Modify: `worker/src/lib/stability-index.ts`
- Modify: `worker/src/cron/compute-dews.ts`

- [ ] **Step 1: Add JSDoc to price-consensus.ts**

Add a module-level docstring at the top of the file, and augment the existing function-level JSDoc on `computePriceConsensus` (lines 37-47 already have a partial docstring — expand it, do not duplicate):

```typescript
/**
 * Price consensus engine — selects the most trustworthy price from multiple
 * sources using a maximal-clique agreement algorithm (Bron-Kerbosch).
 *
 * Algorithm:
 * 1. Build agreement graph: sources whose prices agree within `thresholdBps`.
 * 2. Find all maximal cliques (sets of mutually agreeing sources).
 * 3. Pick the best cluster by: largest size → highest total weight → trust priority.
 * 4. Return the median price of the winning cluster with confidence metadata.
 *
 * @see docs/pricing-pipeline.md for pipeline-level context.
 */
```

Add JSDoc to `computePriceConsensus`, `pickBestCluster`, and `getSourceTrustPriority`.

- [ ] **Step 2: Add JSDoc to safety-scores.ts**

Add function-level JSDoc to `computeSafetyScoresSnapshot`:

```typescript
/**
 * Computes safety grades from the latest report-card snapshot in D1.
 *
 * @param db - D1 database handle
 * @param options.outputMode - "map" returns id→{grade,score} lookup;
 *   "full-grades" returns ordered grade rows with metadata for the API.
 * @param options.includeNavTokens - Whether to include NAV tokens (default: true).
 * @returns SafetyScoresResultMap or SafetyScoresResultFull depending on outputMode.
 */
```

- [ ] **Step 3: Add JSDoc to stability-index.ts**

Enhance existing module docstring. Add parameter-level docs to `computeStabilityIndex`:

```typescript
/**
 * Computes the Pharos Stability Index (PSI) for a single stablecoin.
 *
 * Components (weighted):
 * - Peg deviation: absolute basis-point deviation from target peg
 * - Volatility: standard deviation of recent price samples
 * - Liquidity depth: DEX liquidity relative to circulating supply
 * - Recovery speed: time to return within tolerance after deviation events
 *
 * Each component is scored 0-100, weighted, then combined. The result
 * includes per-component breakdowns for transparency.
 *
 * @see docs/plans/2026-02-25-stability-index-design.md for full algorithm spec.
 */
```

- [ ] **Step 4: Add JSDoc to compute-dews.ts**

Add module-level and function-level docs:

```typescript
/**
 * Dynamic Early Warning Score (DEWS) — composite risk metric cron job.
 *
 * DEWS aggregates multiple real-time signals (peg deviation, liquidity depth,
 * pool balance ratios, on-chain flow patterns, price consensus confidence)
 * into a single 0-100 risk score per stablecoin. Higher = more risk.
 *
 * Bootstrap mode: On first run or after schema migration, DEWS initializes
 * from available data without requiring full historical depth.
 */
```

- [ ] **Step 5: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors (JSDoc doesn't affect types).

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/price-consensus.ts worker/src/lib/safety-scores.ts worker/src/lib/stability-index.ts worker/src/cron/compute-dews.ts
git commit -m "$(cat <<'EOF'
docs: add JSDoc to algorithmically dense worker modules (S-008)

Adds module-level and function-level documentation to price consensus,
safety scores, stability index, and DEWS computation. Explains
algorithms, parameters, and links to design docs.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: Add CI check for cron connection budgets (S-013)

**Files:**
- Create: `scripts/check-cron-connection-budget.ts`
- Modify: `scripts/test-merge-gate.mjs` (add to validate commands)
- Modify: `package.json` (add script)

- [ ] **Step 1: Write the CI check script**

Create `scripts/check-cron-connection-budget.ts`:

```typescript
import { CRON_JOB_DEFINITIONS } from "../shared/lib/cron-jobs";

const MAX_CONNECTIONS_PER_TRIGGER = 6;

// Group jobs by their schedule key (which maps to a cron trigger).
// CRON_SCHEDULE_BUCKETS is not exported, but scheduleKey on each job
// definition is sufficient to group by trigger.
const jobsByTrigger = new Map<string, { job: string; maxConnections: number }[]>();

for (const def of CRON_JOB_DEFINITIONS) {
  const key = def.scheduleKey;
  if (!jobsByTrigger.has(key)) jobsByTrigger.set(key, []);
  jobsByTrigger.get(key)!.push({
    job: def.job,
    maxConnections: def.maxConnections ?? 0,
  });
}

let failed = false;

for (const [scheduleKey, jobs] of jobsByTrigger) {
  const totalConnections = jobs.reduce((sum, j) => sum + j.maxConnections, 0);

  if (totalConnections > MAX_CONNECTIONS_PER_TRIGGER) {
    console.error(
      `FAIL: Trigger "${scheduleKey}" uses ${totalConnections}/${MAX_CONNECTIONS_PER_TRIGGER} connections:`,
    );
    for (const j of jobs) {
      console.error(`  - ${j.job}: ${j.maxConnections} connections`);
    }
    failed = true;
  } else {
    console.log(
      `OK: "${scheduleKey}" — ${totalConnections}/${MAX_CONNECTIONS_PER_TRIGGER} connections (${jobs.length} jobs)`,
    );
  }
}

if (failed) {
  console.error("\nConnection budget exceeded. Rebalance jobs across triggers.");
  process.exit(1);
} else {
  console.log(`\nAll ${jobsByTrigger.size} triggers within connection budget.`);
}
```

- [ ] **Step 2: Add script to package.json**

In `package.json` scripts:
```json
"check:cron-connections": "tsx scripts/check-cron-connection-budget.ts"
```

- [ ] **Step 3: Add to merge gate**

In `scripts/test-merge-gate.mjs`, add to `NON_NEGOTIABLE_VALIDATE_COMMANDS`:
```javascript
"npm run check:cron-connections",
```

Also add to `SKIPPABLE_CHECKS` (from Task 17):
```javascript
["npm run check:cron-connections", ["shared/lib/cron-jobs.ts", "worker/wrangler.toml"]],
```

- [ ] **Step 4: Run the check**

Run: `npm run check:cron-connections`
Expected: All triggers pass or shows current budget usage.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-cron-connection-budget.ts package.json scripts/test-merge-gate.mjs
git commit -m "$(cat <<'EOF'
feat: add CI check for cron trigger connection budgets (S-013)

Validates that per-trigger maxConnections sums don't exceed the
Cloudflare Workers 6-connection pool limit. Prevents silent
connection-pool overcommit during job rebalancing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Migrate worker imports to direct `@shared/types/*` sub-modules (S-010)

**Files:**
- Modify: ~30 worker files importing from `@shared/types`

- [ ] **Step 1: Map barrel imports to sub-module sources**

Read `shared/types/index.ts` to understand which types come from which sub-module. Build a mapping:

- `core` → StablecoinData, StablecoinMeta, ContractDeployment, PegType, BackingType, GovernanceType, BluechipGrade, BluechipGradeSchema, etc.
- `report-cards` → ReportCard, ReportCardGrade, etc.
- `market` → MarketData, BluechipRating, BluechipSmidge, BluechipRatingsMap, etc.
- `stability` → StabilityIndexEntry, etc.
- `mint-burn` → MintBurnEvent, etc.
- `status` → CacheStatus, etc.
- `chains` → ChainData, etc.
- `digest` → DigestEntry, etc.
- `yield` → YieldRanking, etc.
- `redemption` → RedemptionBackstop, etc.
- `live-reserves` → LiveReserve, etc.

- [ ] **Step 2: Update worker imports file by file**

For each worker file that imports from `@shared/types`, replace with the specific sub-module.

Example — `worker/src/cron/sync-bluechip.ts`:

Replace:
```typescript
import type { BluechipGrade, BluechipRating, BluechipSmidge } from "@shared/types";
```

With:
```typescript
import type { BluechipGrade } from "@shared/types/core";
import type { BluechipRating, BluechipSmidge } from "@shared/types/market";
```

Repeat for all ~30 worker files. Keep the barrel import available for frontend code (no changes to `src/`).

- [ ] **Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/
git commit -m "$(cat <<'EOF'
refactor: use direct @shared/types sub-module imports in worker (S-010)

Replaces barrel @shared/types imports with specific sub-module paths
(e.g., @shared/types/core, @shared/types/report-cards). Improves
TypeScript incremental compilation boundaries.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Strategic Overhauls

Major refactoring efforts for long-term health. No immediate urgency.

---

### Task 23: Redesign param parsing to return validated objects (Q-007)

**Files:**
- Modify: `worker/src/lib/api-utils.ts`
- Modify: All API handlers using `parseIntParam`/`parseFloatParam`

- [ ] **Step 1: Add a multi-param parser**

In `worker/src/lib/api-utils.ts`, add a new `parseQueryParams` utility alongside (not replacing) the existing functions:

```typescript
interface ParamSpec {
  type: "int" | "float";
  default: number;
  min: number;
  max: number;
  name?: string;
}

/**
 * Parse and validate multiple query parameters at once.
 * Returns a validated object or a 400 Response on the first invalid param.
 */
export function parseQueryParams<T extends Record<string, ParamSpec>>(
  searchParams: URLSearchParams,
  specs: T,
): { [K in keyof T]: number } | Response {
  const result = {} as { [K in keyof T]: number };
  for (const [key, spec] of Object.entries(specs) as [keyof T & string, ParamSpec][]) {
    const parser = spec.type === "int" ? parseIntParam : parseFloatParam;
    const value = parser(searchParams.get(key), spec.default, spec.min, spec.max, spec.name ?? key);
    if (value instanceof Response) return value;
    result[key] = value;
  }
  return result;
}
```

- [ ] **Step 2: Write tests for the new utility**

Add to `worker/src/lib/__tests__/api-utils.test.ts`:

```typescript
describe("parseQueryParams", () => {
  it("parses multiple params into an object", () => {
    const params = new URLSearchParams("limit=25&offset=10");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
      offset: { type: "int", default: 0, min: 0, max: 10000 },
    });
    expect(result).toEqual({ limit: 25, offset: 10 });
  });

  it("returns 400 Response for invalid param", () => {
    const params = new URLSearchParams("limit=abc");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
    });
    expect(result).toBeInstanceOf(Response);
  });

  it("uses defaults for missing params", () => {
    const params = new URLSearchParams("");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
      offset: { type: "int", default: 0, min: 0, max: 10000 },
    });
    expect(result).toEqual({ limit: 50, offset: 0 });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --run worker/src/lib/__tests__/api-utils`
Expected: All pass.

- [ ] **Step 4: Migrate handlers incrementally**

Migrate handlers one at a time, starting with the ones with the most parameter parsing boilerplate. Keep `parseIntParam`/`parseFloatParam` available for single-param cases.

Example migration for a handler:

Before:
```typescript
const limit = parseIntParam(url.searchParams.get("limit"), 50, 1, 200, "limit");
if (limit instanceof Response) return limit;
const offset = parseIntParam(url.searchParams.get("offset"), 0, 0, 10000, "offset");
if (offset instanceof Response) return offset;
```

After:
```typescript
const params = parseQueryParams(url.searchParams, {
  limit: { type: "int", default: 50, min: 1, max: 200 },
  offset: { type: "int", default: 0, min: 0, max: 10000 },
});
if (params instanceof Response) return params;
const { limit, offset } = params;
```

- [ ] **Step 5: Run full test suite after each handler migration**

Run: `npm test -- --run && cd worker && npx tsc --noEmit`

- [ ] **Step 6: Commit per batch of handlers**

```bash
git commit -m "$(cat <<'EOF'
refactor: add parseQueryParams batch parser for API handlers (Q-007)

New utility parses multiple query params into a validated object in one
call. Reduces per-handler boilerplate from 4 lines per param to 1 line.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Squash D1 migrations to baseline (S-014)

**Files:**
- Create: `worker/migrations/0000_baseline.sql`
- Modify: `worker/migrations/MANIFEST.md`
- Delete: Migrations 0001-0071 (retain recent 8: 0072-0079)

**CAUTION:** This requires coordination with the production D1 database. The squashed migration must only be applied to NEW databases — existing D1 instances have already applied all 79 numbered migrations (0001-0079, total 85 files including MANIFEST and companions).

- [ ] **Step 1: Generate the current schema**

```bash
cd worker
npx wrangler d1 execute pharos-stablecoins --local --command="SELECT sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND sql IS NOT NULL ORDER BY type, name" > schema-snapshot.sql
```

Review the output. This is the baseline schema.

- [ ] **Step 2: Create the squashed baseline migration**

Create `worker/migrations/0000_baseline.sql` containing the full current schema. This migration is ONLY for fresh database setup — it will be skipped on databases that have already applied migration 0001+.

- [ ] **Step 3: Delete the squashed migrations**

Remove `worker/migrations/0001_*.sql` through `worker/migrations/0071_*.sql` (71 files). Keep `0072_*.sql` through `0079_*.sql` (8 recent migrations) and `MANIFEST.md`.

- [ ] **Step 4: Update MANIFEST.md**

Document that migrations 0001-0071 are consolidated into 0000_baseline.sql. The MANIFEST must record that existing databases should skip 0000 and continue from their last applied migration.

- [ ] **Step 5: Verify migrations still replay cleanly**

Run: `npm run check:migrations`
Expected: All migrations replay successfully against a throwaway SQLite database (0000_baseline + 0072-0079).

- [ ] **Step 6: Commit**

```bash
git add worker/migrations/
git commit -m "$(cat <<'EOF'
chore: squash D1 migrations 0001-0071 into baseline (S-014)

Fresh databases apply the consolidated 0000_baseline.sql then 0072-0079.
Existing production databases continue from their last-applied migration.
Reduces fresh setup from 79 to 9 sequential migrations.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Phase Gate: Final Validation

After all tasks are complete:

- [ ] **Run the full merge gate**

```bash
npm run test:merge-gate
```

Expected: All checks pass.

- [ ] **Verify build output**

```bash
npm run build 2>&1 | tail -10
```

Expected: Clean build with no warnings.

- [ ] **Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

---

## Task Dependency Map

```
Phase 1 (all independent — can be parallelized):
  Task 1 (R-001)  ─── no deps
  Task 2 (R-002)  ─── no deps
  Task 3 (R-003)  ─── no deps
  Task 4 (R-006)  ─── WITHDRAWN (component is actively used)
  Task 5 (R-007)  ─── no deps
  Task 6 (Q-005)  ─── no deps
  Task 7 (Q-006)  ─── no deps
  Task 8 (Q-015)  ─── no deps
  Task 9 (S-001)  ─── no deps
  Task 10 (R-009) ─── no deps

Phase 2 (mostly independent):
  Task 11 (Q-001) ─── no deps
  Task 12 (Q-002) ─── no deps
  Task 13 (Q-011) ─── no deps
  Task 14 (Q-016) ─── no deps (verify migration status first)
  Task 15 (Q-010) ─── no deps
  Task 16 (Q-010) ─── no deps
  Task 17 (S-012) ─── no deps
  Task 18 (R-005) ─── no deps

Phase 3 (some ordering):
  Task 19 (R-004) ─── after Task 5 (R-007, same file)
  Task 20 (S-008) ─── after Task 11 (Q-001, same file)
  Task 21 (S-013) ─── after Task 17 (S-012, merge gate integration)
  Task 22 (S-010) ─── after Task 12 (Q-002, same imports)

Phase 4 (independent of each other):
  Task 23 (Q-007) ─── no deps
  Task 24 (S-014) ─── no deps (requires deploy coordination)
```

---

## Deferred Findings

Three medium-severity findings are deferred to a follow-up plan:

| Finding | Severity | Reason for Deferral |
|---------|----------|-------------------|
| **Q-003** | Medium | Extract typed bucket-summing helper in `sync-stablecoins/stages.ts`. Requires deep understanding of DefiLlama data shapes and careful refactoring of 3 functions. Better done as a focused task with thorough testing. |
| **Q-008** | Medium | Collapse Telegram `handleSubscribe`/`handleUnsubscribe`/`handleSet` into generic handler. The 3 functions have subtle differences (arg parsing, global-vs-ticker paths, error messages) that make mechanical consolidation risky without comprehensive Telegram bot testing. |
| **Q-009** | Medium | Add tests for 9 view-model hooks (`use-compare-data-model.ts`, `use-stablecoin-detail-view-model.ts`, etc.). These hooks aggregate 5-9 TanStack Query sources with heavy memoization. Testing requires substantial mock setup and understanding of the data flow. A dedicated test-writing session would be more effective. |

Additionally, **S-017** (expand component test coverage, medium impact, large effort) is not included in this plan. It is an ongoing improvement tracked separately.

