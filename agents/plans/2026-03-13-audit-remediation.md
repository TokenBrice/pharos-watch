# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all actionable findings from the 2026-03-13 comprehensive codebase audit (51 findings across redundancy, quality, and sustainability pillars).

**Architecture:** Changes are organized into 18 independent tasks across 3 phases. Phase 1 targets security fixes and low-effort quick wins. Phase 2 handles data validation and targeted refactoring. Phase 3 addresses structural improvements, testing gaps, and CI hardening. Seven findings are deferred to separate projects (Q-001, Q-006, Q-007, Q-013, S-001, S-006, S-010) due to their scale or infrastructure dependencies.

**Tech Stack:** TypeScript strict, Next.js 16, Cloudflare Workers + D1, Vitest, Zod 4, TanStack Query.

**Audit report:** `agents/audits/2026-03-13-comprehensive-codebase-audit.md`

---

## Phase 1: Security & Quick Wins

### Task 1: Telegram Webhook Security (Q-002)

**Files:**
- Modify: `worker/src/api/telegram-webhook.ts:48-60`
- Modify: `worker/src/lib/auth.ts` (add timing-safe helper)
- Create: `worker/src/api/__tests__/telegram-webhook-auth.test.ts`

- [ ] **Step 1: Write test for timing-safe secret comparison**

```typescript
// worker/src/api/__tests__/telegram-webhook-auth.test.ts
import { describe, it, expect } from "vitest";
import { timingSafeCompare } from "../../lib/auth";

describe("timingSafeCompare", () => {
  it("returns true for matching strings", async () => {
    expect(await timingSafeCompare("secret123", "secret123")).toBe(true);
  });
  it("returns false for non-matching strings", async () => {
    expect(await timingSafeCompare("secret123", "wrong")).toBe(false);
  });
  it("returns false for empty strings", async () => {
    expect(await timingSafeCompare("", "secret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook-auth.test.ts`
Expected: FAIL with "timingSafeCompare is not exported"

- [ ] **Step 3: Implement timing-safe comparison**

Add to `worker/src/lib/auth.ts`:

