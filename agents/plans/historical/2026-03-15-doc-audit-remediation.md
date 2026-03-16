# Documentation Audit Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four documentation gaps identified by audit: automate stablecoin count drift, update architecture.md curated tree for status/, document canary endpoints, and document `_meta` freshness metadata pattern.

**Architecture:** Pure documentation + one CI guard script. No runtime code changes. The count-drift guard is a new `scripts/check-doc-counts.mjs` that reads `CANONICAL_ORDER.length` and `SHADOW_STABLECOINS.length` at build time and greps key docs for stale counts. The three doc updates are surgical edits to existing markdown files.

**Tech Stack:** Node.js (ESM script), markdown

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/check-doc-counts.mjs` | CI script: reads authoritative counts, greps docs for stale hardcoded numbers |
| Modify | `docs/scripts.md` | Add check-doc-counts to script inventory |
| Modify | `CLAUDE.md:3` | Replace hardcoded "157" with current count |
| Modify | `AGENTS.md:3` | Replace hardcoded "157" with current count |
| Modify | `README.md:3` | Replace hardcoded "157" with current count |
| Modify | `docs/report-cards.md:316` | Replace hardcoded "157" with current count |
| Modify | `docs/supply-snapshot.md:26` | Replace hardcoded "157 tracked + 2 shadow" with current counts |
| Modify | `docs/architecture.md:199-203` | Expand `src/components/status/` curated tree |
| Modify | `docs/status-dashboard.md:337-348` | Add canary endpoint alias table |
| Modify | `docs/api-reference.md:29-37` | Add `_meta` freshness metadata section |
| Modify | `docs/yield-intelligence.md` | Add `_meta` note to API response section |

---

### Task 1: Create count-drift CI guard script

**Files:**
- Create: `scripts/check-doc-counts.mjs`
- Modify: `docs/scripts.md`

The script reads `shared/lib/stablecoins/index.ts` and `shared/lib/shadow-stablecoins.ts` to extract the authoritative counts via regex, then greps the five primary docs for stale hardcoded numbers. Exits non-zero with a clear message listing which files are stale and what the correct count is.

- [ ] **Step 1: Create `scripts/check-doc-counts.mjs`**

```javascript
#!/usr/bin/env node
/**
 * CI guard: detects stale hardcoded stablecoin counts in primary docs.
 * Reads CANONICAL_ORDER length and SHADOW_STABLECOINS length from source,
 * then checks key docs for matching counts.
 *
 * Usage: node scripts/check-doc-counts.mjs
 * Exits 0 if all counts match, 1 if any are stale.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// --- Extract authoritative counts from source ---

const canonicalSrc = readFileSync(
  resolve(root, "shared/lib/stablecoins/index.ts"),
  "utf-8",
);
// Extract CANONICAL_ORDER array body, then count entries within it
const arrayMatch = canonicalSrc.match(
  /CANONICAL_ORDER:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/,
);
if (!arrayMatch) {
  console.error("FATAL: Could not find CANONICAL_ORDER array in index.ts");
  process.exit(1);
}
const trackedCount = (arrayMatch[1].match(/^\s+"[a-z][a-z0-9-]*"/gm) || []).length;

const shadowSrc = readFileSync(
  resolve(root, "shared/lib/shadow-stablecoins.ts"),
  "utf-8",
);
const shadowCount = (shadowSrc.match(/\{\s*id:\s*"/g) || []).length;

const psiCount = trackedCount + shadowCount;

console.log(
  `Authoritative counts: ${trackedCount} tracked, ${shadowCount} shadow, ${psiCount} PSI-eligible`,
);

// --- Check primary docs for stale counts ---

const CHECKS = [
  {
    file: "CLAUDE.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "AGENTS.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "README.md",
    pattern: /tracking (\d+) stablecoins/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/report-cards.md",
    pattern: /(\d+) tracked/,
    expected: trackedCount,
    label: "tracked",
  },
  {
    file: "docs/supply-snapshot.md",
    pattern: /currently (\d+) entries/,
    expected: psiCount,
    label: "PSI-eligible",
  },
  {
    file: "docs/supply-snapshot.md",
    pattern: /(\d+) tracked/,
    expected: trackedCount,
    label: "tracked",
  },
];

let failures = 0;

for (const { file, pattern, expected, label } of CHECKS) {
  const content = readFileSync(resolve(root, file), "utf-8");
  const match = content.match(pattern);
  if (!match) {
    console.error(`  FAIL  ${file} — expected pattern ${pattern} not found (was the text rephrased?)`);
    failures++;
    continue;
  }
  const found = Number(match[1]);
  if (found !== expected) {
    console.error(
      `  FAIL  ${file}: found ${found} ${label}, expected ${expected}`,
    );
    failures++;
  } else {
    console.log(`  OK    ${file}: ${found} ${label}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} file(s) have stale stablecoin counts. Update them to match CANONICAL_ORDER (${trackedCount}) / SHADOW_STABLECOINS (${shadowCount}).`,
  );
  process.exit(1);
}

console.log("\nAll stablecoin counts are in sync.");
```

- [ ] **Step 2: Make script executable and run it**

Run: `chmod +x scripts/check-doc-counts.mjs && node scripts/check-doc-counts.mjs`
Expected: All OK (counts currently match at 157 tracked, 2 shadow, 159 PSI-eligible)

- [ ] **Step 3: Add to `package.json` scripts**

Add `"check:doc-counts": "node scripts/check-doc-counts.mjs"` to the `scripts` section of `package.json`.

- [ ] **Step 4: Add to `docs/scripts.md` inventory table**

Append this row to the script inventory table in `docs/scripts.md`:

```markdown
| `scripts/check-doc-counts.mjs`              | Detect stale hardcoded stablecoin counts in primary docs                                                                              | `shared/lib/stablecoins/index.ts`, `shared/lib/shadow-stablecoins.ts`, primary doc files                                                                                                                                                                                                                   | Exits non-zero listing files with stale counts                                                          |
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-doc-counts.mjs docs/scripts.md package.json
git commit -m "ci: add stablecoin count drift guard script"
```

---

### Task 2: Expand `src/components/status/` in architecture.md curated tree

**Files:**
- Modify: `docs/architecture.md:199-203`

The status/ directory has 26 files but only 4 are listed. Add the remaining architecturally significant components. Group by function (infrastructure, health tables, admin).

- [ ] **Step 1: Replace the status/ section in `docs/architecture.md`**

Replace lines 199-203 (the `status/` subtree) with:

```markdown
│   ├── status/                   # Status dashboard component decomposition
│   │   ├── page-primitives.tsx   # Status-page-only shell pieces (summary badge, section shell, notice rail, lane links)
│   │   ├── top-fold-copy.ts      # Status top-fold tone/copy config
│   │   ├── recommended-action-strip.tsx # Status hero intervention strip
│   │   ├── cron-metadata-summary.ts # Per-job cron metadata summarizer registry for cron-card
│   │   ├── cron-card.tsx         # Individual cron job health card
│   │   ├── cron-config.ts        # Cron display configuration
│   │   ├── status-banner.tsx     # Top-level status banner
│   │   ├── status-facts.tsx      # Status fact summaries
│   │   ├── format.ts             # Status-specific formatting helpers
│   │   ├── refresh-countdown.tsx # Auto-refresh countdown timer
│   │   ├── cache-freshness-table.tsx   # Cache key freshness matrix
│   │   ├── dataset-freshness-table.tsx # Dataset-level freshness table
│   │   ├── endpoint-health-grid.tsx    # Endpoint probe result grid
│   │   ├── data-quality-cards.tsx      # Data quality signal cards
│   │   ├── circuit-breaker-table.tsx   # Circuit breaker state table
│   │   ├── system-diagnostics.tsx      # System-level diagnostic panel
│   │   ├── action-recommendations.ts   # Action recommendation engine
│   │   ├── admin-action-button.tsx     # Admin action trigger button
│   │   ├── admin-actions-panel.tsx     # Admin action shelf panel
│   │   ├── discovery-candidates.tsx    # Discovery candidate listing
│   │   ├── liquidity-health.tsx        # Liquidity sync health view
│   │   ├── price-source-health.tsx     # Price source health view
│   │   ├── reserve-sync-health.tsx     # Reserve sync health view
│   │   ├── mint-burn-reconciliation.tsx # Mint/burn reconciliation view
│   │   ├── telegram-bot-stats.tsx      # Telegram bot statistics
│   │   └── transition-timeline.tsx     # Status state transition timeline
```

- [ ] **Step 2: Verify the listed files actually exist**

Run: `ls src/components/status/ | wc -l`
Expected: 26 files

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: expand status/ curated tree in architecture.md (22 files added)"
```

---

### Task 3: Document canary endpoint aliases in status-dashboard.md

**Files:**
- Modify: `docs/status-dashboard.md:337-348`

Add a canary alias table to the existing "Endpoint Probing" section. These are internal-only health-check registrations, not public API surface.

- [ ] **Step 1: Insert canary subsection after line 348 in `docs/status-dashboard.md`**

After the existing bullet about `{ path, status, latencyMs, error? }` (line 348), insert:

```markdown

### Canary Endpoint Aliases

Three internal health-check registrations in `shared/lib/api-endpoints.ts` use hardcoded stablecoin IDs to probe parameterized routes without requiring dynamic URL construction:

| Endpoint Key | Registered Path | Probe Path | Rationale |
|---|---|---|---|
| `stablecoin-detail-canary` | `/api/stablecoin/usdt-tether` | `/api/stablecoin/pyusd-paypal` | Lighter payload than USDT avoids timeout false negatives |
| `stablecoin-summary-canary` | `/api/stablecoin-summary/usdt-tether` | (same as path) | Snapshot route health check |
| `stablecoin-reserves-canary` | `/api/stablecoin-reserves/iusd-infinifi` | (same as path) | Live reserves route health check |

Handler bindings are in `worker/src/route-registry.ts`. Each delegates to the same handler as the corresponding dynamic `GET /api/stablecoin/:id` route but with a pre-selected ID.

These are **not part of the public API contract**. Canary IDs may change without notice if the underlying coins are removed from tracking. External integrators should use the parameterized routes documented in the API reference.
```

- [ ] **Step 2: Commit**

```bash
git add docs/status-dashboard.md
git commit -m "docs: document canary endpoint aliases in status-dashboard.md"
```

---

### Task 4: Document `_meta` freshness metadata pattern in api-reference.md

**Files:**
- Modify: `docs/api-reference.md:29-37` (after Response Headers section)
- Modify: `docs/yield-intelligence.md` (API response section)

The `_meta` field is injected into all `createCacheHandler()` responses (object-typed only) and manually into `yield-rankings`. Document the pattern, the shape, and which endpoints include it.

- [ ] **Step 1: Insert `_meta` section in `docs/api-reference.md` after the Response Headers table (after line 37)**

After the `---` separator following the Response Headers table, insert:

```markdown

## Response Body Freshness (`_meta`)

Endpoints backed by `createCacheHandler()` inject a `_meta` object into plain-object (non-array) response bodies alongside the HTTP freshness headers above. This provides inline freshness metadata for consumers that prefer not to parse response headers.

**Shape:**

```json
{
  "_meta": {
    "updatedAt": 1710500000,
    "ageSeconds": 42,
    "status": "fresh"
  }
}
```

| Field        | Type     | Description                                                                                     |
| ------------ | -------- | ----------------------------------------------------------------------------------------------- |
| `updatedAt`  | `number` | Unix epoch seconds when the cron last wrote this data to D1                                     |
| `ageSeconds` | `number` | `floor(now / 1000) - updatedAt`                                                                 |
| `status`     | `string` | `"fresh"` (age/max <= 1.0), `"degraded"` (1.0 < ratio <= 1.5), or `"stale"` (ratio > 1.5) |

**Endpoints with `_meta`:**

| Endpoint | Max Age (sec) | Source |
|---|---|---|
| `GET /api/stablecoins` | 600 | `createCacheHandler` |
| `GET /api/stablecoin-charts` | 3600 | `createCacheHandler` |
| `GET /api/bluechip-ratings` | 43200 | `createCacheHandler` |
| `GET /api/usds-status` | 86400 | `createCacheHandler` |
| `GET /api/yield-rankings` | 1800 | Manual injection after live safety hydration |

Array-typed responses (e.g., endpoints returning a JSON array at the top level) receive only the HTTP headers (`X-Data-Age`, `Warning`) and do not include `_meta`.

The frontend `apiFetchWithMeta()` helper (in `src/lib/api.ts`) reads `_meta` from the response body when present, falling back to the `X-Data-Age` header for endpoints that do not include it.

---
```

- [ ] **Step 2: Add `_meta` note to yield-intelligence.md API section**

Find the yield-rankings API response description in `docs/yield-intelligence.md` and append a note:

```markdown
The response includes a `_meta` freshness object (see [Response Body Freshness](api-reference.md#response-body-freshness-_meta)) indicating data age and staleness status. The frontend uses this to power the `StaleDataBanner` on the yield page.
```

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference.md docs/yield-intelligence.md
git commit -m "docs: document _meta freshness metadata pattern in API reference"
```

---

### Task 5: Update MEMORY.md count and final verification

**Files:**
- Modify: `/home/ahirice/.claude/projects/-home-ahirice-Documents-git-stablecoin-dashboard/memory/MEMORY.md`

- [ ] **Step 1: Run the count-drift guard to verify everything is green**

Run: `node scripts/check-doc-counts.mjs`
Expected: All OK, exit 0

- [ ] **Step 2: Run full build + type-check**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Update MEMORY.md**

Update the "Documentation Drift Patterns" section to note the CI guard exists and remove the manual count-tracking advice.

- [ ] **Step 5: Final commit with all doc updates**

Stage any remaining doc changes and commit.
