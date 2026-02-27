# Data Pipeline Audit — Immediate Fixes (This Week)

> Remediation plan for Critical and High-severity issues that can be fixed in under 30 minutes each.
> These are bugs where corrupted or misleading data can silently reach users.

---

## 1. NaN Propagation in PSI Score

**Severity:** Critical
**Finding:** `computeStabilityIndex()` does not validate `mcap7dChangePct`. If NaN reaches the function, `Math.max(-5, Math.min(5, NaN))` evaluates to NaN, which propagates through the entire score. The score is stored to D1 as NaN and `getConditionBand(NaN)` returns "MELTDOWN" — an alarming band for what is actually a data error.

**File:** `worker/src/lib/stability-index.ts:53`

```typescript
// Current (broken for NaN input)
const trend = Math.max(-5, Math.min(5, mcap7dChangePct));
```

**Fix:** Add `Number.isFinite()` guard before the clamp:

```typescript
const safePct = Number.isFinite(mcap7dChangePct) ? mcap7dChangePct : 0;
const trend = Math.max(-5, Math.min(5, safePct));
```

**Verify:** Unit test — `computeStabilityIndex({ ..., mcap7dChangePct: NaN })` returns a finite number, not NaN.

---

## 2. Active Depeg Cap Not Enforced in Report Cards

**Severity:** Critical
**Finding:** `scorePegStability()` JSDoc and the detail text both say "capped at C (65) if activeDepeg," but no capping logic exists. A coin currently 200bps off its peg with good history receives A+ (score 98) while the UI text claims it is "capped at C." Users see a high safety grade for a coin that is demonstrably off its peg.

**File:** `src/lib/report-cards.ts:134,151,156`

```typescript
// Current — no cap applied
const score = Math.round(Math.max(0, Math.min(100, peg.pegScore)));
```

**Fix:** Apply the documented cap:

```typescript
let score = Math.round(Math.max(0, Math.min(100, peg.pegScore)));
if (peg.activeDepeg) score = Math.min(65, score);
```

**Verify:** Unit test — coin with `pegScore: 98, activeDepeg: true` → score ≤ 65, grade ≤ C.

---

## 3. Missing Migration for `digest_extended` Column

**Severity:** Critical
**Finding:** The `daily_digest` table was created in migration `0018` with columns `(id, generated_at, digest_text, input_data)`. Migration `0021` adds `digest_title`. But `digest_extended` is used in INSERTs and SELECTs with **no migration** adding it. A fresh DB provisioned from migrations alone will fail.

**Files:** `worker/migrations/0018_daily_digest.sql`, `worker/src/cron/daily-digest.ts:131,300`, `worker/src/api/digest-archive.ts:6`

**Fix:** Add migration `0027_digest_extended.sql`:

```sql
ALTER TABLE daily_digest ADD COLUMN digest_extended TEXT;
```

**Verify:** Run `npx wrangler d1 migrations apply stablecoin-db --local` and confirm `/api/digest-archive` returns 200 on a fresh local DB.

---

## 4. NaN from `getPegReference` Bypasses Guard in Depeg Detection

**Severity:** High
**Finding:** `detectDepegEvents` guards against `pegRef <= 0`, but NaN is not `<= 0`, so `price / NaN` produces NaN which propagates into `peak_deviation_bps` stored to D1.

**File:** `worker/src/cron/detect-depegs.ts:112`

```typescript
// Current — NaN passes through
const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
if (pegRef <= 0) continue;
```

**Fix:** Extend the guard to cover NaN:

```typescript
const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
if (!pegRef || !Number.isFinite(pegRef) || pegRef <= 0) continue;
```

**Verify:** Unit test — asset with pegRef = NaN is skipped, no depeg event created.

---

## 5. CMC and DexScreener API Calls Missing Retry

**Severity:** High
**Finding:** Every other external API call in the cron layer uses `fetchWithRetry()`, but the CoinMarketCap (Pass 3.5) and DexScreener (Pass 4) calls use bare `fetch()`. A single transient network error loses the entire enrichment pass with no retry.

**Files:** `worker/src/cron/enrich-prices.ts:293` (CMC), `worker/src/cron/enrich-prices.ts:369` (DexScreener)

**Fix:** Replace bare `fetch()` with `fetchWithRetry()` in both locations. Use the same timeout (10s) and default 2 retries.

**Verify:** `cd worker && npx tsc --noEmit` passes. Confirm in cron logs that CMC/DexScreener passes still complete successfully.

---

## 6. Unbounded `digest-archive` Response

**Severity:** High
**Finding:** `/api/digest-archive` queries all rows from `daily_digest` with no LIMIT. Each digest contains full text (several KB). After months of operation this response grows unboundedly. This is a public endpoint.

**File:** `worker/src/api/digest-archive.ts:5-7`

```typescript
// Current — no limit
const rows = await db.prepare(
  "SELECT digest_text, digest_title, generated_at, digest_extended FROM daily_digest ORDER BY generated_at DESC"
).all<...>();
```

**Fix:** Add `LIMIT 365` to the query (one year of daily digests).

**Verify:** Confirm the endpoint returns ≤ 365 results and the frontend digest archive page still works correctly.

---

## Checklist

- [ ] Fix 1: NaN guard in `computeStabilityIndex`
- [ ] Fix 2: Active depeg cap in `scorePegStability`
- [ ] Fix 3: Migration for `digest_extended`
- [ ] Fix 4: NaN guard in `detectDepegEvents`
- [ ] Fix 5: `fetchWithRetry` for CMC + DexScreener
- [ ] Fix 6: LIMIT on digest-archive query
- [ ] Run `npm run build` — confirm clean
- [ ] Run `cd worker && npx tsc --noEmit` — confirm clean