```typescript
/** Timing-safe string comparison using Web Crypto API. */
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  const aKey = await crypto.subtle.importKey("raw", aBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", aKey, bBuf);
  const expected = await crypto.subtle.sign("HMAC", aKey, aBuf);
  const sigArr = new Uint8Array(sig);
  const expArr = new Uint8Array(expected);
  if (sigArr.byteLength !== expArr.byteLength) return false;
  let result = 0;
  for (let i = 0; i < sigArr.byteLength; i++) result |= sigArr[i] ^ expArr[i];
  return result === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/api/__tests__/telegram-webhook-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Update webhook handler to use header-based secret + timing-safe comparison**

In `worker/src/api/telegram-webhook.ts`, change the secret check from:

```typescript
if (!webhookSecret || url.searchParams.get("secret") !== webhookSecret) {
```

To:

```typescript
const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
  ?? url.searchParams.get("secret") // backward compat during migration
  ?? "";
if (!webhookSecret || !(await timingSafeCompare(providedSecret, webhookSecret))) {
```

Add import: `import { timingSafeCompare } from "../lib/auth";`

- [ ] **Step 6: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/auth.ts worker/src/api/telegram-webhook.ts worker/src/api/__tests__/telegram-webhook-auth.test.ts
git commit -m "fix(security): use timing-safe comparison for Telegram webhook secret (Q-002)"
```

---

### Task 2: Silent Catch Blocks & Naming (Q-010, Q-011, Q-019)

**Files:**
- Modify: `worker/src/cron/announce-cemetery-additions.ts` (1 genuinely silent catch)
- Modify: `worker/src/lib/authoritative-price-sources.ts` (1 genuinely silent catch)
- Modify: `worker/src/cron/enrich-prices.ts` (rename pass4 -> passDex)
- Modify: `worker/src/cron/detect-depegs.ts` (remove duplicate supply computation)

- [ ] **Step 1: Add console.warn to the 2 genuinely silent catch blocks**

Note: The audit listed 5 locations, but 3 already have logging:
- `sync-stablecoin-charts.ts:75` already has `console.error` on line 76
- `sync-stablecoin-charts.ts:121` already has `console.warn` on line 122
- `daily-digest.ts:562` already has `console.warn` on line 564

Only these 2 are genuinely silent -- add `catch (err) { console.warn("[<context>] ignored:", err); }`:
- `announce-cemetery-additions.ts:49` -> `[cemetery-announce] ignored`
- `authoritative-price-sources.ts:81` -> `[price-sources] hex parse ignored`

- [ ] **Step 2: Rename `pass4` to `passDex` in `EnrichmentStats`**

In `worker/src/cron/enrich-prices.ts`:
- Rename field `pass4` to `passDex` in the `EnrichmentStats` interface (line 298)
- Update all references to `stats.pass4` -> `stats.passDex`
- Update the final log line that outputs the stats object

- [ ] **Step 3: Remove duplicate supply computation in detectDepegEvents (Q-019)**

In `worker/src/cron/detect-depegs.ts`:
- At line ~154, `supply` is computed via `sumPegBuckets(asset.circulating)`
- At line ~241, `coinSupply` is computed the same way
- Replace `coinSupply` usage with `supply` and remove the duplicate computation

- [ ] **Step 4: Build and type-check both layers**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/announce-cemetery-additions.ts worker/src/lib/authoritative-price-sources.ts \
  worker/src/cron/enrich-prices.ts worker/src/cron/detect-depegs.ts
git commit -m "fix: add logging to silent catches, rename pass4->passDex, dedupe supply (Q-010,Q-011,Q-019)"
```

---

### Task 3: Rate Limiter Retry-After on D1 Fallback (Q-003)

**Files:**
- Modify: `worker/src/lib/rate-limit.ts:141-143`

- [ ] **Step 1: Update the D1 fallback path to add Retry-After header**

In `checkPublicApiRateLimit`, the catch block at line 142 currently falls back to `checkRateLimit(ip, limit, windowMs)`. The in-memory fallback is acceptable, but when it triggers a 429, it already sets `Retry-After`. No code change needed here -- the existing `checkRateLimit` already returns a Response with `Retry-After` set (line 58).

Add a comment documenting the known limitation:

```typescript
  } catch (err) {
    // Known limitation: in-memory fallback resets on isolate eviction.
    // Under sustained D1 failure, rate limiting provides best-effort
    // protection within a single isolate's lifetime only.
    console.warn("[public-api] distributed rate limit failed, falling back to isolate-local limiter:", err);
    return checkRateLimit(ip, limit, windowMs);
  }
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/lib/rate-limit.ts
git commit -m "docs: document in-memory rate limiter fallback limitation (Q-003)"
```

---

### Task 4: Small Redundancy Removals (R-006, R-007, R-008, R-009)

**Files:**
- Modify: `src/components/flow-comparison-chart.tsx` (replace formatFlowValue)
- Modify: `src/components/status/format.ts` (remove formatAge)
- Modify: `src/lib/status-dashboard-model.ts` (update import)
- Modify: `src/app/status/client.tsx` (update import)
- Modify: `src/components/status/system-diagnostics.tsx` (update import)
- Modify: `src/components/status/dataset-freshness-table.tsx` (update import)
- Modify: `src/components/status/cache-freshness-table.tsx` (update import)
- Modify: `src/components/status/price-source-health.tsx` (update import)
- Modify: `src/components/status/discovery-candidates.tsx` (update import)
- Modify: `src/components/status/admin-actions-panel.tsx` (update import)
- Modify: `src/components/status/reserve-sync-health.tsx` (update import)
- Modify: `src/components/status/cron-card.tsx` (update import)
- Modify: `src/components/status/telegram-bot-stats.tsx` (update import)
- Modify: `shared/lib/stability-index-version.ts` (remove re-export)
- Modify: `shared/lib/depeg-dews-version.ts` (remove re-export)
- Modify: `shared/lib/blacklist-tracker-version.ts` (remove re-export)
- Modify: `src/components/status/cron-config.ts` (remove aliases)
- Modify: API handler consumers of version re-exports (update imports)

- [ ] **Step 1: Replace `formatFlowValue` with `formatCurrency` (R-006)**

In `src/components/flow-comparison-chart.tsx`:
- Remove the `formatFlowValue` function (lines 34-39)
- Add import: `import { formatCurrency } from "@shared/lib/format";`
- Replace all `formatFlowValue(value)` calls with `formatCurrency(value, 1)`

- [ ] **Step 2: Remove `formatAge` passthrough (R-007)**

In `src/components/status/format.ts`:
- Remove the `formatAge` function (lines 9-11)
- Remove the `formatElapsedSeconds` import if no longer used

In all 11 consumer files listed above:
- Change `import { formatAge, ... } from "@/components/status/format"` (or similar) to import `formatElapsedSeconds` from `@shared/lib/format` instead
- Replace all `formatAge(...)` calls with `formatElapsedSeconds(...)`
- Keep other imports from `@/components/status/format` (like `formatDuration`, `formatInterval`) unchanged

- [ ] **Step 3: Remove `toMethodologyVersionLabel` re-exports (R-008)**

In each of these files, remove the re-export line:
- `shared/lib/stability-index-version.ts:133` -- remove `export const toPsiMethodologyVersionLabel = toMethodologyVersionLabel`
- `shared/lib/depeg-dews-version.ts:253` -- remove `export const toDepegDewsMethodologyVersionLabel = toMethodologyVersionLabel`
- `shared/lib/blacklist-tracker-version.ts:148` -- remove `export const toBlacklistTrackerMethodologyVersionLabel = toMethodologyVersionLabel`

Then update all consumers to import `toMethodologyVersionLabel` directly from `@shared/lib/methodology-version`.

Grep for consumers: `toPsiMethodologyVersionLabel`, `toDepegDewsMethodologyVersionLabel`, `toBlacklistTrackerMethodologyVersionLabel`

- [ ] **Step 4: Remove type/const aliases in cron-config.ts (R-009)**

In `src/components/status/cron-config.ts`:
- Remove `export type StatusCronGroupKey = CronGroupKey` (line 9)
- Remove `export type StatusCronGroupDefinition = CronGroupDefinition` (line 11)
- Remove `export const STATUS_CRON_GROUPS` (line 20)
- Update `StatusCronDisplayMeta` to use `CronGroupKey` directly
- Update all consumers to import from `@shared/lib/cron-jobs` directly
- Update `src/components/__tests__/cron-config.test.ts` if it imports removed aliases

- [ ] **Step 5: Build and type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git commit -am "refactor: remove redundant wrappers and re-exports (R-006,R-007,R-008,R-009)"
```

---

### Task 5: Configuration Quick Wins (S-005, S-009, S-013)

**Files:**
- Modify: `src/app/layout.tsx:92-98` (GA env var)
- Modify: `package.json` (pin TypeScript)
- Modify: `worker/package.json` (pin TypeScript)
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Move GA tracking ID to environment variable (S-005)**

In `src/app/layout.tsx`, replace the hardcoded GA script with:

```tsx
{process.env.NEXT_PUBLIC_GA_ID && (
  <>
    <Script src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GA_ID}`} strategy="afterInteractive" />
    <Script id="gtag-init" strategy="afterInteractive">
      {`window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', '${process.env.NEXT_PUBLIC_GA_ID}');`}
    </Script>
  </>
)}
```

Add `NEXT_PUBLIC_GA_ID=G-6TS0KG8H04` to the production Cloudflare Pages environment variables (note: this is a deploy-time config change, not code).

- [ ] **Step 2: Pin TypeScript version (S-009)**

In both `package.json` and `worker/package.json`, change:
- `"typescript": "^5"` -> `"typescript": "~5.9.0"`

(Current installed version is 5.9.3; `~5.9.0` allows patch updates within 5.9.x)

- [ ] **Step 3: Create Dependabot config (S-013)**

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    labels:
      - "dependencies"
    groups:
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
  - package-ecosystem: "npm"
    directory: "/worker"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 3
    labels:
      - "dependencies"
    groups:
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/app/layout.tsx package.json worker/package.json .github/dependabot.yml
git commit -m "chore: GA env var, pin TypeScript, add Dependabot (S-005,S-009,S-013)"
```

