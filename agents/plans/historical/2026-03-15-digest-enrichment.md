# Daily Digest Enrichment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the daily digest with expanded word budget, 4 new data sources, cross-day trend context, structured sections, and a weekly recap — transforming it from a tight 80–160 word snapshot into a richer 150–280 word analytical briefing.

**Architecture:** The digest pipeline already collects from 12 data sources via `collectors.ts` and feeds them to an LLM prompt in `daily-digest.ts`. This plan adds 4 new collectors (DEWS sub-signals, PSI contributors, yield anomalies, liquidity shifts), enriches the cross-day trend context from archived `input_data`, restructures the prompt for optional named sections with a higher word budget, and introduces a weekly recap digest that runs on Mondays using the same cron slot.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, Claude API (Opus 4.6), Next.js static export, TanStack Query, Tailwind CSS v4

---

## File Map

### Modified files

| File | Changes |
|------|---------|
| `worker/src/cron/daily-digest.ts` | Expand word budget, restructure system prompt for sections, bump `max_tokens`, add new data to `buildUserPrompt()`, wire new collectors, wire cross-day trends |
| `worker/src/cron/daily-digest/collectors.ts` | Enrich `collectDewsStress()` with sub-signal drivers; add 4 new collector functions: `collectPsiContributors()`, `collectYieldAnomalies()`, `collectLiquidityShifts()`, `collectCrossDayTrends()` |
| `shared/types/digest.ts` | Add new optional fields to `DigestInputData` for sub-signals, PSI contributors, yield anomalies, liquidity shifts, cross-day trends |
| `shared/lib/cron-jobs.ts` | Add `weekly-digest` job definition |
| `worker/src/handlers/scheduled/daily-0805.ts` | Chain `generateWeeklyDigest()` after daily digest on Mondays |
| `worker/src/api/digest-archive.ts` | Extract `digestType` from stored data for weekly vs daily filtering |
| `src/components/daily-digest.tsx` | Render structured section headers (bold inline headers) when present in extended text |
| `src/components/digest-archive-client.tsx` | Show weekly digest badge in wire table; handle `digestType` field |
| `src/components/digest-snapshot.tsx` | Add Yield Anomalies and Liquidity Shifts snapshot cards |
| `docs/digest-pipeline.md` | Update data collection table, word budget, section structure, weekly digest docs |
| `docs/worker-infrastructure.md` | Add weekly-digest job to Trigger 10 docs |
| `worker/src/cron/__tests__/daily-digest.test.ts` | Add tests for new collectors and prompt assembly |

### New files

| File | Purpose |
|------|---------|
| `worker/src/cron/weekly-digest.ts` | Weekly recap generation: collects 7 days of archived `input_data`, builds a weekly-specific prompt, calls Claude, stores result |
| `worker/src/api/weekly-digest.ts` | `GET /api/weekly-digest` — latest weekly digest |

---

## Phase 1: Expand Word Budget & Structured Sections

Prompt-only changes in `daily-digest.ts`. No new collectors, no type changes.

### Task 1: Expand word budget and max_tokens

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`

- [ ] **Step 1: Update density rules in SYSTEM_PROMPT**

In `daily-digest.ts`, find the density contract section (line 98–103). Change:

```
"DENSITY RULES for the extended field: each paragraph should be 30-60 words. Total extended field: 80-160 words. "
```

To:

```
"DENSITY RULES for the extended field: each paragraph should be 40-70 words. Total extended field: 150-280 words. You may write 3-4 paragraphs following the regime structure. "
```

- [ ] **Step 2: Update paragraph structure guidance**

In the narrative structure section (line 80), change:

```
"The extended field is 2-3 paragraphs following the P1/P2/P3 structure above. P3 is optional — two tight paragraphs that say everything beat three that pad. "
```

To:

```
"The extended field is 3-4 paragraphs following the P1/P2/P3/P4 structure above. P3 and P4 are optional — three tight paragraphs that say everything beat four that pad. "
```

- [ ] **Step 3: Bump max_tokens**

Change `max_tokens: 800` (line 516) to `max_tokens: 1400`.

- [ ] **Step 4: Run type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Run tests**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest`
Expected: all existing tests pass

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/daily-digest.ts
git commit -m "feat(digest): expand word budget to 150-280 words and allow 4 paragraphs"
```

### Task 2: Add structured optional sections to prompt

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `src/components/daily-digest.tsx`

- [ ] **Step 1: Add section guidance to SYSTEM_PROMPT**

After the narrative structure section (after line ~83), add a new section directive:

```
"OPTIONAL SECTION HEADERS: When the digest covers two distinct stories, you may use bold inline headers to separate them. " +
"Format: start a paragraph with **Header** (markdown bold) followed by the paragraph text. " +
"Use short, punchy headers (2-4 words): e.g., **Peg Watch**, **Capital Flows**, **Yield Signal**, **Safety Shift**, **Structural Note**. " +
"Do NOT use headers on every paragraph — only when two stories are genuinely distinct. A single-narrative digest needs no headers. " +
"P1 (the lead) should NEVER have a header — it stands alone.\n\n"
```

- [ ] **Step 2: Update digest paragraph renderer to handle bold headers**

In `src/components/daily-digest.tsx`, update the paragraph rendering to detect and render bold inline headers (no changes to `src/lib/digest.ts` needed — handle purely in the component):

```tsx
// Inside the paragraph map, before the <p> element:
const headerMatch = para.match(/^\*\*(.+?)\*\*\s*/);
const headerText = headerMatch?.[1];
const bodyText = headerMatch ? para.slice(headerMatch[0].length) : para;
```

Then render:

```tsx
<p key={i} className={...} style={SERIF}>
  {headerText && (
    <span className="font-semibold not-italic tracking-wide" style={{ fontFamily: "inherit" }}>
      {headerText}.{" "}
    </span>
  )}
  {bodyText}
</p>
```

Apply this to both the preview and full variants.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: builds successfully

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/daily-digest.ts src/components/daily-digest.tsx
git commit -m "feat(digest): add optional structured section headers"
```

---

## Phase 2: Deepen Existing Collectors

### Task 3: Add DEWS sub-signal driver details to elevated coins

