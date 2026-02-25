# PSI Deduplication, Depreciation & Per-Coin Contributors — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix duplicate event double-counting, add depreciation for chronic depegs, and expose per-coin contribution breakdowns in the PSI.

**Architecture:** Three changes layered bottom-up — pure compute function gains depreciation support, cron/backfill gain deduplication + age calculation + contributor capture, API/frontend surface the new data. Each task is independently verifiable via `cd worker && npx tsc --noEmit` or `npm run build`.

**Tech Stack:** TypeScript (worker + Next.js), Cloudflare Workers D1, React, Recharts

**Design doc:** `docs/plans/2026-02-25-psi-dedup-depreciation-design.md`

---

### Task 1: Add depreciation to the pure compute function

**Files:**
- Modify: `worker/src/lib/stability-index.ts`

**Step 1: Update the `StabilityInput` interface (line 9)**

Replace:
```typescript
depegs: { bps: number; mcapUsd: number }[];
```
With:
```typescript
depegs: { bps: number; mcapUsd: number; depegAgeDays?: number }[];
```

**Step 2: Add the depreciation constants and helper after `const K = 60;` (line 26)**

```typescript
const GRACE_DAYS = 30;
const DECAY_DAYS = 120;
const DEPRECIATION_FLOOR = 0.25;

/** Linear decay: full impact for 30d, then fades to 25% floor over 120d. */
export function getDepreciationFactor(ageDays: number): number {
  if (ageDays <= GRACE_DAYS) return 1.0;
  return Math.max(DEPRECIATION_FLOOR, 1.0 - (ageDays - GRACE_DAYS) / DECAY_DAYS);
}
```

**Step 3: Apply factor in the severity reduce (lines 31-35)**

Replace:
```typescript
  const severityRaw = depegs.reduce((sum, d) => {
    const share = totalMcapUsd > 0 ? d.mcapUsd / totalMcapUsd : 0;
    const amplifier = Math.log2(1 + d.mcapUsd / 1e9);
    return sum + (Math.abs(d.bps) / 100) * share * amplifier * K;
  }, 0);
```
With:
```typescript
  const severityRaw = depegs.reduce((sum, d) => {
    const share = totalMcapUsd > 0 ? d.mcapUsd / totalMcapUsd : 0;
    const amplifier = Math.log2(1 + d.mcapUsd / 1e9);
    const factor = getDepreciationFactor(d.depegAgeDays ?? 0);
    return sum + (Math.abs(d.bps) / 100) * share * amplifier * K * factor;
  }, 0);
```

**Step 4: Apply factor in the breadth reduce (lines 38-40)**

Replace:
```typescript
  const breadthRaw = depegs.reduce((sum, d) => {
    return sum + Math.sqrt(d.mcapUsd / 1e9) * 3;
  }, 0);
```
With:
```typescript
  const breadthRaw = depegs.reduce((sum, d) => {
    const factor = getDepreciationFactor(d.depegAgeDays ?? 0);
    return sum + Math.sqrt(d.mcapUsd / 1e9) * 3 * factor;
  }, 0);
```

**Step 5: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: clean exit, no errors. The interface change is backward-compatible (`depegAgeDays` is optional).

**Step 6: Commit**

```bash
git add worker/src/lib/stability-index.ts
git commit -m "feat(psi): add depreciation factor to pure compute function

Linear decay: 100% for first 30 days, fading to 25% floor over next 120 days.
Applied to both severity and breadth contributions."
```

---

### Task 2: Deduplicate + add age + capture contributors in the cron

**Files:**
- Modify: `worker/src/cron/stability-index.ts`

**Context:** The cron currently queries `SELECT stablecoin_id, peg_reference FROM depeg_events WHERE ended_at IS NULL` and maps every row to a separate depeg entry. When a coin has 2+ overlapping events, it gets counted multiple times. We need to group by `stablecoin_id`, pick the worst current deviation, use the earliest `started_at`, compute age, and capture per-coin contributors for the `input_snapshot`.

**Step 1: Add `started_at` to the SQL query (line 34)**

Replace:
```typescript
    .prepare("SELECT stablecoin_id, peg_reference FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string; peg_reference: number }>();
```
With:
```typescript
    .prepare("SELECT stablecoin_id, peg_reference, started_at FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string; peg_reference: number; started_at: number }>();
```