---

### Task 6: Auth Documentation & Convention (Q-001, Q-014, S-004)

**Files:**
- Modify: `worker/src/lib/auth.ts` (add JSDoc)
- Modify: `worker/src/lib/api-utils.ts` (add JSDoc for parseIntParam)
- Modify: `docs/worker-infrastructure.md` (document auth model + module-level state)

- [ ] **Step 1: Document the auth infrastructure dependency (Q-001)**

Add a prominent JSDoc to `hasOpsApiAccessSignal` in `worker/src/lib/auth.ts`:

```typescript
/**
 * Checks for Cloudflare Access proxy signals on ops-api requests.
 *
 * IMPORTANT: This function checks header *presence*, not *validity*.
 * Security relies on Cloudflare Access sitting in front of ops-api.pharos.watch
 * to validate JWTs and strip spoofed headers before they reach the Worker.
 * The Worker itself does NOT verify JWT signatures or service token values.
 *
 * If the Worker is ever reachable without Cloudflare Access in the path
 * (misconfigured DNS, direct Worker URL), all admin endpoints are unprotected.
 */
```

- [ ] **Step 2: Document parseIntParam convention (Q-014)**

Add JSDoc to `parseIntParam` in `worker/src/lib/api-utils.ts`:

```typescript
/**
 * Parse an integer query parameter with default, min, and max bounds.
 *
 * Returns the parsed number on success, or a 400 Response on validation failure.
 * Callers MUST check `instanceof Response` before using the return value:
 *
 * ```typescript
 * const limit = parseIntParam(url.searchParams.get("limit"), 50, 1, 200, "limit");
 * if (limit instanceof Response) return limit;
 * // limit is now narrowed to number
 * ```
 *
 * This is a project convention used consistently across all API handlers.
 */
```

- [ ] **Step 3: Document module-level state pattern (S-004)**

Add a section to `docs/worker-infrastructure.md` under a new heading "Module-Level State":

```markdown
### Module-Level State (Init Pattern)

Several worker modules use module-scoped `let` variables initialized via `init*()` functions:

- `alerts.ts` -> `initAlerts(webhookUrl)`
- `coingecko.ts` -> `initCoinGecko(apiKey)`
- `coingecko-onchain.ts` -> `initCoinGeckoOnchain(apiKey)`
- `chain-registry.ts` -> `initChainRpcs(env)`
- `rate-limit.ts` -> module-level `ipCounts` Map

This pattern exists because `Env` bindings are unavailable at module initialization time
in Workers. The `init*()` functions are called at the top of both `handleHttpRequest`
and `handleScheduledEvent`.

**Constraints:**
- State persists within an isolate but resets on cold starts
- State is NOT shared across isolates
- The `ipCounts` rate limiter provides best-effort protection within a single isolate only
- Always re-initialize in both HTTP and scheduled handlers
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/auth.ts worker/src/lib/api-utils.ts docs/worker-infrastructure.md
git commit -m "docs: document auth model, parseIntParam convention, module-level state (Q-001,Q-014,S-004)"
```

---

## Phase 2: Data Validation & Targeted Refactoring

### Task 7: Stablecoins Cache Zod Validation (Q-005)

**Files:**
- Modify: `worker/src/lib/stablecoins-cache.ts`
- Create: `worker/src/lib/__tests__/stablecoins-cache-validation.test.ts`

- [ ] **Step 1: Write test for Zod validation of cache payload**

```typescript
// worker/src/lib/__tests__/stablecoins-cache-validation.test.ts
import { describe, it, expect } from "vitest";
import { validateStablecoinEntry } from "../stablecoins-cache";

describe("validateStablecoinEntry", () => {
  it("accepts valid entry with required fields", () => {
    const entry = { id: "1", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD", circulating: { peggedUSD: 100e9 } };
    expect(validateStablecoinEntry(entry)).not.toBeNull();
  });

  it("rejects entry missing id", () => {
    const entry = { symbol: "USDT", price: 1.0, pegType: "peggedUSD" };
    expect(validateStablecoinEntry(entry)).toBeNull();
  });

  it("rejects entry with non-string id", () => {
    const entry = { id: 123, symbol: "USDT", price: 1.0, pegType: "peggedUSD" };
    expect(validateStablecoinEntry(entry)).toBeNull();
  });

  it("rejects entry missing symbol", () => {
    const entry = { id: "1", price: 1.0, pegType: "peggedUSD" };
    expect(validateStablecoinEntry(entry)).toBeNull();
  });

  it("allows null price (some coins lack price data)", () => {
    const entry = { id: "1", symbol: "USDT", name: "Tether", price: null, pegType: "peggedUSD", circulating: {} };
    const result = validateStablecoinEntry(entry);
    expect(result).not.toBeNull();
    expect(result?.price).toBeNull();
  });

  it("preserves all extra fields from upstream", () => {
    const entry = { id: "1", symbol: "USDT", name: "Tether", price: 1.0, pegType: "peggedUSD", circulating: {}, chains: ["Ethereum"], extraField: "kept" };
    const result = validateStablecoinEntry(entry);
    expect(result).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd worker && npx vitest run src/lib/__tests__/stablecoins-cache-validation.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement per-entry validation**

In `worker/src/lib/stablecoins-cache.ts`, add:

```typescript
import { z } from "zod";

