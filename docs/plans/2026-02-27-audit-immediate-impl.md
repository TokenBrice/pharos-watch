# Audit Immediate Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 critical/high-severity data pipeline bugs identified in the audit that can silently corrupt user-facing data.

**Architecture:** Surgical fixes to existing worker and frontend code. No new dependencies. One new DB migration. All changes are backward-compatible.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, Next.js

---

### Task 1: NaN Guard in PSI Score Computation

**Files:**
- Modify: `worker/src/lib/stability-index.ts:53`

**Step 1: Apply the fix**

In `computeStabilityIndex()`, replace the raw `mcap7dChangePct` usage with a `Number.isFinite()` guard:

```typescript
// Line 53 — replace:
const trend = Math.max(-5, Math.min(5, mcap7dChangePct));

// With:
const safePct = Number.isFinite(mcap7dChangePct) ? mcap7dChangePct : 0;
const trend = Math.max(-5, Math.min(5, safePct));
```

**Step 2: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean compile, no errors.

**Step 3: Commit**

```bash
git add worker/src/lib/stability-index.ts
git commit -m "fix(psi): guard NaN propagation in computeStabilityIndex"
```

---

### Task 2: Active Depeg Cap in Report Cards

**Files:**
- Modify: `src/lib/report-cards.ts:151`

**Step 1: Apply the fix**

In `scorePegStability()`, add the documented active-depeg cap that was missing. Change line 151 from `const` to `let` and add the cap:

```typescript
// Line 151 — replace:
const score = Math.round(Math.max(0, Math.min(100, peg.pegScore)));

// With:
let score = Math.round(Math.max(0, Math.min(100, peg.pegScore)));
if (peg.activeDepeg) score = Math.min(65, score);
```

**Step 2: Verify**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 3: Commit**

```bash
git add src/lib/report-cards.ts
git commit -m "fix(report-cards): enforce active depeg cap at C (65) in scorePegStability"
```

---

### Task 3: Migration for `digest_extended` Column

**Files:**
- Create: `worker/migrations/0027_digest_extended.sql`

**Step 1: Create the migration**

The `daily_digest` table (migration 0018) has columns `(id, generated_at, digest_text, input_data)`. Migration 0021 adds `digest_title`. But `digest_extended` is used in INSERTs and SELECTs with no migration. Create the missing migration:

```sql
ALTER TABLE daily_digest ADD COLUMN digest_extended TEXT;
```

**Step 2: Verify**

Run: `ls worker/migrations/ | sort | tail -3`
Expected: `0027_digest_extended.sql` appears as the latest migration.

**Step 3: Commit**

```bash
git add worker/migrations/0027_digest_extended.sql
git commit -m "fix(migration): add missing digest_extended column to daily_digest"
```

---

### Task 4: NaN Guard in Depeg Detection

**Files:**
- Modify: `worker/src/cron/detect-depegs.ts:109-110`

**Step 1: Apply the fix**

In `detectDepegEvents()`, the guard `if (pegRef <= 0) continue;` does not catch NaN (since `NaN <= 0` is `false`). Extend the guard:

```typescript
// Lines 109-110 — replace:
const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
if (pegRef <= 0) continue;

// With:
const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
if (!Number.isFinite(pegRef) || pegRef <= 0) continue;
```

**Step 2: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean compile, no errors.

**Step 3: Commit**

```bash
git add worker/src/cron/detect-depegs.ts
git commit -m "fix(depegs): guard NaN from getPegReference in depeg detection"
```

---

### Task 5: fetchWithRetry for CMC + DexScreener

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:293,369`

**Step 1: Replace bare `fetch()` with `fetchWithRetry()` in CMC pass**

The `fetchWithRetry` function is already imported in this file. In Pass 3.5 (CMC), line 293, replace the bare `fetch()`:

```typescript
// Line 293 — replace:
const cmcRes = await fetch(
  `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=${slugs}`,
  {
    headers: {
      "X-CMC_PRO_API_KEY": cmcApiKey,
      "Accept": "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(10_000),
  }
);

// With:
const cmcRes = await fetchWithRetry(
  `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?slug=${slugs}`,
  {
    headers: {
      "X-CMC_PRO_API_KEY": cmcApiKey,
      "Accept": "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(10_000),
  }
);
```

**Step 2: Replace bare `fetch()` with `fetchWithRetry()` in DexScreener pass**

In Pass 4 (DexScreener), line 369, replace the bare `fetch()`:

```typescript
// Line 369 — replace:
const res = await fetch(
  `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
  { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) }
);

// With:
const res = await fetchWithRetry(
  `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
  { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) }
);
```

**Important:** `fetchWithRetry` returns `Response | null` (null on total failure). The CMC call site already wraps in try/catch. The DexScreener call site already has a `!res.ok` check — add a null-guard before it.

After replacing the DexScreener `fetch`, also handle the null case:

```typescript
// After the fetchWithRetry call, before `if (!res.ok)`:
if (!res) {
  console.warn(`[enrich] DexScreener returned no response for ${m.asset.symbol}`);
  continue;
}
```

**Step 3: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean compile, no errors.

**Step 4: Also verify the CMC null-safety**

Check: the CMC call is inside `if (cmcRes.ok)` — but `fetchWithRetry` can return null. Ensure there's a null guard. The existing code has `if (cmcRes.ok)` which will evaluate `null.ok` and throw. Add optional chaining:

```typescript
// Replace `if (cmcRes.ok)` with:
if (cmcRes && cmcRes.ok)
```

Wait — actually looking at the code more carefully, the CMC call is already wrapped in try/catch (lines 291-347), so a null access would be caught. But it's cleaner to add `cmcRes &&`. Check the actual code and add if needed.

**Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "fix(enrich): use fetchWithRetry for CMC and DexScreener API calls"
```

---

### Task 6: LIMIT on Digest Archive Query

**Files:**
- Modify: `worker/src/api/digest-archive.ts:5-6`

**Step 1: Apply the fix**

Add `LIMIT 365` to bound the response to one year of digests:

```typescript
// Lines 5-6 — replace:
const rows = await db.prepare(
  "SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest ORDER BY generated_at DESC"
).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null }>();

// With:
const rows = await db.prepare(
  "SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest ORDER BY generated_at DESC LIMIT 365"
).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null }>();
```

**Step 2: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean compile, no errors.

**Step 3: Commit**

```bash
git add worker/src/api/digest-archive.ts
git commit -m "fix(api): add LIMIT 365 to digest-archive query to prevent unbounded growth"
```

---

### Task 7: Final Verification

**Step 1: Full frontend build**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 2: Full worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean, no errors.

**Step 3: Final commit (if any type fixes needed)**

Only if verification caught issues — fix and commit.