**Step 2: Replace the flat `depegs` mapping (lines 45-50) with dedup + contributor logic**

Replace the entire block from `const depegs = (activeDepegs.results ?? []).flatMap(...)` through its closing `]);` with:

```typescript
  // Deduplicate by stablecoin_id: group events, pick worst deviation, earliest start
  const grouped = new Map<string, typeof (activeDepegs.results ?? [])[number][]>();
  for (const r of activeDepegs.results ?? []) {
    const list = grouped.get(r.stablecoin_id) ?? [];
    list.push(r);
    grouped.set(r.stablecoin_id, list);
  }

  const now = Math.floor(Date.now() / 1000);
  const depegs: { bps: number; mcapUsd: number; depegAgeDays: number }[] = [];
  const contributors: {
    id: string; symbol: string; bps: number; mcapUsd: number;
    ageDays: number; factor: number;
  }[] = [];

  for (const [coinId, events] of grouped) {
    const price = priceById.get(coinId);
    if (!price) continue;

    let worstBps = 0;
    let earliestStart = Infinity;
    for (const e of events) {
      if (e.peg_reference <= 0) continue;
      const bps = Math.round(((price / e.peg_reference) - 1) * 10000);
      if (Math.abs(bps) > Math.abs(worstBps)) worstBps = bps;
      if (e.started_at < earliestStart) earliestStart = e.started_at;
    }

    if (earliestStart === Infinity) continue;
    const mcapUsd = mcapById.get(coinId) ?? 0;
    const ageDays = Math.max(0, (now - earliestStart) / 86400);

    depegs.push({ bps: worstBps, mcapUsd, depegAgeDays: ageDays });

    // Find symbol for contributor snapshot
    const coin = tracked.find((c) => c.id === coinId);
    contributors.push({
      id: coinId,
      symbol: coin?.symbol ?? coinId,
      bps: worstBps,
      mcapUsd,
      ageDays: Math.round(ageDays * 10) / 10,
      factor: Math.round(getDepreciationFactor(ageDays) * 100) / 100,
    });
  }
```

**Step 3: Add the import for `getDepreciationFactor` (line 6)**

Replace:
```typescript
import { computeStabilityIndex } from "../lib/stability-index";
```
With:
```typescript
import { computeStabilityIndex, getDepreciationFactor } from "../lib/stability-index";
```

**Step 4: Move `const now` above the dedup block**

The existing `const now = Math.floor(Date.now() / 1000);` on line 62 needs to move earlier — it's now used in the dedup loop. Remove the old line 62 declaration (it's already declared in the new dedup block above). Make sure the `now` used for the DB insert references the same variable.

**Step 5: Update the `input_snapshot` to include contributors (line 72)**

Replace:
```typescript
      JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h, mcap7dChangePct }),
```
With:
```typescript
      JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h, mcap7dChangePct, contributors }),
```

**Step 6: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: clean exit, no errors.

**Step 7: Commit**

```bash
git add worker/src/cron/stability-index.ts
git commit -m "fix(psi): deduplicate depeg events and add per-coin contributors

Group events by stablecoin_id, pick worst current deviation, use
earliest started_at for age calculation. Store per-coin contributor
breakdown in input_snapshot for API transparency."
```

---

### Task 3: Apply same dedup + age logic to backfill

**Files:**
- Modify: `worker/src/api/backfill-stability-index.ts`

**Context:** The backfill has the same double-counting bug at lines 70-80. It also needs depreciation age. The backfill uses `start_price` (not live price) for bps since it replays historical data.

**Step 1: Replace the active depegs loop (lines 70-81) with dedup logic**