// Validate critical fields only -- passthrough preserves all upstream data
const StablecoinEntrySchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().optional(),
  price: z.number().nullable().optional(),
  pegType: z.string().optional(),
  circulating: z.record(z.unknown()).optional(),
}).passthrough();

/** Validate a single stablecoin entry. Returns the entry if valid, null if malformed. */
export function validateStablecoinEntry(entry: unknown): StablecoinData | null {
  const result = StablecoinEntrySchema.safeParse(entry);
  return result.success ? (result.data as StablecoinData) : null;
}
```

Update `normalizePayload` to filter entries through validation:

```typescript
// In the array path (line 71) and object path (line 87):
const validated = rawArray
  .map((entry: unknown) => validateStablecoinEntry(entry))
  .filter((e): e is StablecoinData => e !== null);

if (validated.length === 0) {
  return { kind: "error", reason: "missing-pegged-assets" };
}

if (validated.length < rawArray.length) {
  console.warn(`[stablecoins-cache] Filtered ${rawArray.length - validated.length} malformed entries`);
}
```

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/lib/__tests__/stablecoins-cache`
Expected: All pass

- [ ] **Step 5: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/stablecoins-cache.ts worker/src/lib/__tests__/stablecoins-cache-validation.test.ts
git commit -m "feat: add Zod validation to stablecoins cache boundary (Q-005)"
```

---

### Task 8: Feedback Endpoint Zod Validation (Q-012)

**Files:**
- Modify: `worker/src/api/feedback.ts:226-235`

- [ ] **Step 1: Add Zod schema for feedback body**

In `worker/src/api/feedback.ts`, replace the `FeedbackBody` interface with a Zod schema:

```typescript
import { z } from "zod";

const FeedbackBodySchema = z.object({
  type: z.enum(["bug", "data-correction", "feature-request"]),
  title: z.string().max(100).optional(),
  description: z.string().min(10).max(2000),
  expectedValue: z.string().max(500).optional(),
  stablecoinId: z.string().max(100).optional(),
  stablecoinName: z.string().max(100).optional(),
  pageUrl: z.string().startsWith("/").max(300),
  pegValue: z.string().max(100).optional(),
  website: z.string().optional(), // honeypot
});