**Files:**
- Modify: `shared/types/digest.ts` — add `topSignals` to elevated coins
- Modify: `worker/src/cron/daily-digest/collectors.ts` — enrich `collectDewsStress()`
- Modify: `worker/src/cron/daily-digest.ts` — update `buildUserPrompt()` DEWS section

- [ ] **Step 1: Extend DigestInputData type**

In `shared/types/digest.ts`, add `topSignals` to the `elevatedCoins` array inside `dewsStress`:

```ts
elevatedCoins: {
  symbol: string;
  band: string;
  score: number;
  mcapUsd: number;
  topSignals?: { name: string; value: number }[];  // NEW: top 3 sub-signal drivers
}[];
```

- [ ] **Step 2: Enrich collector to extract sub-signals**

In `collectors.ts`, inside the `collectDewsStress()` function, where `elevatedCoins` are built (around line 435-443), parse `signals_json` for each elevated coin and extract top 3 drivers:

```ts
const elevatedCoins = todayRows
  .filter((r) => ALERT_BANDS.has(r.band))
  .map((r) => {
    const coin = ctx.trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
    if (!coin) return null;

    // Extract top 3 sub-signal drivers
    let topSignals: { name: string; value: number }[] = [];
    try {
      const signals = JSON.parse(r.signals_json) as Record<string, { value: number; available: boolean }>;
      topSignals = Object.entries(signals)
        .filter(([, sig]) => sig.available && sig.value > 0)
        .sort(([, a], [, b]) => b.value - a.value)
        .slice(0, 3)
        .map(([key, sig]) => ({ name: SIGNAL_LABELS[key] ?? key, value: Math.round(sig.value) }));
    } catch { /* ignore */ }

    return {
      symbol: coin.symbol, band: r.band, score: r.score,
      mcapUsd: getCirculatingRaw(coin), topSignals,
    };
  })
  .filter((r): r is NonNullable<typeof r> => r !== null && r.mcapUsd > 10_000_000)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);
```

- [ ] **Step 3: Update buildUserPrompt to show sub-signals**

In `daily-digest.ts`, in the DEWS elevated coins section (around line 243-246), update the format:

```ts
if (elevatedCoins.length > 0) {
  lines.push("  Elevated coins (ALERT+):");
  for (const c of elevatedCoins) {
    const driverStr = c.topSignals?.length
      ? `, driven by ${c.topSignals.map((s) => `${s.name}=${s.value}`).join(", ")}`
      : "";
    lines.push(`    ${c.symbol}: ${c.band} (score ${c.score}, mcap ${formatCurrency(c.mcapUsd)}${driverStr})`);
  }
}
```