Replace:
```typescript
      const activeDepegs = depegEvents.filter(
        (e) => e.started_at <= day && (e.ended_at === null ? day <= now : e.ended_at > day)
      );

      const depegs: { bps: number; mcapUsd: number }[] = [];

      for (const e of activeDepegs) {
        if (e.peg_reference <= 0) continue;
        const mcap = getMcapForDay(e.stablecoin_id, day);
        const bps = Math.round(((e.start_price / e.peg_reference) - 1) * 10000);
        depegs.push({ bps, mcapUsd: mcap });
      }
```
With:
```typescript
      const activeDepegs = depegEvents.filter(
        (e) => e.started_at <= day && (e.ended_at === null ? day <= now : e.ended_at > day)
      );

      // Deduplicate by stablecoin_id: worst bps, earliest start
      const grouped = new Map<string, typeof activeDepegs[number][]>();
      for (const e of activeDepegs) {
        const list = grouped.get(e.stablecoin_id) ?? [];
        list.push(e);
        grouped.set(e.stablecoin_id, list);
      }

      const depegs: { bps: number; mcapUsd: number; depegAgeDays: number }[] = [];

      for (const [coinId, events] of grouped) {
        let worstBps = 0;
        let earliestStart = Infinity;
        for (const e of events) {
          if (e.peg_reference <= 0) continue;
          const bps = Math.round(((e.start_price / e.peg_reference) - 1) * 10000);
          if (Math.abs(bps) > Math.abs(worstBps)) worstBps = bps;
          if (e.started_at < earliestStart) earliestStart = e.started_at;
        }
        if (earliestStart === Infinity) continue;
        const mcap = getMcapForDay(coinId, day);
        const ageDays = Math.max(0, (day - earliestStart) / DAY);
        depegs.push({ bps: worstBps, mcapUsd: mcap, depegAgeDays: ageDays });
      }
```

**Step 2: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: clean exit, no errors.

**Step 3: Commit**

```bash
git add worker/src/api/backfill-stability-index.ts
git commit -m "fix(psi): deduplicate depeg events in backfill

Same dedup logic as cron: group by stablecoin_id, worst bps, earliest
start. Adds depreciation age for historical score recomputation."
```

---

### Task 4: Surface contributors in the API response

**Files:**
- Modify: `worker/src/api/stability-index.ts`

**Context:** The `input_snapshot` column already contains the `contributors` array (stored by the cron in Task 2). We need to read it and include it in the `current` response object. Only for `current` — not history rows (too much data).

**Step 1: Add `input_snapshot` to the current row query**

The current row is always `results[0]`. We need to select `input_snapshot` for it. The simplest approach: add `input_snapshot` to the query but only use it for the current row.

Replace lines 7-9:
```typescript
  const query = detail
    ? "SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC"
    : "SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 91";
```
With:
```typescript
  const query = detail
    ? "SELECT computed_at, score, band, components, input_snapshot FROM stability_index ORDER BY computed_at DESC"
    : "SELECT computed_at, score, band, components, input_snapshot FROM stability_index ORDER BY computed_at DESC LIMIT 91";
```

**Step 2: Update the row type (line 13)**

Replace:
```typescript
    .all<{ computed_at: number; score: number; band: string; components: string }>();
```
With:
```typescript
    .all<{ computed_at: number; score: number; band: string; components: string; input_snapshot: string | null }>();
```

**Step 3: Parse and include contributors in the current response (lines 31-37)**

Replace:
```typescript
  return new Response(JSON.stringify({
    current: {
      score: current.score,
      band: current.band,
      components: JSON.parse(current.components),
      computedAt: current.computed_at,
    },
```
With:
```typescript
  const snapshot = current.input_snapshot ? JSON.parse(current.input_snapshot) : {};
  const contributors = Array.isArray(snapshot.contributors) ? snapshot.contributors : [];

  return new Response(JSON.stringify({
    current: {
      score: current.score,
      band: current.band,
      components: JSON.parse(current.components),
      contributors,
      computedAt: current.computed_at,
    },
```

**Step 4: Verify worker type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: clean exit, no errors.

**Step 5: Commit**

```bash
git add worker/src/api/stability-index.ts
git commit -m "feat(psi): expose per-coin contributors in API response

Reads contributors from input_snapshot and includes them in the
current score object. History rows are unchanged."
```

---

### Task 5: Update frontend hook types

**Files:**
- Modify: `src/hooks/use-stability-index.ts`

**Step 1: Add the contributor interface and update `StabilityIndexCurrent`**

After the `StabilityIndexComponents` interface (after line 10), add:

```typescript
export interface StabilityContributor {
  id: string;
  symbol: string;
  bps: number;
  mcapUsd: number;
  ageDays: number;
  factor: number;
}
```