type FeedbackBody = z.infer<typeof FeedbackBodySchema>;
```

- [ ] **Step 2: Replace manual validation with Zod parse**

In `handleFeedback`, replace lines 226-263 with:

```typescript
  let fb: FeedbackBody;
  try {
    const raw = await request.json();
    const result = FeedbackBodySchema.safeParse(raw);
    if (!result.success) {
      return errorResponse(400, result.error.issues[0]?.message ?? "Invalid feedback data");
    }
    fb = result.data;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  // Honeypot: silently accept but do nothing
  if (fb.website) return jsonResponse({ ok: true });

  // Title required for bug + feature-request
  if ((fb.type === "bug" || fb.type === "feature-request") && (!fb.title || fb.title.trim().length < 3)) {
    return errorResponse(400, "Title must be 3-100 characters");
  }
```

- [ ] **Step 3: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/feedback.ts
git commit -m "feat: add Zod validation to feedback endpoint (Q-012)"
```

---

### Task 9: Binary Search Consolidation (R-001)

**Files:**
- Modify: `worker/src/api/backfill-depegs.ts` (remove findNearestSupply, use shared)
- Modify: `worker/src/lib/authoritative-price-sources.ts` (remove findNearestSupply, use shared)
- Modify: `worker/src/lib/psi-recompute.ts` (refactor to use shared + post-filter)

- [ ] **Step 1: Replace `findNearestSupply` in `backfill-depegs.ts`**

The existing function returns `number | null` (the supply value, not the object). Replace the body but keep the wrapper so callers are unchanged:

```typescript
import { binarySearchNearest } from "../lib/binary-search";

export function findNearestSupply(supplyByDate: SupplySnapshot[], timestamp: number): number | null {
  const nearest = binarySearchNearest(supplyByDate, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}
```

This replaces the 22-line lo/hi/candidates implementation with a 2-line delegation.

- [ ] **Step 2: Replace `findNearestSupply` in `authoritative-price-sources.ts`**

Same pattern -- keep wrapper, delegate to shared utility. Note: uses `HistoricalSupplySnapshot` type with `.ts` field:

```typescript
import { binarySearchNearest } from "./binary-search";

function findNearestSupply(snapshots: HistoricalSupplySnapshot[] | undefined, timestamp: number): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}
```

- [ ] **Step 3: Refactor `findNearestSupplySnapshot` in `psi-recompute.ts`**

Replace the linear scan with binary search + 14-day post-filter. Note: uses `.date` field (not `.ts`):

```typescript
import { binarySearchNearest } from "./binary-search";

export function findNearestSupplySnapshot(
  snapshots: SupplySnapshot[] | undefined,
  targetTs: number,
): SupplySnapshot | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, targetTs, (s) => s.date);
  if (!nearest) return null;
  const MAX_DISTANCE_SEC = 14 * 86400;
  return Math.abs(nearest.date - targetTs) <= MAX_DISTANCE_SEC ? nearest : null;
}
```

Note: Preserves the existing `export`, `| undefined` param type, and `| null` return type to keep callers and tests unchanged. Read the actual type definitions first to confirm the correct field name.

- [ ] **Step 4: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add worker/src/api/backfill-depegs.ts worker/src/lib/authoritative-price-sources.ts worker/src/lib/psi-recompute.ts
git commit -m "refactor: consolidate binary search implementations (R-001)"
```

---

### Task 10: Table Comparator Factory (R-002)

**Files:**
- Create: `src/lib/table-comparator.ts`
- Create: `src/lib/__tests__/table-comparator.test.ts`
- Modify: `src/components/liquidity-table-logic.ts`
- Modify: `src/components/depeg-table-logic.ts`
- Modify: `src/components/blacklist-table-logic.ts`
- Modify: `src/components/yield-table-logic.ts`

- [ ] **Step 1: Write test for generic comparator factory**

```typescript
// src/lib/__tests__/table-comparator.test.ts
import { describe, it, expect } from "vitest";
import { createTableComparator } from "../table-comparator";

interface TestRow { name: string; value: number; label: string; }

describe("createTableComparator", () => {
  const compare = createTableComparator<TestRow, "name" | "value">({
    name: (r) => r.name,
    value: (r) => r.value,
  });

  it("sorts by numeric field ascending", () => {
    const rows: TestRow[] = [
      { name: "B", value: 20, label: "" },
      { name: "A", value: 10, label: "" },
    ];
    rows.sort((a, b) => compare(a, b, { key: "value", direction: "asc" }));
    expect(rows[0].value).toBe(10);
  });

  it("sorts by string field descending", () => {
    const rows: TestRow[] = [
      { name: "A", value: 10, label: "" },
      { name: "B", value: 20, label: "" },
    ];
    rows.sort((a, b) => compare(a, b, { key: "name", direction: "desc" }));
    expect(rows[0].name).toBe("B");
  });

  it("handles null/undefined values", () => {
    const nullCompare = createTableComparator<{ v: number | null }, "v">({
      v: (r) => r.v ?? 0,
    });
    const rows = [{ v: null }, { v: 5 }];
    rows.sort((a, b) => nullCompare(a, b, { key: "v", direction: "asc" }));
    expect(rows[0].v).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/lib/__tests__/table-comparator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the factory**

```typescript
// src/lib/table-comparator.ts

interface SortState<K extends string> {
  key: K;
  direction: "asc" | "desc";
}

/**
 * Creates a type-safe table row comparator from a field extractor map.
 * Each extractor returns a number or string for comparison.
 */
export function createTableComparator<Row, K extends string>(
  extractors: Record<K, (row: Row) => number | string>,
): (a: Row, b: Row, sort: SortState<K>) => number {
  return (a, b, sort) => {
    const extractor = extractors[sort.key];
    if (!extractor) return 0;
    const aVal = extractor(a);
    const bVal = extractor(b);
    let cmp: number;
    if (typeof aVal === "string" && typeof bVal === "string") {
      cmp = aVal.localeCompare(bVal);
    } else {
      cmp = (aVal as number) - (bVal as number);
    }
    return sort.direction === "asc" ? cmp : -cmp;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/table-comparator.test.ts`
Expected: PASS

- [ ] **Step 5: Migrate all four table logic files**

For each of `liquidity-table-logic.ts`, `depeg-table-logic.ts`, `blacklist-table-logic.ts`, `yield-table-logic.ts`:
- Import `createTableComparator` from `@/lib/table-comparator`
- Replace the switch/case comparator with a `createTableComparator` call
- Export the comparator as before (same function name, same signature)

Read each file first to understand the specific field accessors needed.

- [ ] **Step 6: Build and type-check**

Run: `npm run build`
Expected: No errors

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/lib/table-comparator.ts src/lib/__tests__/table-comparator.test.ts \
  src/components/liquidity-table-logic.ts src/components/depeg-table-logic.ts \
  src/components/blacklist-table-logic.ts src/components/yield-table-logic.ts
git commit -m "refactor: extract generic table comparator factory (R-002)"
```

---

### Task 11: Frontend Utility Extraction (R-004, R-005, R-011)

**Files:**
- Create: `src/hooks/use-is-mobile.ts`
- Create: `src/lib/chart-utils.ts`
- Create: `src/lib/__tests__/chart-utils.test.ts`
- Modify: `src/components/psi-history-chart.tsx`
- Modify: `src/components/yield-scatter-plot.tsx`
- Modify: `src/components/comparison-chart.tsx`
- Modify: `src/components/flow-comparison-chart.tsx`
- Modify: `src/components/mcap-chart.tsx`
- Modify: `src/components/total-mcap-chart.tsx`
- Modify: `src/components/peg-diversity-chart.tsx`

- [ ] **Step 1: Create shared `useIsMobile` hook (R-004)**

```typescript
// src/hooks/use-is-mobile.ts
"use client";
import { useState, useEffect } from "react";

export function useIsMobile(breakpoint = 640): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return isMobile;
}
```

Note: Uses `breakpoint - 1` to match existing behavior (strictly less than breakpoint).

Replace inline implementations in `psi-history-chart.tsx` and `yield-scatter-plot.tsx`.

- [ ] **Step 2: Write test for chart utilities**

```typescript
// src/lib/__tests__/chart-utils.test.ts
import { describe, it, expect } from "vitest";
import { computeChartYDomain, mergeSeriesByTimestamp } from "../chart-utils";

describe("computeChartYDomain", () => {
  it("returns auto for all-range", () => {
    expect(computeChartYDomain([10, 20, 30], true)).toEqual([0, "auto"]);
  });
  it("applies 15% padding", () => {
    const [min, max] = computeChartYDomain([100, 200], false);
    expect(min).toBeLessThan(100);
    expect(max).toBeGreaterThan(200);
  });
  it("clamps min to 0", () => {
    const [min] = computeChartYDomain([5, 10], false);
    expect(min).toBeGreaterThanOrEqual(0);
  });
});

describe("mergeSeriesByTimestamp", () => {
  it("merges two series by timestamp", () => {
    const series = [
      { id: "a", data: [{ ts: 1, v: 10 }, { ts: 2, v: 20 }] },
      { id: "b", data: [{ ts: 1, v: 30 }, { ts: 3, v: 40 }] },
    ];
    const merged = mergeSeriesByTimestamp(series, (d) => d.v);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ ts: 1, a: 10, b: 30 });
  });
});
```

- [ ] **Step 3: Implement chart utilities**

```typescript
// src/lib/chart-utils.ts

/** Compute padded Y-axis domain for Recharts charts. */
export function computeChartYDomain(
  values: number[],
  isAllRange: boolean,
): [number, number | "auto"] {
  if (isAllRange || values.length === 0) return [0, "auto"];
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min;
  const padding = range > 0 ? range * 0.15 : max * 0.05;
  return [Math.max(0, min - padding), max + padding];
}

/** Merge multiple time series into a flat array keyed by timestamp. */
export function mergeSeriesByTimestamp<D extends { ts: number }>(
  series: { id: string; data: D[] }[],
  getValue: (d: D) => number,
): Record<string, number>[] {
  const tsMap = new Map<number, Record<string, number>>();
  for (const s of series) {
    for (const d of s.data) {
      let entry = tsMap.get(d.ts);
      if (!entry) { entry = { ts: d.ts }; tsMap.set(d.ts, entry); }
      entry[s.id] = getValue(d);
    }
  }
  return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/__tests__/chart-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Migrate chart components to use shared utilities**

Replace inline Y-domain computations in `mcap-chart.tsx`, `total-mcap-chart.tsx`, `peg-diversity-chart.tsx`.
Replace inline series merge in `comparison-chart.tsx` and `flow-comparison-chart.tsx`.

- [ ] **Step 6: Build and type-check**

Run: `npm run build`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-is-mobile.ts src/lib/chart-utils.ts src/lib/__tests__/chart-utils.test.ts \
  src/components/psi-history-chart.tsx src/components/yield-scatter-plot.tsx \
  src/components/comparison-chart.tsx src/components/flow-comparison-chart.tsx \
  src/components/mcap-chart.tsx src/components/total-mcap-chart.tsx src/components/peg-diversity-chart.tsx
git commit -m "refactor: extract useIsMobile, chart Y-domain, and series merge utilities (R-004,R-005,R-011)"
```

---

### Task 12: API Scalability - Unbounded Queries (S-002)

**Files:**
- Modify: `worker/src/api/stability-index.ts:42-44`
- Modify: `worker/src/api/dex-liquidity.ts`

- [ ] **Step 1: Add LIMIT to stability-index detail query**

In `worker/src/api/stability-index.ts`, change the detail query (line 43) from:

```sql
SELECT ... FROM stability_index ORDER BY computed_at DESC
```

To:

```sql
SELECT ... FROM stability_index ORDER BY computed_at DESC LIMIT 730
```

This caps at 2 years of daily data, more than sufficient for any frontend consumer.

- [ ] **Step 2: Replace `SELECT *` with explicit columns in dex-liquidity**

In `worker/src/api/dex-liquidity.ts`, replace `SELECT *` with explicit column names.

- [ ] **Step 3: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/stability-index.ts worker/src/api/dex-liquidity.ts
git commit -m "perf: bound stability-index and dex-liquidity queries (S-002)"
```

---

### Task 13: Pages Functions Dedup (Q-008)

**Files:**
- Create: `functions/lib/ops-origin.ts`
- Modify: `functions/api/admin/[[path]].ts`
- Modify: `functions/status/[[path]].ts`

- [ ] **Step 1: Extract shared origin helpers**

```typescript
// functions/lib/ops-origin.ts
export const DEFAULT_OPS_UI_ORIGIN = "https://ops.pharos.watch";

/** Normalizes a string to a proper URL origin (protocol + host, no path). */
export function normalizeOrigin(input: string): string {
  const normalized = input.includes("://") ? input : `https://${input}`;
  return new URL(normalized).origin;
}

export function resolveOpsUiOrigin(env: { OPS_UI_ORIGIN?: string }): string {
  return normalizeOrigin(env.OPS_UI_ORIGIN?.trim() || DEFAULT_OPS_UI_ORIGIN);
}
```

Note: This preserves the existing URL-parsing behavior (handles inputs without protocol, strips paths).

- [ ] **Step 2: Update both Pages Functions to import from shared module**

In both `functions/api/admin/[[path]].ts` and `functions/status/[[path]].ts`:
- Remove local `normalizeOrigin` / `resolveOpsUiOrigin` / `DEFAULT_OPS_UI_ORIGIN`
- Add: `import { normalizeOrigin, resolveOpsUiOrigin } from "../../lib/ops-origin";` (adjust path as needed)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add functions/lib/ops-origin.ts functions/api/admin/[[path]].ts functions/status/[[path]].ts
git commit -m "refactor: extract shared origin helpers from Pages Functions (Q-008)"
```

---

### Task 14: Backfill Result Type & Circuit Breaker CAS (Q-004, Q-009)

**Files:**
- Modify: `worker/src/api/backfill-mint-burn.ts`
- Modify: `worker/src/lib/circuit-breaker.ts`

- [ ] **Step 1: Refactor `resolveBackfillConfig` to return result type (Q-009)**

Change `resolveBackfillConfig` from throwing Response objects to returning a discriminated union:

```typescript
type BackfillConfigResult =
  | { ok: true; config: MintBurnContractConfig; selectionMode: "explicit" | "auto"; autoSelectedReason: string | null }
  | { ok: false; response: Response };
```

Replace `throw errorResponse(...)` with `return { ok: false, response: errorResponse(...) }`.

Update the caller to check `result.ok` instead of try/catch.

- [ ] **Step 2: Add CAS comment to circuit breaker (Q-004)**

In `worker/src/lib/circuit-breaker.ts`, add a comment documenting the known TOCTOU window:

```typescript
/**
 * Records the outcome of a fetch attempt and handles state transitions.
 * Fires alerts on open/close transitions.
 *
 * NOTE: There is a known TOCTOU window between shouldAttemptFetch() and
 * recordOutcome() — concurrent cron jobs could both read "half-open" and
 * both probe. This is accepted as best-effort behavior; the circuit breaker
 * provides probabilistic protection, not strict mutual exclusion.
 * D1 lacks the CAS primitives needed for strict single-probe semantics
 * without adding a separate coordination mechanism.
 */
```

- [ ] **Step 3: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/api/backfill-mint-burn.ts worker/src/lib/circuit-breaker.ts
git commit -m "refactor: backfill result type, document circuit breaker TOCTOU (Q-004,Q-009)"
```

---

## Phase 3: Structural & Testing

### Task 15: db.ts Decomposition (S-003)

**Files:**
- Modify: `worker/src/lib/db.ts` (keep thin core)
- Create: `worker/src/lib/db-cache.ts` (cache CRUD + price cache)
- Create: `worker/src/lib/cron-lease.ts` (lease acquisition/renewal/release + timeout + progress)
- Create: `worker/src/lib/cron-logger.ts` (logCronRun + reporting)
- Modify: All consumers (update imports)

- [ ] **Step 1: Read db.ts to map the exact function boundaries**

Read the full file and identify which functions go where:
- `db.ts` keeps: `batchExecute`, `buildPaginatedQuery`, `buildInClause`, `getLastBlock`, `setLastBlock`
- `db-cache.ts` gets: `getCache`, `setCache`, `setCacheIfNewer`, `getPriceCache`, `savePriceCache`
- `cron-lease.ts` gets: `acquireLease`, `renewLease`, `releaseLease`, `runLeasedCron`, `CronTimeoutManager`, lease-related types
- `cron-logger.ts` gets: `logCronRun`, `CronProgressReporter`

- [ ] **Step 2: Extract `db-cache.ts`**

Move cache-related functions. Update all consumers with new import paths.

- [ ] **Step 3: Extract `cron-lease.ts` and `cron-logger.ts`**

Move cron infrastructure. Update all consumers.

- [ ] **Step 4: Update all import sites**

Grep for `from "./db"` and `from "../lib/db"` across the worker to find all consumers. Update each to import from the correct new module.

- [ ] **Step 5: Build and type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/db.ts worker/src/lib/db-cache.ts worker/src/lib/cron-lease.ts \
  worker/src/lib/cron-logger.ts worker/src/
git commit -m "refactor: decompose db.ts into db-cache, cron-lease, cron-logger (S-003)"
```

---

### Task 16: Daily-0800 Cron Sequencing & Auth Pattern (S-007, R-003, R-010)

**Files:**
- Modify: `worker/src/handlers/scheduled/daily-0800.ts`
- Modify: `worker/src/lib/auth.ts` (document dual pattern)
- Modify: `shared/lib/redemption-backstop-version.ts`

- [ ] **Step 1: Sequence external-fetch jobs after DB-only jobs (S-007)**

In `daily-0800.ts`, change from all-parallel to:

```typescript
export function runDaily0800Slot(runtime: ScheduledRuntimeContext): void {
  // DB-only snapshot jobs (no external fetch) — safe to parallelize
  runtime.ctx.waitUntil(runtime.runLeasedCron("snapshot-supply", (signal) => snapshotSupply(runtime.db, signal)));
  runtime.ctx.waitUntil(runtime.runLeasedCron(
    "snapshot-safety-grade-history",
    (signal) => snapshotSafetyGradeHistory(runtime.db, signal),
  ));
  runtime.ctx.waitUntil(runtime.runLeasedCron("snapshot-psi", (signal) => snapshotPsiDaily(runtime.db, signal)));

  // External-fetch jobs — chained to avoid concurrent connection contention
  runtime.ctx.waitUntil(
    runtime.runLeasedCron("fetch-tbill-rate", (signal) => fetchTbillRate(runtime.db, signal))
      .then(() => runtime.runLeasedCron(
        "sync-usds-status",
        (signal) => syncUsdsStatus(runtime.db, runtime.env.ETHERSCAN_API_KEY ?? null, signal),
      )),
  );
}
```

- [ ] **Step 2: Document dual admin auth pattern (R-003)**

Add JSDoc to `worker/src/lib/auth.ts` above both functions explaining the convention:

```typescript
/**
 * Admin authentication provides two usage patterns:
 *
 * 1. `withAdmin(request, handler, trusted)` — callback wrapper (preferred).
 *    Use when the entire handler body requires admin access.
 *
 * 2. `requireAdmin(request, trusted)` — guard pattern (returns Response | null).
 *    Use when the handler needs pre-auth work before the main body,
 *    or when auth is one of several early-return checks.
 *
 * Both patterns are project conventions. Choose based on handler structure.
 */
```

- [ ] **Step 3: Migrate `redemption-backstop-version.ts` to factory (R-010)**

Read `shared/lib/methodology-version.ts` for the `createMethodologyVersion()` API, then refactor `shared/lib/redemption-backstop-version.ts` to use the factory.

- [ ] **Step 4: Build and type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add worker/src/handlers/scheduled/daily-0800.ts worker/src/lib/auth.ts \
  shared/lib/redemption-backstop-version.ts
git commit -m "refactor: sequence daily-0800 cron, document auth patterns, version factory (S-007,R-003,R-010)"
```

---

### Task 17: Depeg Detection & Stablecoin Detail Tests (Q-015, Q-016)

**Files:**
- Create: `worker/src/cron/__tests__/detect-depegs.test.ts`
- Modify: `worker/src/api/__tests__/stablecoin-detail.test.ts`

- [ ] **Step 1: Read the depeg detection source to understand test requirements**

Read `worker/src/cron/detect-depegs.ts` fully.
Read `worker/src/cron/confirm-pending-depegs.ts` fully.
Understand the DB schema for `depeg_events` table.

- [ ] **Step 2: Write depeg detection integration tests**

Create `worker/src/cron/__tests__/detect-depegs.test.ts` with test cases covering:

1. **Open new event**: Asset with price deviation > threshold should create a new depeg event
2. **Close on recovery**: Asset that recovers should close the open depeg event
3. **Skip below supply threshold**: Asset below minimum supply should not create events
4. **Direction change**: Asset changing from depeg-above to depeg-below should close old and open new
5. **Duplicate merge**: Two events for the same asset should be merged
6. **Orphan cleanup**: Events for assets no longer in the cache should be cleaned up

Mock D1 with a simple in-memory implementation that supports the required SQL operations.

- [ ] **Step 3: Run tests to verify they fail (TDD red phase)**

Run: `cd worker && npx vitest run src/cron/__tests__/detect-depegs.test.ts`
Expected: Tests should be runnable but may fail if mocking is insufficient — adjust mocks.

- [ ] **Step 4: Fix any test infrastructure issues until tests pass**

Iterate on mock D1 implementation until tests accurately exercise the detection logic.

- [ ] **Step 5: Read stablecoin detail handler for fallback path tests**

Read `worker/src/api/stablecoin-detail.ts` and existing `__tests__/stablecoin-detail.test.ts`.

- [ ] **Step 6: Add fallback path tests to stablecoin-detail.test.ts**

Add test cases for:
1. Fresh cache hit (no upstream call)
2. Stale cache with successful upstream refresh
3. Upstream failure with supply_history table fallback
4. Circuit breaker open state
5. CoinGecko-only provider path

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/__tests__/detect-depegs.test.ts worker/src/api/__tests__/stablecoin-detail.test.ts
git commit -m "test: add depeg detection and stablecoin detail fallback tests (Q-015,Q-016)"
```

---

### Task 18: CI Security Scanning & Low-Severity Fixes (S-008, S-014)

**Files:**
- Modify: `eslint.config.mjs` (add security plugin)
- Modify: `worker/src/lib/rate-limit.ts` (bound in-memory map)

- [ ] **Step 1: Add eslint-plugin-security to CI (S-008)**

Add `eslint-plugin-security` as a devDependency and configure in `eslint.config.mjs`.
This is lighter weight than semgrep and catches common injection patterns.

Run: `npm install -D eslint-plugin-security`

Add to `eslint.config.mjs`:
```javascript
import security from "eslint-plugin-security";
// In the config array, add:
{ plugins: { security }, rules: security.configs.recommended.rules }
```

- [ ] **Step 2: Cap in-memory rate limiter map size (S-014)**

In `worker/src/lib/rate-limit.ts`, add a hard cap on `ipCounts` map size to prevent unbounded growth:

```typescript
const MAX_IP_ENTRIES = 10_000;

// Inside checkRateLimit, after pruneExpired:
if (ipCounts.size >= MAX_IP_ENTRIES) {
  pruneExpired(now);
  if (ipCounts.size >= MAX_IP_ENTRIES) {
    // Hard cap reached even after prune -- clear oldest entries
    const entries = [...ipCounts.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < entries.length / 2; i++) ipCounts.delete(entries[i][0]);
  }
}
```

- [ ] **Step 3: Build and lint**

Run: `npm run build && npm run lint`
Expected: No errors (security lint rules may produce warnings to review)

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs package.json package-lock.json worker/src/lib/rate-limit.ts
git commit -m "chore: add SAST scanning, cap rate limiter map (S-008,S-014)"
```

Note: S-010 (human-contributor quickstart) is deferred as a documentation-only task with no code impact.

---

## Deferred Items (Separate Projects)

The following findings require separate implementation projects due to scale or infrastructure dependencies:

| ID | Finding | Reason for Deferral |
|----|---------|-------------------|
| Q-001 | JWT validation for admin auth | Requires Cloudflare Access key fetching infrastructure + security review |
| Q-006 | Decompose `detectDepegEvents` | 307-line refactor with high regression risk; needs Q-015 tests in place first |
| Q-007 | `fetchWithRetry` result type migration | 40+ call sites; phased migration across multiple PRs |
| Q-013 | Split `sync-blacklist.ts` (1258 lines) | Full module directory extraction; its own project |
| S-001 | Split `stablecoins.ts` (4637 lines) | 58 importers, architectural decision on data format needed |
| S-006 | Component directory restructuring | 116 files, massive import changes; needs team alignment |
| S-010 | Human-contributor quickstart doc | Low severity, documentation-only, no code impact |

---

## Verification Checklist

After all tasks are complete:

- [ ] Full build passes: `npm run build`
- [ ] Worker type-check passes: `cd worker && npx tsc --noEmit`
- [ ] All tests pass: `npm test`
- [ ] Lint passes: `npm run lint`
- [ ] Worker boundary check: `npm run check:worker-boundary`
- [ ] Cron schedule sync: `npm run check:cron-sync`
- [ ] No duplicate exports from parallel changes