- [ ] **Step 4: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors.ts worker/src/cron/daily-digest.ts
git commit -m "feat(digest): surface DEWS sub-signal drivers for elevated coins"
```

### Task 4: Add PSI contributor attribution

**Files:**
- Modify: `shared/types/digest.ts` — add `psiContributors` field
- Modify: `worker/src/cron/daily-digest/collectors.ts` — add `collectPsiContributors()`
- Modify: `worker/src/cron/daily-digest.ts` — wire collector and add to prompt

- [ ] **Step 1: Add type**

In `shared/types/digest.ts`, add to `DigestInputData`:

```ts
psiContributors?: {
  symbol: string;
  bps: number;
  mcapUsd: number;
  marketImpact: number;  // relative ranking heuristic (|bps| x mcap x factor), NOT actual PSI severity
}[];
```

- [ ] **Step 2: Write collector**

In `collectors.ts`, add:

```ts
export async function collectPsiContributors(
  ctx: CollectorContext,
): Promise<DigestInputData["psiContributors"]> {
  try {
    const latestSample = await ctx.db
      .prepare("SELECT input_snapshot FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ input_snapshot: string }>();
    if (!latestSample) return undefined;

    const snapshot = JSON.parse(latestSample.input_snapshot) as {
      contributors?: { id: string; symbol: string; bps: number; mcapUsd: number; ageDays: number; factor: number }[];
    };
    // contributors is empty when no depegs are active — that's expected during CALM regime
    if (!snapshot.contributors || snapshot.contributors.length === 0) return undefined;

    // Rank by market-impact heuristic (|bps| x mcap x factor) for editorial ranking.
    // This is NOT the actual PSI severity formula — it's a simpler relative ranking.
    return snapshot.contributors
      .map((c) => ({
        symbol: c.symbol,
        bps: c.bps,
        mcapUsd: c.mcapUsd,
        marketImpact: Math.round(Math.abs(c.bps) * c.mcapUsd / 1e9 * c.factor * 10) / 10,
      }))
      .sort((a, b) => b.marketImpact - a.marketImpact)
      .slice(0, 3);
  } catch (e) {
    console.error("[daily-digest] Failed to collect PSI contributors:", e);
    return undefined;
  }
}
```

- [ ] **Step 3: Wire collector in daily-digest.ts**

After the existing `collectHistoricalContext()` call (around line 478), add:

```ts
const psiContributors = await collectPsiContributors(ctx);
```

Add to imports:

```ts
import { ..., collectPsiContributors } from "./daily-digest/collectors";
```

Add to `inputData` object:

```ts
psiContributors,
```

- [ ] **Step 4: Add PSI contributors to buildUserPrompt**

After the PSI stability index section (around line 171), add:

```ts
if (data.psiContributors && data.psiContributors.length > 0) {
  lines.push("  PSI severity contributors (top coins driving the score):");
  for (const c of data.psiContributors) {
    lines.push(`    ${c.symbol}: ${c.bps} bps, mcap ${formatCurrency(c.mcapUsd)}, impact ${c.marketImpact}`);
  }
}
```

- [ ] **Step 5: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors.ts worker/src/cron/daily-digest.ts
git commit -m "feat(digest): add PSI contributor attribution to digest data"
```

---

## Phase 3: New Data Source Collectors

### Task 5: Add yield anomaly collector

**Files:**
- Modify: `shared/types/digest.ts` — add `yieldAnomalies` field
- Modify: `worker/src/cron/daily-digest/collectors.ts` — add `collectYieldAnomalies()`
- Modify: `worker/src/cron/daily-digest.ts` — wire collector, add to prompt, update regime priorities

- [ ] **Step 1: Add type**

In `shared/types/digest.ts`, add to `DigestInputData`:

```ts
yieldAnomalies?: {
  symbol: string;
  currentApy: number;
  apy7d: number;
  apy30d: number;
  warnings: string[];  // e.g. ["spike", "divergence", "tvl-outflow"]
  mcapUsd: number;
}[];
```

- [ ] **Step 2: Write collector**

In `collectors.ts`, add:

```ts
export async function collectYieldAnomalies(
  ctx: CollectorContext,
): Promise<DigestInputData["yieldAnomalies"]> {
  try {
    // Get yield-bearing coins with active warnings from best-source rows
    const rows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, symbol, current_apy, apy_7d, apy_30d, warning_signals
         FROM yield_data
         WHERE is_best = 1 AND warning_signals IS NOT NULL AND warning_signals != '[]'
         ORDER BY current_apy DESC`,
      )
      .all<{
        stablecoin_id: string; symbol: string;
        current_apy: number; apy_7d: number; apy_30d: number;
        warning_signals: string;
      }>();

    const candidates = (rows.results ?? [])
      .map((r) => {
        let warnings: string[] = [];
        try { warnings = JSON.parse(r.warning_signals) as string[]; } catch { /* ignore */ }
        if (warnings.length === 0) return null;

        const mcapUsd = ctx.mcapById.get(r.stablecoin_id) ?? 0;
        // Only include coins with meaningful market cap
        if (mcapUsd < 10_000_000) return null;

        return {
          symbol: r.symbol,
          currentApy: Math.round(r.current_apy * 100) / 100,
          apy7d: Math.round(r.apy_7d * 100) / 100,
          apy30d: Math.round(r.apy_30d * 100) / 100,
          warnings,
          mcapUsd,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      // Sort by market impact (mcap × number of warnings)
      .sort((a, b) => b.mcapUsd * b.warnings.length - a.mcapUsd * a.warnings.length)
      .slice(0, 5);

    return candidates.length > 0 ? candidates : undefined;
  } catch (e) {
    console.error("[daily-digest] Failed to collect yield anomalies:", e);
    return undefined;
  }
}
```

- [ ] **Step 3: Wire collector and add to prompt**

In `daily-digest.ts`:

Import: `collectYieldAnomalies`

Call after other collectors:
```ts
const yieldAnomalies = await collectYieldAnomalies(ctx);
```

Add to `inputData`:
```ts
yieldAnomalies,
```

Add to `buildUserPrompt()`, after the safety scores section:

```ts
if (data.yieldAnomalies && data.yieldAnomalies.length > 0) {
  lines.push("", "Yield Anomalies:");
  for (const y of data.yieldAnomalies) {
    lines.push(
      `  ${y.symbol}: ${y.currentApy}% APY (7d avg ${y.apy7d}%, 30d avg ${y.apy30d}%), mcap ${formatCurrency(y.mcapUsd)}, warnings: ${y.warnings.join(", ")}`,
    );
  }
}
```

- [ ] **Step 4: Update regime enrichment priorities in SYSTEM_PROMPT**

In the regime-aware section (around lines 49-61), add yield signals to the priority lists:

Add to WATCHFUL priority:
```
"Yield anomalies (APY spikes, divergence)"
```

Add to CALM priority:
```
"yield anomalies"
```

- [ ] **Step 5: Update lead signal options in meta guidance**

In the meta field guidance (line 88), add `"yield-anomaly"` to the list of valid lead values.

- [ ] **Step 6: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors.ts worker/src/cron/daily-digest.ts
git commit -m "feat(digest): add yield anomaly signals to digest data"
```

### Task 6: Add DEX liquidity shift collector

**Files:**
- Modify: `shared/types/digest.ts` — add `liquidityShifts` field
- Modify: `worker/src/cron/daily-digest/collectors.ts` — add `collectLiquidityShifts()`
- Modify: `worker/src/cron/daily-digest.ts` — wire collector and add to prompt

- [ ] **Step 1: Add type**

In `shared/types/digest.ts`, add to `DigestInputData`:

```ts
liquidityShifts?: {
  symbol: string;
  currentScore: number;
  previousScore: number;
  scoreDelta: number;
  currentTvl: number;
  previousTvl: number;
  mcapUsd: number;
}[];
```

- [ ] **Step 2: Write collector**

In `collectors.ts`, add:

```ts
export async function collectLiquidityShifts(
  ctx: CollectorContext,
): Promise<DigestInputData["liquidityShifts"]> {
  try {
    // Compare yesterday vs day-before-yesterday.
    // The digest runs at 08:05 UTC — today's midnight snapshot may not be written yet
    // since dex_liquidity_history snapshots are written by the 10/40 cron, and the
    // "today" row for todayTs may not exist until the first :10 or :40 run of the day.
    const dayBeforeYesterday = ctx.yesterdayTs - SECONDS.ONE_DAY;
    const rows = await ctx.db
      .prepare(
        `SELECT h.stablecoin_id, h.liquidity_score, h.total_tvl_usd, h.snapshot_date
         FROM dex_liquidity_history h
         WHERE h.snapshot_date IN (?, ?)
           AND h.liquidity_score IS NOT NULL
         ORDER BY h.stablecoin_id, h.snapshot_date DESC`,
      )
      .bind(ctx.yesterdayTs, dayBeforeYesterday)
      .all<{ stablecoin_id: string; liquidity_score: number; total_tvl_usd: number; snapshot_date: number }>();

    // Group by coin: yesterday (latest) vs day-before-yesterday (previous)
    const byId = new Map<string, { latest?: typeof rows.results[0]; previous?: typeof rows.results[0] }>();
    for (const r of rows.results ?? []) {
      const entry = byId.get(r.stablecoin_id) ?? {};
      if (r.snapshot_date === ctx.yesterdayTs) entry.latest = r;
      else entry.previous = r;
      byId.set(r.stablecoin_id, entry);
    }

    const shifts: NonNullable<DigestInputData["liquidityShifts"]> = [];
    for (const [id, { latest, previous }] of byId) {
      if (!latest || !previous) continue;
      const delta = latest.liquidity_score - previous.liquidity_score;
      // Only report significant shifts (>= 8 points)
      if (Math.abs(delta) < 8) continue;

      const mcapUsd = ctx.mcapById.get(id) ?? 0;
      if (mcapUsd < 10_000_000) continue;

      const coin = ctx.trackedStablecoinAssets.find((c) => c.id === id);
      if (!coin) continue;

      shifts.push({
        symbol: coin.symbol,
        currentScore: latest.liquidity_score,
        previousScore: previous.liquidity_score,
        scoreDelta: delta,
        currentTvl: latest.total_tvl_usd,
        previousTvl: previous.total_tvl_usd,
        mcapUsd,
      });
    }

    // Sort by magnitude of shift × mcap
    shifts.sort((a, b) => Math.abs(b.scoreDelta) * b.mcapUsd - Math.abs(a.scoreDelta) * a.mcapUsd);

    return shifts.length > 0 ? shifts.slice(0, 5) : undefined;
  } catch (e) {
    console.error("[daily-digest] Failed to collect liquidity shifts:", e);
    return undefined;
  }
}
```

- [ ] **Step 3: Wire collector and add to prompt**

In `daily-digest.ts`:

Import: `collectLiquidityShifts`

Call:
```ts
const liquidityShifts = await collectLiquidityShifts(ctx);
```

Add to `inputData`:
```ts
liquidityShifts,
```

Add to `buildUserPrompt()`:

```ts
if (data.liquidityShifts && data.liquidityShifts.length > 0) {
  lines.push("", "DEX Liquidity Shifts (day-over-day):");
  for (const l of data.liquidityShifts) {
    const dir = l.scoreDelta > 0 ? "+" : "";
    lines.push(
      `  ${l.symbol}: score ${l.previousScore} -> ${l.currentScore} (${dir}${l.scoreDelta}), TVL ${formatCurrency(l.previousTvl)} -> ${formatCurrency(l.currentTvl)}, mcap ${formatCurrency(l.mcapUsd)}`,
    );
  }
}
```

- [ ] **Step 4: Add liquidity to regime priorities and lead options**

In SYSTEM_PROMPT regime section, add `"liquidity-shift"` as a valid lead option and mention liquidity shifts in WATCHFUL/TENSION priority lists.

- [ ] **Step 5: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors.ts worker/src/cron/daily-digest.ts
git commit -m "feat(digest): add DEX liquidity shift tracking to digest data"
```

---

## Phase 4: Cross-Day Trend Context

### Task 7: Add cross-day trend annotations

**Files:**
- Modify: `shared/types/digest.ts` — add `crossDayTrends` field
- Modify: `worker/src/cron/daily-digest/collectors.ts` — add `collectCrossDayTrends()`
- Modify: `worker/src/cron/daily-digest.ts` — wire collector and add to prompt

- [ ] **Step 1: Add type**

In `shared/types/digest.ts`, add to `DigestInputData`:

```ts
crossDayTrends?: {
  psiTrajectory: { date: string; score: number; band: string }[];     // last 7 days
  mcapTrajectory: { date: string; mcapUsd: number }[];                 // last 7 days
  gaugeTrajectory: { date: string; gaugeScore: number }[] | null;      // last 7 days if available
};
```

- [ ] **Step 2: Write collector**

In `collectors.ts`, add:

```ts
export async function collectCrossDayTrends(
  ctx: CollectorContext,
): Promise<DigestInputData["crossDayTrends"]> {
  try {
    // Get last 7 daily digests' input_data (exclude weekly entries)
    const rows = await ctx.db
      .prepare(
        `SELECT generated_at, input_data FROM daily_digest
         WHERE generated_at >= ?
           AND (digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly')
         ORDER BY generated_at DESC
         LIMIT 7`,
      )
      .bind(ctx.nowSec - 7 * SECONDS.ONE_DAY)
      .all<{ generated_at: number; input_data: string }>();

    const entries = rows.results ?? [];
    if (entries.length < 3) return undefined;  // need at least 3 days for a trend

    const psiTrajectory: { date: string; score: number; band: string }[] = [];
    const mcapTrajectory: { date: string; mcapUsd: number }[] = [];
    const gaugeTrajectory: { date: string; gaugeScore: number }[] = [];

    for (const row of entries) {
      try {
        const data = JSON.parse(row.input_data) as DigestInputData;
        const date = new Date(row.generated_at * 1000).toISOString().slice(0, 10);

        if (data.stabilityIndex) {
          psiTrajectory.push({ date, score: data.stabilityIndex.score, band: data.stabilityIndex.band });
        }
        mcapTrajectory.push({ date, mcapUsd: data.totalMcapUsd });
        if (data.mintBurnFlows) {
          gaugeTrajectory.push({ date, gaugeScore: data.mintBurnFlows.gaugeScore });
        }
      } catch { /* skip malformed entries */ }
    }

    // Reverse to chronological order (oldest first)
    psiTrajectory.reverse();
    mcapTrajectory.reverse();
    gaugeTrajectory.reverse();

    return {
      psiTrajectory,
      mcapTrajectory,
      gaugeTrajectory: gaugeTrajectory.length >= 3 ? gaugeTrajectory : null,
    };
  } catch (e) {
    console.error("[daily-digest] Failed to collect cross-day trends:", e);
    return undefined;
  }
}
```

- [ ] **Step 3: Wire collector**

In `daily-digest.ts`, import and call `collectCrossDayTrends(ctx)`. Add result to `inputData`.

- [ ] **Step 4: Add trends to buildUserPrompt**

After the PSI section and before enrichment data, add:

```ts
if (data.crossDayTrends) {
  const { psiTrajectory, mcapTrajectory, gaugeTrajectory } = data.crossDayTrends;
  if (psiTrajectory.length >= 3) {
    lines.push(
      `PSI 7-day trajectory: ${psiTrajectory.map((p) => `${p.score} [${p.band}]`).join(" -> ")}`,
    );
  }
  if (mcapTrajectory.length >= 3) {
    lines.push(
      `Market cap 7-day trajectory: ${mcapTrajectory.map((m) => formatCurrency(m.mcapUsd)).join(" -> ")}`,
    );
  }
  if (gaugeTrajectory && gaugeTrajectory.length >= 3) {
    lines.push(
      `Bank Run Gauge 7-day trajectory: ${gaugeTrajectory.map((g) => Math.round(g.gaugeScore * 10) / 10).join(" -> ")}`,
    );
  }
}
```

- [ ] **Step 5: Update historical context guidance in SYSTEM_PROMPT**

Add to the historical context instruction (around line 63):

```
"You also receive 7-day trajectories for PSI, mcap, and gauge. Use these to identify multi-day trends: " +
"\"third consecutive day of gauge deterioration\" or \"PSI recovering from Monday's dip\" are more compelling than point-in-time comparisons.\n\n"
```

- [ ] **Step 6: Run type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add shared/types/digest.ts worker/src/cron/daily-digest/collectors.ts worker/src/cron/daily-digest.ts
git commit -m "feat(digest): add cross-day trend trajectories for PSI, mcap, and gauge"
```

---

## Phase 5: Weekly Recap Digest

### Task 8: Create weekly digest generator

**Files:**
- Create: `worker/src/cron/weekly-digest.ts`

- [ ] **Step 1: Create weekly digest module**

Create `worker/src/cron/weekly-digest.ts` with:

```ts
import type { DigestInputData } from "@shared/types";
import { formatCurrency } from "@shared/lib/format";
import { type CronResult } from "../lib/cron-logger";
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
import { fetchWithRetry } from "../lib/fetch-retry";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import { DigestResponseSchema } from "../lib/schemas";

const WEEKLY_SYSTEM_PROMPT = /* ... see step 2 ... */;

interface WeeklyInputData {
  weekStartDate: string;  // YYYY-MM-DD (Monday)
  weekEndDate: string;    // YYYY-MM-DD (Sunday)
  dailyDigests: { date: string; title: string; text: string; inputData: DigestInputData }[];
  psiRange: { min: number; max: number; start: number; end: number; dominantBand: string };
  mcapRange: { start: number; end: number; netChange: number; pctChange: number };
  totalDepegsThisWeek: number;
  totalBlacklistEventsThisWeek: number;
  gradeTransitionCount: number;
  gaugeRange: { min: number; max: number } | null;
}

function buildWeeklyInputData(
  dailyRows: { generated_at: number; digest_title: string | null; digest_text: string; input_data: string }[],
): WeeklyInputData | null {
  // Parse and aggregate 7 days of daily digest input_data
  // ... implementation details below
}

function buildWeeklyPrompt(data: WeeklyInputData): string {
  // Build a comprehensive weekly context prompt
  // ... implementation details below
}

export async function generateWeeklyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
): Promise<CronResult> {
  if (!anthropicApiKey) {
    return { metadata: "skipped: no API key" };
  }

  // Check if today is Monday (UTC)
  const now = new Date();
  if (now.getUTCDay() !== 1) {
    return { metadata: "skipped: not Monday" };
  }

  // Check if weekly digest already exists for this week
  // D1 supports json_extract() — use it instead of fragile LIKE patterns on JSON text
  const weekStart = Math.floor(Date.now() / 1000) - 2 * SECONDS.ONE_DAY; // generous window
  const existing = await db
    .prepare("SELECT id FROM daily_digest WHERE generated_at >= ? AND json_extract(digest_meta, '$.type') = 'weekly'")
    .bind(weekStart)
    .first();
  if (existing) {
    return { metadata: "skipped: weekly digest already exists" };
  }

  // Fetch last 7 daily digests (exclude weekly entries)
  const cutoff = Math.floor(Date.now() / 1000) - 8 * SECONDS.ONE_DAY;
  const dailyRows = await db
    .prepare(
      `SELECT generated_at, digest_title, digest_text, digest_extended, input_data
       FROM daily_digest
       WHERE generated_at >= ? AND (digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly')
       ORDER BY generated_at ASC`,
    )
    .bind(cutoff)
    .all<{ generated_at: number; digest_title: string | null; digest_text: string; digest_extended: string | null; input_data: string }>();

  const rows = dailyRows.results ?? [];
  if (rows.length < 5) {
    return { metadata: `skipped: only ${rows.length} daily digests available (need 5+)` };
  }

  const weeklyData = buildWeeklyInputData(rows);
  if (!weeklyData) {
    return { metadata: "skipped: failed to build weekly input data" };
  }

  const userPrompt = buildWeeklyPrompt(weeklyData);

  const response = await fetchWithRetry(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 2000,
        system: WEEKLY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    },
    2,
    { timeoutMs: 120_000 },
  );

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "no response after retries";
    throw new Error(`Claude API error: ${typeof errorText === "string" ? errorText.slice(0, 500) : errorText}`);
  }

  const result = (await response.json()) as { content?: { type: string; text: string }[] };
  const rawText = result.content?.[0]?.text ?? "";
  if (!rawText) throw new Error("Claude API returned empty weekly digest text");

  // Parse JSON response (same extraction logic as daily)
  let jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const braceStart = jsonText.indexOf("{");
  if (braceStart !== -1) {
    let depth = 0, braceEnd = -1;
    for (let i = braceStart; i < jsonText.length; i++) {
      if (jsonText[i] === "{") depth++;
      else if (jsonText[i] === "}") { depth--; if (depth === 0) { braceEnd = i; break; } }
    }
    if (braceEnd !== -1) jsonText = jsonText.slice(braceStart, braceEnd + 1);
  }

  const stripDashes = (s: string) => s.replace(/[\u2013\u2014]/g, ",");
  let digestTitle: string, digestText: string, digestExtended: string;
  let digestMeta: string;

  try {
    const raw = JSON.parse(jsonText);
    const parsed = DigestResponseSchema.parse(raw);
    digestTitle = stripDashes(parsed.title.trim());
    digestText = stripDashes(parsed.text.trim());
    digestExtended = stripDashes(parsed.extended.trim());
    if (!digestText) throw new Error("empty text field");
    digestMeta = JSON.stringify({
      ...(parsed.meta ?? {}),
      type: "weekly",
      weekStart: weeklyData.weekStartDate,
      weekEnd: weeklyData.weekEndDate,
    });
  } catch {
    digestTitle = "";
    digestText = stripDashes(rawText.trim());
    digestExtended = "";
    digestMeta = JSON.stringify({ type: "weekly" });
  }

  // Store
  const nowSec = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(nowSec, digestText, digestTitle || null, JSON.stringify(weeklyData), digestExtended || null, digestMeta)
    .run();

  // Post to Telegram
  let telegramStatus = "no-creds";
  if (telegramCreds) {
    const allowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.TELEGRAM_API);
    if (!allowed) {
      telegramStatus = "skipped: circuit-open";
    } else {
      try {
        const weekLabel = `Week of ${weeklyData.weekStartDate}`;
        const tgTitle = `Weekly Recap: ${digestTitle || weekLabel}`;
        const date = new Date(nowSec * 1000).toISOString().slice(0, 10);
        await postDigestToTelegram(tgTitle, digestExtended, date, telegramCreds);
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TELEGRAM_API, true);
        telegramStatus = "ok";
      } catch (err) {
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.TELEGRAM_API, false);
        telegramStatus = `failed: ${String(err).slice(0, 100)}`;
      }
    }
  }

  return {
    itemCount: 1,
    metadata: `weekly: ${digestText.length} chars, telegram: ${telegramStatus}`,
  };
}
```

- [ ] **Step 2: Write weekly system prompt**

The weekly system prompt should be shorter and focused on synthesis:

```ts
const WEEKLY_SYSTEM_PROMPT =
  "You write the weekly editorial recap for Pharos, a stablecoin analytics dashboard. " +
  "Your voice is dry, sharp, and memorable. Think sardonic wit meets hard data.\n\n" +
  "You receive a week's worth of daily digest data. Your job is to synthesize, not summarize. " +
  "Find the week's narrative arc: what started, what ended, what's building. " +
  "A weekly recap that reads like seven daily digests stapled together has failed.\n\n" +
  "No emojis, no clickbait, no hedging, no exclamation marks. " +
  "NEVER use em dashes or en dashes. Use commas, semicolons, colons, or periods instead.\n\n" +
  "The extended field should be 4-6 paragraphs, 250-400 words total. Structure:\n" +
  "P1: The week's headline — what defined it. PSI arc and dominant regime.\n" +
  "P2: The dominant story — the thread that ran through multiple days.\n" +
  "P3: The counter-narrative — what moved in the opposite direction, or what was quietly significant.\n" +
  "P4: Supply and capital flows — weekly mcap movement, biggest movers, gauge trend.\n" +
  "P5-P6 (optional): A structural observation or look-ahead.\n\n" +
  "Every sentence must contain a specific number or coin name. " +
  "Reference individual daily headlines when they illustrate a point.\n\n" +
  "You MUST respond with valid JSON: {\"title\": \"...\", \"extended\": \"...\", \"text\": \"...\", \"meta\": {\"lead\": \"...\", \"tone\": \"...\", \"coins\": [...]}}. " +
  "Output ONLY the raw JSON object. The title is 3-8 words capturing the week's theme. " +
  "The text field is a tweet-sized hook. Title + text must be under 270 chars combined.";
```

- [ ] **Step 3: Implement buildWeeklyInputData**

```ts
function buildWeeklyInputData(
  dailyRows: { generated_at: number; digest_title: string | null; digest_text: string; input_data: string }[],
): WeeklyInputData | null {
  const parsed: { date: string; title: string; text: string; inputData: DigestInputData }[] = [];
  for (const row of dailyRows) {
    try {
      const inputData = JSON.parse(row.input_data) as DigestInputData;
      const date = new Date(row.generated_at * 1000).toISOString().slice(0, 10);
      parsed.push({ date, title: row.digest_title ?? "Untitled", text: row.digest_text, inputData });
    } catch { /* skip malformed */ }
  }
  if (parsed.length < 5) return null;

  const psiScores = parsed.map((d) => d.inputData.stabilityIndex?.score).filter((s): s is number => s != null);
  const psiBands = parsed.map((d) => d.inputData.stabilityIndex?.band).filter((b): b is string => b != null);
  const mcaps = parsed.map((d) => d.inputData.totalMcapUsd);
  const gauges = parsed.map((d) => d.inputData.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);

  // Guard against empty arrays (Math.min/max on empty spread returns Infinity/-Infinity)
  if (psiScores.length === 0 || mcaps.length === 0) return null;

  // Dominant band = most frequent
  const bandFreq = new Map<string, number>();
  for (const b of psiBands) bandFreq.set(b, (bandFreq.get(b) ?? 0) + 1);
  const dominantBand = [...bandFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "BEDROCK";

  const totalDepegs = parsed.reduce((sum, d) => sum + d.inputData.activeDepegCount, 0);
  const totalBlacklist = parsed.reduce((sum, d) => sum + (d.inputData.blacklistActivity?.eventCount ?? 0), 0);
  const gradeTransitionCount = parsed.reduce((sum, d) => sum + (d.inputData.gradeTransitions?.length ?? 0), 0);

  return {
    weekStartDate: parsed[0].date,
    weekEndDate: parsed[parsed.length - 1].date,
    dailyDigests: parsed,
    psiRange: {
      min: Math.min(...psiScores),
      max: Math.max(...psiScores),
      start: psiScores[0],
      end: psiScores[psiScores.length - 1],
      dominantBand,
    },
    mcapRange: {
      start: mcaps[0],
      end: mcaps[mcaps.length - 1],
      netChange: mcaps[mcaps.length - 1] - mcaps[0],
      pctChange: ((mcaps[mcaps.length - 1] - mcaps[0]) / mcaps[0]) * 100,
    },
    totalDepegsThisWeek: totalDepegs,
    totalBlacklistEventsThisWeek: totalBlacklist,
    gradeTransitionCount,
    gaugeRange: gauges.length >= 3 ? { min: Math.min(...gauges), max: Math.max(...gauges) } : null,
  };
}
```

- [ ] **Step 4: Implement buildWeeklyPrompt**

```ts
function buildWeeklyPrompt(data: WeeklyInputData): string {
  const lines: string[] = [
    `Weekly recap: ${data.weekStartDate} to ${data.weekEndDate}`,
    "",
    `PSI range: ${data.psiRange.min} to ${data.psiRange.max} (start: ${data.psiRange.start}, end: ${data.psiRange.end})`,
    `Dominant band: ${data.psiRange.dominantBand}`,
    `Market cap: ${formatCurrency(data.mcapRange.start)} -> ${formatCurrency(data.mcapRange.end)} (${data.mcapRange.pctChange >= 0 ? "+" : ""}${data.mcapRange.pctChange.toFixed(2)}%)`,
    `Total depeg events across the week: ${data.totalDepegsThisWeek}`,
    `Total blacklist events: ${data.totalBlacklistEventsThisWeek}`,
    `Grade transitions: ${data.gradeTransitionCount}`,
  ];

  if (data.gaugeRange) {
    lines.push(`Bank Run Gauge range: ${Math.round(data.gaugeRange.min * 10) / 10} to ${Math.round(data.gaugeRange.max * 10) / 10}`);
  }

  lines.push("", "Daily digest headlines:");
  for (const d of data.dailyDigests) {
    const psi = d.inputData.stabilityIndex;
    lines.push(`  ${d.date}: "${d.title}" — PSI ${psi?.score ?? "?"} [${psi?.band ?? "?"}], mcap ${formatCurrency(d.inputData.totalMcapUsd)}`);
  }

  lines.push("", "Daily digest summaries:");
  for (const d of data.dailyDigests) {
    lines.push(`  ${d.date}: ${d.text}`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/weekly-digest.ts
git commit -m "feat(digest): add weekly recap digest generator"
```

### Task 9: Wire weekly digest into cron scheduler

**Files:**
- Modify: `worker/src/handlers/scheduled/daily-0805.ts`
- Modify: `shared/lib/cron-jobs.ts`

- [ ] **Step 1: Register weekly-digest job**

In `shared/lib/cron-jobs.ts`, add to `CRON_JOB_DEFINITIONS_BASE`:

```ts
{
  job: "weekly-digest",
  label: "Weekly digest",
  group: "daily",
  intervalSec: 604800,  // 7 days
  scheduleKey: "daily0805Utc",
  triggerMode: "shared",
},
```

- [ ] **Step 2: Chain weekly after daily in scheduled handler**

In `worker/src/handlers/scheduled/daily-0805.ts`, import and chain:

```ts
import { generateWeeklyDigest } from "../../cron/weekly-digest";

export function runDaily0805Slot(runtime: ScheduledRuntimeContext): void {
  runtime.ctx.waitUntil(runtime.runLeasedCron("sync-bluechip", (signal) => syncBluechip(runtime.db, signal)));

  // Chain weekly digest after daily — sequential to share connection pool.
  // The weekly-digest runs in its own runLeasedCron so failures are recorded
  // independently in cron_runs. A daily-digest failure still allows the weekly
  // to attempt (it reads from D1, not from the daily result).
  runtime.ctx.waitUntil(
    runtime.runLeasedCron("daily-digest", (signal) => {
      return generateDailyDigest(
        runtime.db,
        runtime.env.ANTHROPIC_API_KEY ?? null,
        buildTwitterCreds(runtime.env),
        false,
        buildTelegramCreds(runtime.env),
        signal,
      );
    }).finally(() =>
      runtime.runLeasedCron("weekly-digest", (signal) => {
        return generateWeeklyDigest(
          runtime.db,
          runtime.env.ANTHROPIC_API_KEY ?? null,
          buildTelegramCreds(runtime.env),
          signal,
        );
      }),
    ),
  );

  runtime.ctx.waitUntil(runtime.runLeasedCron("discovery-scan", (signal) => runDiscoveryScan(runtime.db, signal, runtime.coingeckoApiKey)));
}
```

Key design notes:
- Uses `.finally()` instead of `.then()` so the weekly digest runs even if the daily digest fails. The weekly reads stored `input_data` from D1, so it doesn't depend on the daily result.
- Both `runLeasedCron` calls record independently in `cron_runs`, so status-page visibility is preserved for both.
- The weekly digest function checks `if today is Monday` and returns immediately on other days, so this adds zero cost on non-Mondays.
- Sequential chaining means the Anthropic API calls never overlap — connection budget stays at 5 concurrent max on Trigger 10.
- `sync-bluechip` (3 parallel batch connections) and `discovery-scan` (1 CoinGecko call) run via separate `waitUntil()` calls. By the time the weekly digest starts its Anthropic call (~120s after trigger), bluechip has long finished. Total concurrent connections never exceed 5.

- [ ] **Step 3: Run type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add shared/lib/cron-jobs.ts worker/src/handlers/scheduled/daily-0805.ts
git commit -m "feat(digest): wire weekly digest into Monday cron schedule"
```

### Task 10: Add weekly digest API endpoint and frontend support

**Files:**
- Modify: `worker/src/api/digest-archive.ts` — add `digestType` to archive entries
- Modify: `src/components/digest-archive-client.tsx` — show weekly badge
- Modify: `shared/types/digest.ts` — add `digestType` to archive entry type

- [ ] **Step 1: Add digestType to archive response**

In `shared/types/digest.ts`, add to `DigestArchiveEntry`:

```ts
digestType?: "daily" | "weekly";
```

In `worker/src/api/digest-archive.ts`, add `digest_meta` to the SELECT query (it's currently not selected). Find the existing SELECT statement and add the column:

```sql
SELECT generated_at, digest_text, digest_title, digest_extended, input_data, digest_meta
FROM daily_digest ORDER BY generated_at DESC LIMIT 365
```

Then when building the response objects, extract `type` from `digest_meta`:

```ts
let digestType: "daily" | "weekly" = "daily";
if (row.digest_meta) {
  try {
    const meta = JSON.parse(row.digest_meta as string);
    if (meta.type === "weekly") digestType = "weekly";
  } catch { /* ignore */ }
}
```

Include `digestType` in the response object.

- [ ] **Step 2: Show weekly badge in archive UI**

In `src/components/digest-archive-client.tsx`, when rendering each wire row, check `digestType`:

```tsx
{entry.digestType === "weekly" && (
  <span className="rounded bg-accent/60 px-1.5 py-0.5 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-accent-foreground/80">
    Weekly
  </span>
)}
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: builds successfully

- [ ] **Step 4: Commit**

```bash
git add shared/types/digest.ts worker/src/api/digest-archive.ts src/components/digest-archive-client.tsx
git commit -m "feat(digest): add weekly digest type to archive API and frontend"
```

---

## Phase 6: Snapshot Cards for New Data Sources

### Task 11: Add yield and liquidity snapshot cards

**Files:**
- Modify: `src/components/digest-snapshot.tsx` — add Yield Anomalies and Liquidity Shifts cards

- [ ] **Step 1: Add Yield Anomalies card**

In `digest-snapshot.tsx`, after the existing Safety Scores card, add a new card for yield anomalies when present in `inputData`:

```tsx
{inputData.yieldAnomalies && inputData.yieldAnomalies.length > 0 && (
  <SnapshotCard title="Yield Anomalies" icon={<TrendingUp className="h-4 w-4" />} borderClass="border-l-amber-500">
    {inputData.yieldAnomalies.map((y) => (
      <div key={y.symbol} className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-mono font-medium">{y.symbol}</span>
        <span className="text-muted-foreground">
          {y.currentApy}% APY (7d: {y.apy7d}%, 30d: {y.apy30d}%)
        </span>
        <span className="text-xs text-amber-600 dark:text-amber-400">
          {y.warnings.join(", ")}
        </span>
      </div>
    ))}
  </SnapshotCard>
)}
```

Note: `SnapshotCard` requires `borderClass` (not `borderColor`) and `icon` props. Use icons already imported in `digest-snapshot.tsx` from `lucide-react` (e.g. `TrendingUp`, `BarChart3`).

- [ ] **Step 2: Add Liquidity Shifts card**

```tsx
{inputData.liquidityShifts && inputData.liquidityShifts.length > 0 && (
  <SnapshotCard title="DEX Liquidity Shifts" icon={<BarChart3 className="h-4 w-4" />} borderClass="border-l-blue-500">
    {inputData.liquidityShifts.map((l) => (
      <div key={l.symbol} className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-mono font-medium">{l.symbol}</span>
        <span className={l.scoreDelta > 0 ? "text-emerald-600" : "text-red-600"}>
          {l.previousScore} → {l.currentScore} ({l.scoreDelta > 0 ? "+" : ""}{l.scoreDelta})
        </span>
        <span className="text-xs text-muted-foreground">
          TVL {formatCurrency(l.currentTvl)}
        </span>
      </div>
    ))}
  </SnapshotCard>
)}
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: builds successfully

- [ ] **Step 4: Commit**

```bash
git add src/components/digest-snapshot.tsx
git commit -m "feat(digest): add yield anomaly and liquidity shift snapshot cards"
```

---

## Phase 7: Documentation

### Task 12: Update documentation

**Files:**
- Modify: `docs/digest-pipeline.md`
- Modify: `docs/worker-infrastructure.md`

- [ ] **Step 1: Update digest-pipeline.md**

Update the data collection table to add new sources (16 total, up from 12):
- Yield anomalies
- DEX liquidity shifts
- PSI contributors
- Cross-day trends

Update word budget section: 150-280 words (was 80-160).
Update max_tokens: 1400 (was 800).
Add structured sections documentation.
Add weekly digest section with its own schedule, prompt, storage, and distribution details.
Update the count from "12 sources" to "16 sources" throughout.

- [ ] **Step 2: Update worker-infrastructure.md**

In Trigger 10 section, add `weekly-digest` job (chained after `daily-digest`, Monday-only). Update the job count from 24 to 25 scheduled runtime jobs in:
- The header of `docs/worker-infrastructure.md` (line 3: "24 scheduled runtime jobs")
- `CLAUDE.md` reference to worker-infrastructure.md (update "24 scheduled runtime jobs / 23 status-tracked jobs" to "25 scheduled runtime jobs / 24 status-tracked jobs")

- [ ] **Step 3: Commit**

```bash
git add docs/digest-pipeline.md docs/worker-infrastructure.md
git commit -m "docs: update digest pipeline and worker docs for enrichment changes"
```

---

## Phase 8: Tests

### Task 13: Add tests for new collectors

**Files:**
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

- [ ] **Step 1: Add test for collectPsiContributors**

Test that the collector parses `input_snapshot` from `stability_index_samples`, extracts and ranks contributors by severity impact, and returns top 3.

- [ ] **Step 2: Add test for collectYieldAnomalies**

Test that the collector queries `yield_data` for rows with non-empty `warning_signals`, filters by mcap threshold, and sorts by impact.

- [ ] **Step 3: Add test for collectLiquidityShifts**

Test that the collector compares today vs yesterday `dex_liquidity_history` scores, filters shifts >= 8 points, and sorts by magnitude × mcap.

- [ ] **Step 4: Add test for collectCrossDayTrends**

Test that the collector reads last 7 `daily_digest` rows, parses `input_data`, and builds PSI/mcap/gauge trajectories.

- [ ] **Step 5: Add test for collectDewsSubSignals (enriched)**

Test that elevated coins now include `topSignals` array with signal names and values.

- [ ] **Step 6: Run full test suite**

Run: `npm test -- --run`
Expected: all pass

- [ ] **Step 7: Run full build**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: clean build, no type errors

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "test(digest): add tests for new digest enrichment collectors"
```

---

## Verification Checklist

- [ ] `cd worker && npx tsc --noEmit` passes
- [ ] `npm run build` passes
- [ ] `npm test -- --run` passes
- [ ] `npm run lint` passes
- [ ] All new `DigestInputData` fields are optional (backward-compatible with stored data)
- [ ] Weekly digest only fires on Mondays (day-of-week check)
- [ ] Weekly digest is chained after daily (sequential Anthropic calls, not concurrent)
- [ ] No new cron trigger slot required (reuses existing `5 8 * * *`)
- [ ] Structured section headers render correctly in both preview and full modes
- [ ] Archive wire table shows weekly badge for weekly entries
- [ ] Snapshot cards handle missing yield/liquidity data gracefully
- [ ] Documentation updated: digest-pipeline.md, worker-infrastructure.md