Then update `StabilityIndexCurrent` (lines 12-17) — add `contributors`:

Replace:
```typescript
interface StabilityIndexCurrent {
  score: number;
  band: string;
  components: StabilityIndexComponents;
  computedAt: number;
}
```
With:
```typescript
interface StabilityIndexCurrent {
  score: number;
  band: string;
  components: StabilityIndexComponents;
  contributors?: StabilityContributor[];
  computedAt: number;
}
```

**Step 2: Verify frontend builds**

Run: `npm run build`
Expected: clean build, no type errors. The new field is optional so nothing breaks.

**Step 3: Commit**

```bash
git add src/hooks/use-stability-index.ts
git commit -m "feat(psi): add StabilityContributor type to frontend hook"
```

---

### Task 6: Add ContributorsTable component to the stability index page

**Files:**
- Modify: `src/app/stability-index/client.tsx`

**Step 1: Import the contributor type at the top of the file**

Add to the existing imports (after line 20):

```typescript
import type { StabilityContributor } from "@/hooks/use-stability-index";
```

**Step 2: Add the `ContributorsTable` component**

Place this before the `/* ─── Main Client Component ───` comment (before line 557). This component shows the top PSI contributors sorted by total cost (severity + breadth). The `computeStabilityIndex` function logic is replicated here to compute per-coin severity/breadth from the contributor data — the API provides the raw inputs (`bps`, `mcapUsd`, `factor`) but not the computed severity/breadth per coin.

```typescript
/* ─── Contributors Table ───────────────────────────────────────── */

function ContributorsTable({
  contributors,
  totalMcapUsd,
}: {
  contributors: StabilityContributor[];
  totalMcapUsd: number;
}) {
  const rows = useMemo(() => {
    if (!contributors.length) return [];
    return contributors
      .map((c) => {
        const share = totalMcapUsd > 0 ? c.mcapUsd / totalMcapUsd : 0;
        const amplifier = Math.log2(1 + c.mcapUsd / 1e9);
        const severity = (Math.abs(c.bps) / 100) * share * amplifier * 60 * c.factor;
        const breadth = Math.sqrt(c.mcapUsd / 1e9) * 3 * c.factor;
        return { ...c, severity, breadth, total: severity + breadth };
      })
      .sort((a, b) => b.total - a.total);
  }, [contributors, totalMcapUsd]);

  if (!rows.length) return null;

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h2">Top Contributors</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          Which stablecoins are currently pushing the score below 100, ranked by total impact.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2 pr-4 font-medium text-muted-foreground">Coin</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Deviation</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right hidden sm:table-cell">MCap</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right hidden sm:table-cell">Severity</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right hidden sm:table-cell">Breadth</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground text-right">Total</th>
                <th className="pb-2 font-medium text-muted-foreground text-right">Age</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    <a
                      href={`/stablecoin/${r.id}`}
                      className="font-medium text-foreground hover:text-blue-500 transition-colors"
                    >
                      {r.symbol}
                    </a>
                  </td>
                  <td className={`py-2 pr-4 text-right tabular-nums ${r.bps < 0 ? "text-red-500" : "text-amber-500"}`}>
                    {r.bps > 0 ? "+" : ""}{(r.bps / 100).toFixed(2)}%
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">
                    ${r.mcapUsd >= 1e9 ? `${(r.mcapUsd / 1e9).toFixed(1)}B` : `${(r.mcapUsd / 1e6).toFixed(0)}M`}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">{r.severity.toFixed(2)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums hidden sm:table-cell">{r.breadth.toFixed(2)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums font-medium text-foreground">{r.total.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {r.ageDays < 1 ? "<1d" : `${Math.round(r.ageDays)}d`}
                    {r.factor < 1 && (
                      <span className="ml-1 text-xs text-muted-foreground/60">({Math.round(r.factor * 100)}%)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 3: Compute `totalMcapUsd` from the components and wire the table into the page layout**

We need `totalMcapUsd` for the severity calculation. The simplest source: derive it from the `input_snapshot`. But the API doesn't expose `totalMcapUsd` directly. We can approximate it from component data, but it's cleaner to just pass it through.

**Option chosen:** Add `totalMcapUsd` to the API response alongside `contributors`. Go back to `worker/src/api/stability-index.ts` and add it to the current object:

In the API handler (Task 4, Step 3), the `snapshot` variable already has `totalMcapUsd`. Update the response to include it:

```typescript
  return new Response(JSON.stringify({
    current: {
      score: current.score,
      band: current.band,
      components: JSON.parse(current.components),
      contributors,
      totalMcapUsd: snapshot.totalMcapUsd ?? 0,
      computedAt: current.computed_at,
    },
```

Also update the frontend hook `StabilityIndexCurrent` to include `totalMcapUsd?: number`.

**Step 4: Insert `ContributorsTable` in the page layout**

In the `StabilityIndexClient` return JSX (around line 692), insert between `{/* Historical stat strip */}` and `{/* Score History */}`:

```typescript
      {/* Top Contributors */}
      {data.current.contributors && data.current.contributors.length > 0 && (
        <ContributorsTable
          contributors={data.current.contributors}
          totalMcapUsd={data.current.totalMcapUsd ?? 0}
        />
      )}
```

**Step 5: Verify frontend builds**

Run: `npm run build`
Expected: clean build, no type errors.

**Step 6: Commit**

```bash
git add src/app/stability-index/client.tsx src/hooks/use-stability-index.ts worker/src/api/stability-index.ts
git commit -m "feat(psi): add per-coin contributors table to stability index page

Shows which coins cost how many points, with deviation, mcap, age,
depreciation factor, and severity/breadth breakdown. Responsive —
collapses gracefully on mobile."
```

---

### Task 7: Update the Methodology section and fix incorrect ranges

**Files:**
- Modify: `src/app/stability-index/client.tsx` (Methodology component, lines 453-554)

**Context:** The current methodology section shows wrong component ranges (Severity 0-40, Breadth 0-30, Freezes 0-20, Trend 0-10) vs the actual code (0-60, 0-15, 0-10, -5 to +5). Also needs a depreciation section.

**Step 1: Fix the component range values and descriptions in the methodology table**

Replace the `<tbody>` content (lines 480-501) with corrected values:

```html
              <tbody className="text-muted-foreground">
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Severity</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 60</td>
                  <td className="py-2">Depeg magnitude weighted by market cap significance</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Breadth</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 15</td>
                  <td className="py-2">Number of depegging coins, weighted so micro-caps barely register</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium text-foreground">Freezes</td>
                  <td className="py-2 pr-4 tabular-nums">0 &ndash; 10</td>
                  <td className="py-2">Blacklist/freeze activity in the last 24 hours</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-medium text-foreground">Trend</td>
                  <td className="py-2 pr-4 tabular-nums">&minus;5 to +5</td>
                  <td className="py-2">7-day total market cap momentum</td>
                </tr>
              </tbody>
```

**Step 2: Add depreciation section after the Components section**

Insert after the closing `</div>` of the Components section (after line 503) and before the Condition Bands section:

```html
        <div>
          <h3 className="text-sm font-semibold mb-2">Depreciation</h3>
          <p className="text-sm text-muted-foreground mb-2">
            Chronically depegged coins have their impact reduced over time to prevent zombie stablecoins
            from permanently dominating the score. Fresh depegs (under 30 days) have full impact. After 30 days,
            both severity and breadth contributions decay linearly, reaching a 25% floor at 150 days.
          </p>
        </div>
```

**Step 3: Verify frontend builds**

Run: `npm run build`
Expected: clean build, no errors.

**Step 4: Commit**

```bash
git add src/app/stability-index/client.tsx
git commit -m "fix(psi): correct methodology ranges and add depreciation section

Severity 0-60 (was 0-40), Breadth 0-15 (was 0-30), Freezes 0-10
(was 0-20), Trend -5 to +5 (was 0-10). Added depreciation explanation."
```

---

### Task 8: Update documentation

**Files:**
- Modify: `docs/stability-index.md`

**Step 1: Update the Components table (lines 15-20)**

Replace the components table with updated formulas that include the depreciation factor:

```markdown
| Component | Range | Formula | Purpose |
|-----------|-------|---------|---------|
| **Severity** | 0–60 | `min(60, Σ (abs(bps) / 100 × mcap_share × log₂(1 + mcap / $1B) × 60 × factor))` | Depeg impact weighted by market cap significance |
| **Breadth** | 0–15 | `min(15, Σ sqrt(mcap / $1B) × 3 × factor)` per unique depegged coin | Number of depegging coins, weighted so micro-caps barely register |
| **Freezes** | 0–10 | `min(10, freeze_events_24h × 2.5)` | Blacklist/freeze activity signals operational instability |
| **Trend** | −5 to +5 | `clamp(-5, 5, mcap_7d_change_pct)` | 7-day total market cap momentum |
```

**Step 2: Add Depreciation section after the "Deviation source" section (after line 36)**

```markdown
### Depreciation

Chronically depegged coins have their severity and breadth contributions reduced over time to prevent zombie stablecoins from permanently dominating the score.

```
factor = depegAgeDays ≤ 30 ? 1.0 : max(0.25, 1.0 - (depegAgeDays - 30) / 120)
```

| Age | Factor | Meaning |
|-----|--------|---------|
| 0–30 days | 100% | Full impact — fresh depeg, market-relevant |
| 45 days | 87% | Still significant |
| 60 days | 75% | Fading |
| 90 days | 50% | Half impact |
| 120 days | 25% | Floor reached |
| 120+ days | 25% | Permanent residual |

Age is measured from the **earliest** `started_at` across all active depeg events for a coin.
```

**Step 3: Add Deduplication section after the new Depreciation section**

```markdown
### Deduplication

A coin may have multiple overlapping depeg events (e.g., one event opened at 100bps that's still active when a second event opens at 200bps due to a peg reference change). To avoid double-counting:

1. Events are grouped by `stablecoin_id`
2. For each coin, the event with the **worst current abs(bps)** is used for severity
3. The **earliest `started_at`** across all events determines the depreciation age
4. Each coin contributes exactly **once** to both severity and breadth
```

**Step 4: Add Per-Coin Contributors section before the "Cron & Storage" section**

```markdown
### Per-coin contributors

The cron captures a per-coin breakdown in `input_snapshot.contributors`:

```json
[{ "id": "258", "symbol": "A7A5", "bps": -9871, "mcapUsd": 507000000, "ageDays": 61.2, "factor": 0.74 }]
```

The API surfaces this array in `current.contributors` (not in history). The frontend renders it as a "Top Contributors" table showing each coin's deviation, market cap, age, depreciation factor, and severity/breadth cost.
```

**Step 5: Update Severity scaling description (line 27)**

Replace:
```markdown
- `K = 60` scaling constant, calibrated so a 10bps USDT wobble drops the score ~30 points
```
With:
```markdown
- `K = 60` scaling constant, calibrated so a 10bps USDT wobble drops the score ~30 points. Multiplied by `factor` for depreciation.
```

**Step 6: Update the "Severity and breadth iterate over" line (line 22)**

Replace:
```markdown
Severity and breadth iterate over **active depegs only** (coins currently outside their peg threshold).
```
With:
```markdown
Severity and breadth iterate over **active depegs only** (unique coins currently outside their peg threshold), with depreciation applied to chronic depegs.
```

**Step 7: Commit**

```bash
git add docs/stability-index.md
git commit -m "docs: update PSI documentation with dedup, depreciation, contributors"
```

---

### Task 9: Full verification

**Step 1: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: clean exit, zero errors.

**Step 2: Frontend build**

Run: `npm run build`
Expected: clean build, zero errors.

**Step 3: Verify the compute function behavior manually**

Open a Node REPL or write a quick script to verify:

```typescript
// No depreciation (age 0) — should match original behavior
computeStabilityIndex({
  depegs: [{ bps: 100, mcapUsd: 1e9 }],
  totalMcapUsd: 100e9,
  freezeCount24h: 0,
  mcap7dChangePct: 0,
});

// With depreciation (age 90 days, factor = 0.5)
computeStabilityIndex({
  depegs: [{ bps: 100, mcapUsd: 1e9, depegAgeDays: 90 }],
  totalMcapUsd: 100e9,
  freezeCount24h: 0,
  mcap7dChangePct: 0,
});
// severity and breadth should both be ~50% of the no-depreciation case
```

**Step 4: Commit final**

If any fixes were needed, commit them. Otherwise, this task is just verification — no commit needed.
