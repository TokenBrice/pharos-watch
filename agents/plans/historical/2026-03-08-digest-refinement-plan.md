# Digest Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich the daily digest with mint-burn flows, DEWS stress signals, historical context, grade transitions, regime-aware prompt structure, smarter variety enforcement, and upgrade to Opus.

**Architecture:** All changes are in one cron file (`daily-digest.ts`), one type file (`shared/types/index.ts`), one migration, and one doc. Four new D1 query blocks collect data into new optional fields on `DigestInputData`. A `classifyRegime()` function labels the day. The system prompt is rewritten with regime-aware narrative structure. A `meta` output field enables structured variety enforcement.

**Tech Stack:** TypeScript, Cloudflare Workers D1, Anthropic API (Claude Opus), Vitest

**Design doc:** `agents/plans/2026-03-08-digest-refinement-design.md`

**Key finding:** The design doc uses "CALM | CAUTIOUS | ELEVATED | CRITICAL" for gauge bands, but the actual `getGaugeBand()` in `mint-burn-scoring.ts` returns "CRISIS | STRESS | CAUTIOUS | NEUTRAL | HEALTHY | CONFIDENT | SURGE". The implementation uses the real labels.

---

### Task 1: Migration + Type Extension

**Files:**
- Create: `worker/migrations/0055_digest_meta.sql`
- Modify: `shared/types/index.ts` (around line 378, after `resolvedDepegs`)

**Step 1: Create migration**

```sql
-- 0055_digest_meta.sql
ALTER TABLE daily_digest ADD COLUMN digest_meta TEXT;
```

**Step 2: Extend DigestInputData**

Add these fields after the `resolvedDepegs` field in the `DigestInputData` interface:

```typescript
  mintBurnFlows?: {
    gaugeScore: number;
    gaugeBand: string;
    flightToQuality: {
      active: boolean;
      safeNetUsd: number;
      riskyNetUsd: number;
    };
    topPressure: {
      symbol: string;
      intensity: number;
      net24hUsd: number;
    }[];
  };
  dewsStress?: {
    bandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
    yesterdayBandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
    bandChanges: {
      symbol: string;
      from: string;
      to: string;
      score: number;
      topDriver: string;
    }[];
    elevatedCoins: {
      symbol: string;
      band: string;
      score: number;
      mcapUsd: number;
    }[];
  };
  historicalContext?: {
    psiPrecedent: {
      lastSeenDate: number;
      lastSeenDaysAgo: number;
      lastSeenScore: number;
      lastSeenBand: string;
    } | null;
    psiBandStreak: number;
    supplyMoverContext: {
      allTimeHighMcap: number;
      allTimeHighDate: number;
      largestWeeklyChange: number;
      largestWeeklyChangeDate: number;
      largestWeeklyChangeDaysAgo: number;
    } | null;
  };
  gradeTransitions?: {
    symbol: string;
    fromGrade: string;
    toGrade: string;
    fromScore: number;
    toScore: number;
    currentDimensions: {
      peg: number | null;
      liq: number | null;
      resilience: number | null;
      decentralization: number | null;
    };
    mcapUsd: number;
  }[];
```

**Step 3: Run type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (new fields are optional, no consumers need updating)

**Step 4: Commit**

```bash
git add worker/migrations/0055_digest_meta.sql shared/types/index.ts
git commit -m "feat(digest): add DigestInputData fields + digest_meta migration"
```

---

### Task 2: Mint-Burn Flow Collection

**Files:**
- Modify: `worker/src/cron/daily-digest.ts` (after supply velocity block, ~line 391)
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

**Step 1: Write the failing test**

Add to the existing `describe("generateDailyDigest")` block in `daily-digest.test.ts`:

```typescript
it("includes mint-burn flow data in stored input when hourly data exists", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const hourAgo = nowSec - 3600;
  const baseTables = makeBaseTables();
  const db = mockD1([
    ...baseTables,
    // 24h aggregate
    {
      match: "FROM mint_burn_hourly WHERE hour_ts >= ?",
      matchMode: "includes" as const,
      rows: [
        { stablecoin_id: "usdt-tether", mint_24h: 500_000_000, burn_24h: 300_000_000, net_24h: 200_000_000 },
        { stablecoin_id: "usdc-circle", mint_24h: 100_000_000, burn_24h: 150_000_000, net_24h: -50_000_000 },
      ],
    },
    // 30d baseline
    {
      match: "mint_burn_hourly WHERE hour_ts >= ?",
      matchMode: "includes" as const,
      rows: [
        { stablecoin_id: "usdt-tether", avg_daily_net: 50_000_000, avg_daily_abs: 200_000_000, data_days: 30 },
        { stablecoin_id: "usdc-circle", avg_daily_net: -10_000_000, avg_daily_abs: 80_000_000, data_days: 25 },
      ],
    },
  ]);

  const result = await generateDailyDigest(db, "anthropic-key");
  expect(result.itemCount).toBe(1);

  const insertBinds = getInsertDigestBinds(db as MockD1Database);
  const storedInput = JSON.parse(String(insertBinds?.[3]));
  expect(storedInput.mintBurnFlows).toBeDefined();
  expect(storedInput.mintBurnFlows.gaugeBand).toBeDefined();
  expect(typeof storedInput.mintBurnFlows.gaugeScore).toBe("number");
  expect(storedInput.mintBurnFlows.flightToQuality).toBeDefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: FAIL — `storedInput.mintBurnFlows` is undefined

**Step 3: Implement mint-burn flow collection**

Add the following imports at the top of `daily-digest.ts`:

```typescript
import { computeFlowIntensity, computeGaugeScore, getGaugeBand, detectFlightToQuality } from "../lib/mint-burn-scoring";
import { SAFE_HAVEN_IDS } from "../lib/mint-burn-contracts";
```

Add this data collection block after the resolved depegs section (~line 465), before the `inputData` assembly:

```typescript
  // 4e. Mint-burn flows (24h + 30d baseline)
  let mintBurnFlows: DigestInputData["mintBurnFlows"];
  try {
    const cutoff24h = nowSec - SECONDS.ONE_DAY;
    const cutoff30d = nowSec - 30 * SECONDS.ONE_DAY;

    // 24h aggregate per coin (across all chains)
    const flow24hRows = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(mint_volume_usd) as mint_24h,
                SUM(burn_volume_usd) as burn_24h,
                SUM(net_flow_usd) as net_24h
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(cutoff24h)
      .all<{ stablecoin_id: string; mint_24h: number; burn_24h: number; net_24h: number }>();

    // 30d baseline per coin
    const flow30dRows = await db
      .prepare(
        `SELECT stablecoin_id,
                SUM(net_flow_usd) / 30.0 as avg_daily_net,
                SUM(mint_volume_usd + burn_volume_usd) / 30.0 as avg_daily_abs,
                COUNT(DISTINCT CAST(hour_ts / 86400 AS INTEGER)) as data_days
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(cutoff30d)
      .all<{ stablecoin_id: string; avg_daily_net: number; avg_daily_abs: number; data_days: number }>();

    const flow24h = new Map((flow24hRows.results ?? []).map((r) => [r.stablecoin_id, r]));
    const flow30d = new Map((flow30dRows.results ?? []).map((r) => [r.stablecoin_id, r]));

    // Compute FIS per coin
    const coinIntensities: { id: string; symbol: string; intensity: number | null; net24h: number; mcap: number }[] = [];
    for (const [id, f24] of flow24h) {
      const f30 = flow30d.get(id);
      if (!f30) continue;
      const coin = trackedStablecoinAssets.find((c) => c.id === id);
      if (!coin) continue;
      const intensity = computeFlowIntensity({
        currentDailyNet: f24.net_24h,
        baselineDailyNet: f30.avg_daily_net,
        baselineDailyAbs: f30.avg_daily_abs,
        dataAgeDays: f30.data_days,
      });
      coinIntensities.push({ id, symbol: coin.symbol, intensity, net24h: f24.net_24h, mcap: getCirculatingRaw(coin) });
    }

    const gaugeScore = computeGaugeScore(coinIntensities.map((c) => ({ intensity: c.intensity, mcap: c.mcap })));
    if (gaugeScore !== null) {
      // FTQ: sum net flows for safe vs risky
      let safeNet24h = 0;
      let riskyNet24h = 0;
      for (const c of coinIntensities) {
        if (SAFE_HAVEN_IDS.has(c.id)) safeNet24h += c.net24h;
        else riskyNet24h += c.net24h;
      }
      const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });

      // Top pressure: coins with |intensity| > 20, sorted by |intensity|
      const topPressure = coinIntensities
        .filter((c) => c.intensity !== null && Math.abs(c.intensity) > 20)
        .sort((a, b) => Math.abs(b.intensity!) - Math.abs(a.intensity!))
        .slice(0, 3)
        .map((c) => ({ symbol: c.symbol, intensity: c.intensity!, net24hUsd: c.net24h }));

      mintBurnFlows = {
        gaugeScore,
        gaugeBand: getGaugeBand(gaugeScore).label,
        flightToQuality: { active: ftq.active, safeNetUsd: safeNet24h, riskyNetUsd: riskyNet24h },
        topPressure,
      };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect mint-burn flows:", e);
  }
```

Add `mintBurnFlows` to the `inputData` object assembly.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: PASS

**Step 5: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add mint-burn flow collection (gauge, FTQ, pressure)"
```

---

### Task 3: DEWS Stress Signal Collection

**Files:**
- Modify: `worker/src/cron/daily-digest.ts` (after mint-burn block)
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

**Step 1: Write the failing test**

```typescript
it("includes DEWS stress data with band changes in stored input", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);
  const yesterdayTs = todayTs - 86_400;

  const baseTables = makeBaseTables();
  const db = mockD1([
    ...baseTables,
    // Latest DEWS per coin
    {
      match: "FROM stress_signals",
      matchMode: "includes" as const,
      rows: [
        { stablecoin_id: "usdt-tether", score: 8, band: "CALM", signals_json: '{"supply":{"value":5,"available":true}}', computed_at: nowSec - 600 },
        { stablecoin_id: "usdc-circle", score: 62, band: "ALERT", signals_json: '{"pool":{"value":70,"available":true},"liq":{"value":50,"available":true}}', computed_at: nowSec - 600 },
      ],
    },
    // Yesterday's snapshot
    {
      match: "FROM stress_signal_history WHERE snapshot_date = ?",
      matchMode: "includes" as const,
      rows: [
        { stablecoin_id: "usdt-tether", score: 10, band: "CALM" },
        { stablecoin_id: "usdc-circle", score: 30, band: "WATCH" },
      ],
    },
  ]);

  const result = await generateDailyDigest(db, "anthropic-key");
  expect(result.itemCount).toBe(1);

  const insertBinds = getInsertDigestBinds(db as MockD1Database);
  const storedInput = JSON.parse(String(insertBinds?.[3]));
  expect(storedInput.dewsStress).toBeDefined();
  expect(storedInput.dewsStress.bandCounts.calm).toBeGreaterThanOrEqual(1);
  // USDC went WATCH -> ALERT (crosses threshold)
  expect(storedInput.dewsStress.bandChanges.length).toBeGreaterThanOrEqual(1);
  expect(storedInput.dewsStress.bandChanges[0].symbol).toBe("USDC");
  expect(storedInput.dewsStress.bandChanges[0].from).toBe("WATCH");
  expect(storedInput.dewsStress.bandChanges[0].to).toBe("ALERT");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: FAIL

**Step 3: Implement DEWS stress collection**

Add after mint-burn block:

```typescript
  // 4f. DEWS stress signals
  let dewsStress: DigestInputData["dewsStress"];
  try {
    // Latest DEWS per coin (most recent sample)
    const latestDews = await db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.signals_json
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ stablecoin_id: string; score: number; band: string; signals_json: string }>();

    const todayRows = latestDews.results ?? [];
    if (todayRows.length > 0) {
      // Yesterday's snapshot for band-change detection
      const yesterdayDews = await db
        .prepare("SELECT stablecoin_id, score, band FROM stress_signal_history WHERE snapshot_date = ?")
        .bind(yesterdayTs)
        .all<{ stablecoin_id: string; score: number; band: string }>();

      const yesterdayMap = new Map((yesterdayDews.results ?? []).map((r) => [r.stablecoin_id, r]));

      // Band counts
      const initCounts = () => ({ calm: 0, watch: 0, alert: 0, warning: 0, danger: 0 });
      const bandCounts = initCounts();
      const yesterdayBandCounts = initCounts();

      for (const r of todayRows) {
        const key = r.band.toLowerCase() as keyof typeof bandCounts;
        if (key in bandCounts) bandCounts[key]++;
      }
      for (const r of yesterdayDews.results ?? []) {
        const key = r.band.toLowerCase() as keyof typeof yesterdayBandCounts;
        if (key in yesterdayBandCounts) yesterdayBandCounts[key]++;
      }

      // Band changes crossing WATCH/ALERT boundary
      const SIGNAL_LABELS: Record<string, string> = {
        supply: "supply velocity", pool: "pool balance drift", liq: "liquidity erosion",
        price: "price confidence", diverg: "cross-source divergence", black: "blacklist activity",
        flow: "mint/burn flow", yield: "yield anomaly",
      };
      const ALERT_BANDS = new Set(["ALERT", "WARNING", "DANGER"]);
      const bandChanges: NonNullable<DigestInputData["dewsStress"]>["bandChanges"] = [];

      for (const today of todayRows) {
        const yesterday = yesterdayMap.get(today.stablecoin_id);
        if (!yesterday || yesterday.band === today.band) continue;
        // Only include if crossing the WATCH/ALERT boundary
        const wasElevated = ALERT_BANDS.has(yesterday.band);
        const isElevated = ALERT_BANDS.has(today.band);
        if (wasElevated === isElevated) continue; // Both above or both below — not crossing

        // Extract top driver from signals_json
        let topDriver = "unknown";
        try {
          const signals = JSON.parse(today.signals_json) as Record<string, { value: number; available: boolean }>;
          let maxVal = -1;
          for (const [key, sig] of Object.entries(signals)) {
            if (sig.available && sig.value > maxVal) { maxVal = sig.value; topDriver = SIGNAL_LABELS[key] ?? key; }
          }
        } catch { /* use "unknown" */ }

        const coin = trackedStablecoinAssets.find((c) => c.id === today.stablecoin_id);
        if (!coin) continue;
        bandChanges.push({ symbol: coin.symbol, from: yesterday.band, to: today.band, score: today.score, topDriver });
      }

      // Elevated coins: ALERT+ with mcap > $10M
      const elevatedCoins = todayRows
        .filter((r) => ALERT_BANDS.has(r.band))
        .map((r) => {
          const coin = trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
          return coin ? { symbol: coin.symbol, band: r.band, score: r.score, mcapUsd: getCirculatingRaw(coin) } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.mcapUsd > 10_000_000)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      dewsStress = { bandCounts, yesterdayBandCounts, bandChanges: bandChanges.slice(0, 5), elevatedCoins };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect DEWS stress signals:", e);
  }
```

Add `dewsStress` to the `inputData` object.

**Step 4: Run test + type-check**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add DEWS stress signal collection (bands, changes, elevated)"
```

---

### Task 4: Historical Context Collection

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

**Step 1: Write the failing test**

```typescript
it("includes historical context with PSI precedent and band streak", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);

  const baseTables = makeBaseTables();
  const db = mockD1([
    ...baseTables,
    // PSI precedent: last time score was at/below current
    {
      match: "FROM stability_index WHERE score <= ?",
      matchMode: "includes" as const,
      rows: [],
      first: { computed_at: todayTs - 30 * 86_400, score: 89.0, band: "STEADY" },
    },
    // PSI band streak
    {
      match: "FROM stability_index WHERE computed_at <= ?",
      matchMode: "includes" as const,
      rows: [
        { computed_at: todayTs, band: "BEDROCK" },
        { computed_at: todayTs - 86_400, band: "BEDROCK" },
        { computed_at: todayTs - 2 * 86_400, band: "BEDROCK" },
        { computed_at: todayTs - 3 * 86_400, band: "STEADY" },
      ],
    },
    // Supply mover ATH
    {
      match: "MAX(circulating_usd)",
      matchMode: "includes" as const,
      rows: [],
      first: { ath_mcap: 120_000_000, ath_date: todayTs - 60 * 86_400 },
    },
    // Supply mover largest weekly change
    {
      match: "ABS(s1.circulating_usd - s2.circulating_usd)",
      matchMode: "includes" as const,
      rows: [],
      first: { snapshot_date: todayTs - 45 * 86_400, abs_change: 8_000_000 },
    },
    // History depth check (>30 rows means >30 days)
    {
      match: "COUNT(*) as cnt FROM stability_index",
      matchMode: "includes" as const,
      rows: [],
      first: { cnt: 90 },
    },
  ]);

  const result = await generateDailyDigest(db, "anthropic-key");
  expect(result.itemCount).toBe(1);

  const insertBinds = getInsertDigestBinds(db as MockD1Database);
  const storedInput = JSON.parse(String(insertBinds?.[3]));
  expect(storedInput.historicalContext).toBeDefined();
  expect(storedInput.historicalContext.psiBandStreak).toBe(3);
  expect(storedInput.historicalContext.psiPrecedent).toBeDefined();
  expect(storedInput.historicalContext.psiPrecedent.lastSeenDaysAgo).toBe(30);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: FAIL

**Step 3: Implement historical context collection**

Add after DEWS block:

```typescript
  // 4g. Historical context (PSI precedent, band streak, supply mover)
  let historicalContext: DigestInputData["historicalContext"];
  try {
    // Check we have enough history (>30 days)
    const histDepth = await db
      .prepare("SELECT COUNT(*) as cnt FROM stability_index")
      .first<{ cnt: number }>();

    if (displayScore != null && displayBand && (histDepth?.cnt ?? 0) > 30) {
      // PSI precedent: last time score was at or below current
      const precedent = await db
        .prepare("SELECT computed_at, score, band FROM stability_index WHERE score <= ? AND computed_at < ? ORDER BY computed_at DESC LIMIT 1")
        .bind(displayScore, todayTs)
        .first<{ computed_at: number; score: number; band: string }>();

      const psiPrecedent = precedent
        ? {
            lastSeenDate: precedent.computed_at,
            lastSeenDaysAgo: Math.round((todayTs - precedent.computed_at) / SECONDS.ONE_DAY),
            lastSeenScore: precedent.score,
            lastSeenBand: precedent.band,
          }
        : null; // null = all-time low

      // PSI band streak: count consecutive days in current band
      const bandHistory = await db
        .prepare("SELECT computed_at, band FROM stability_index WHERE computed_at <= ? ORDER BY computed_at DESC LIMIT 90")
        .bind(todayTs)
        .all<{ computed_at: number; band: string }>();

      let psiBandStreak = 0;
      for (const row of bandHistory.results ?? []) {
        if (row.band === displayBand) psiBandStreak++;
        else break;
      }
      if (psiBandStreak === 0) psiBandStreak = 1; // Minimum 1 (today)

      // Supply mover context
      let supplyMoverContext: NonNullable<DigestInputData["historicalContext"]>["supplyMoverContext"] = null;
      if (biggestSupplyChange) {
        const athRow = await db
          .prepare("SELECT MAX(circulating_usd) as ath_mcap FROM supply_history WHERE stablecoin_id = ?")
          .bind(biggestSupplyChange.id)
          .first<{ ath_mcap: number | null }>();

        // ATH date (separate query since D1 doesn't support argmax)
        let athDate = 0;
        if (athRow?.ath_mcap) {
          const athDateRow = await db
            .prepare("SELECT snapshot_date FROM supply_history WHERE stablecoin_id = ? AND circulating_usd = ? ORDER BY snapshot_date DESC LIMIT 1")
            .bind(biggestSupplyChange.id, athRow.ath_mcap)
            .first<{ snapshot_date: number }>();
          athDate = athDateRow?.snapshot_date ?? 0;
        }

        // Largest historical 7d change
        const largestChangeRow = await db
          .prepare(
            `SELECT s1.snapshot_date, ABS(s1.circulating_usd - s2.circulating_usd) as abs_change
             FROM supply_history s1
             JOIN supply_history s2
               ON s1.stablecoin_id = s2.stablecoin_id
               AND s2.snapshot_date = s1.snapshot_date - ?
             WHERE s1.stablecoin_id = ?
             ORDER BY abs_change DESC LIMIT 1`,
          )
          .bind(7 * SECONDS.ONE_DAY, biggestSupplyChange.id)
          .first<{ snapshot_date: number; abs_change: number }>();

        if (athRow?.ath_mcap && largestChangeRow) {
          supplyMoverContext = {
            allTimeHighMcap: athRow.ath_mcap,
            allTimeHighDate: athDate,
            largestWeeklyChange: largestChangeRow.abs_change,
            largestWeeklyChangeDate: largestChangeRow.snapshot_date,
            largestWeeklyChangeDaysAgo: Math.round((todayTs - largestChangeRow.snapshot_date) / SECONDS.ONE_DAY),
          };
        }
      }

      historicalContext = { psiPrecedent, psiBandStreak, supplyMoverContext };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect historical context:", e);
  }
```

Add `historicalContext` to the `inputData` object.

**Step 4: Run test + type-check**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add historical context (PSI precedent, band streak, supply ATH)"
```

---

### Task 5: Grade Transitions Collection

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

**Step 1: Write the failing test**

```typescript
it("includes grade transitions and excludes methodology bumps", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % 86_400);

  const baseTables = makeBaseTables();
  const db = mockD1([
    ...baseTables,
    // Methodology bump check (no bumps)
    {
      match: "HAVING cnt > 10",
      matchMode: "includes" as const,
      rows: [],
    },
    // Grade transitions in last 48h
    {
      match: "FROM safety_grade_history WHERE recorded_at >= ?",
      matchMode: "includes" as const,
      rows: [
        {
          stablecoin_id: "usdt-tether",
          recorded_at: todayTs,
          grade: "A-",
          score: 80,
          prev_grade: "A",
          prev_score: 85,
        },
      ],
    },
  ]);

  const result = await generateDailyDigest(db, "anthropic-key");
  expect(result.itemCount).toBe(1);

  const insertBinds = getInsertDigestBinds(db as MockD1Database);
  const storedInput = JSON.parse(String(insertBinds?.[3]));
  expect(storedInput.gradeTransitions).toBeDefined();
  expect(storedInput.gradeTransitions.length).toBe(1);
  expect(storedInput.gradeTransitions[0].symbol).toBe("USDT");
  expect(storedInput.gradeTransitions[0].fromGrade).toBe("A");
  expect(storedInput.gradeTransitions[0].toGrade).toBe("A-");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: FAIL

**Step 3: Implement grade transitions collection**

Add after historical context block:

```typescript
  // 4h. Grade transitions (last 48h)
  let gradeTransitions: DigestInputData["gradeTransitions"];
  try {
    const cutoff48h = nowSec - SECONDS.TWO_DAYS;

    // Check for methodology bumps (>10 simultaneous transitions = version change)
    const bumpRows = await db
      .prepare(
        `SELECT recorded_at FROM safety_grade_history
         WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         GROUP BY recorded_at HAVING COUNT(*) > 10`,
      )
      .bind(cutoff48h)
      .all<{ recorded_at: number }>();
    const bumpTimestamps = new Set((bumpRows.results ?? []).map((r) => r.recorded_at));

    // Get transitions
    const transitionRows = await db
      .prepare(
        `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score
         FROM safety_grade_history
         WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         ORDER BY ABS(score - prev_score) DESC
         LIMIT 10`,
      )
      .bind(cutoff48h)
      .all<{ stablecoin_id: string; recorded_at: number; grade: string; score: number; prev_grade: string; prev_score: number }>();

    const candidates = (transitionRows.results ?? [])
      .filter((r) => !bumpTimestamps.has(r.recorded_at)) // Exclude methodology bumps
      .filter((r) => {
        const coin = trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
        return coin && getCirculatingRaw(coin) > 10_000_000; // mcap > $10M
      })
      .slice(0, 5);

    if (candidates.length > 0 && safetyScores) {
      // Cross-reference with already-computed safety scores for dimensional context
      const allGrades = (await computeSafetyScoresSnapshot(db, { includeNavTokens: false, outputMode: "full-grades" })).grades;
      const gradeMap = new Map(allGrades.map((g) => [g.id, g]));

      gradeTransitions = candidates.map((r) => {
        const coin = trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id)!;
        const currentGrade = gradeMap.get(r.stablecoin_id);
        return {
          symbol: coin.symbol,
          fromGrade: r.prev_grade,
          toGrade: r.grade,
          fromScore: r.prev_score,
          toScore: r.score,
          currentDimensions: {
            peg: currentGrade?.pegScore ?? null,
            liq: currentGrade?.liqScore ?? null,
            resilience: (currentGrade as any)?.resilienceScore ?? null,
            decentralization: (currentGrade as any)?.decentralizationScore ?? null,
          },
          mcapUsd: getCirculatingRaw(coin),
        };
      });
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect grade transitions:", e);
  }
```

Add `gradeTransitions` to the `inputData` object.

**Important:** The `computeSafetyScoresSnapshot` is already called earlier (section 4c). To avoid calling it twice, refactor to reuse the `allGrades` result from the safety scores block. Move `const allGrades` declaration up to be accessible, or extract the grades from the already-computed `safetyScores` data + the stored `safetySnapshot` variable.

**Step 4: Run test + type-check**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add grade transitions collection with methodology guard"
```

---

### Task 6: Regime Classification + User Prompt Update

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

**Step 1: Write the failing test for classifyRegime**

```typescript
import { classifyRegime } from "../daily-digest";

describe("classifyRegime", () => {
  const baseData: DigestInputData = {
    totalMcapUsd: 200_000_000_000,
    mcap7dDelta: 1_000_000_000,
    activeDepegCount: 0,
    topDepegs: [],
    biggestSupplyChange: null,
    stabilityIndex: { score: 95, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } },
    yesterdayIndex: null,
  };

  it("returns CALM when nothing is elevated", () => {
    expect(classifyRegime(baseData)).toBe("CALM");
  });

  it("returns CRISIS when FTQ is active", () => {
    expect(classifyRegime({
      ...baseData,
      mintBurnFlows: { gaugeScore: -20, gaugeBand: "CAUTIOUS", flightToQuality: { active: true, safeNetUsd: 200_000_000, riskyNetUsd: -200_000_000 }, topPressure: [] },
    })).toBe("CRISIS");
  });

  it("returns CRISIS when PSI band is TREMOR", () => {
    expect(classifyRegime({
      ...baseData,
      stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } },
    })).toBe("CRISIS");
  });

  it("returns TENSION when 3+ coins ALERT+", () => {
    expect(classifyRegime({
      ...baseData,
      dewsStress: {
        bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
        yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 },
        bandChanges: [], elevatedCoins: [],
      },
    })).toBe("TENSION");
  });

  it("returns WATCHFUL when 1 active depeg", () => {
    expect(classifyRegime({ ...baseData, activeDepegCount: 1 })).toBe("WATCHFUL");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: FAIL — `classifyRegime` is not exported

**Step 3: Implement classifyRegime**

Add and export from `daily-digest.ts`:

```typescript
export function classifyRegime(data: DigestInputData): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  const band = data.stabilityIndex?.band ?? "BEDROCK";
  const activeDepegs = data.activeDepegCount;
  const gaugeScore = data.mintBurnFlows?.gaugeScore ?? 0;
  const ftqActive = data.mintBurnFlows?.flightToQuality.active ?? false;
  const alertPlus = (data.dewsStress?.bandCounts.alert ?? 0)
    + (data.dewsStress?.bandCounts.warning ?? 0)
    + (data.dewsStress?.bandCounts.danger ?? 0);

  if (band === "TREMOR" || band === "FRACTURE" || band === "CRISIS" || ftqActive || gaugeScore < -50)
    return "CRISIS";
  if (activeDepegs >= 2 || gaugeScore < -20 || alertPlus >= 3)
    return "TENSION";
  if ((data.dewsStress?.bandChanges?.length ?? 0) > 0 || activeDepegs >= 1 || gaugeScore < -10)
    return "WATCHFUL";
  return "CALM";
}
```

**Step 4: Update buildUserPrompt**

Update `buildUserPrompt` to:
1. Accept regime as a parameter
2. Add `Market regime: {regime}` as the first line
3. Add context lines after PSI and supply mover sections
4. Add mint-burn flows section
5. Add DEWS stress section
6. Add grade transitions section
7. Replace raw digest dump with variety metadata

See design doc sections for exact user prompt format. Key patterns:

```typescript
function buildUserPrompt(data: DigestInputData, recentDigests: string[] = [], recentMeta: DigestMeta[] = []): string {
  const regime = classifyRegime(data);
  const lines: string[] = [`Market regime: ${regime}`, ""];
  // ... existing sections with context lines injected ...
  // ... new sections appended ...
  // ... variety metadata at end ...
}
```

The `recentMeta` parameter receives parsed metadata from stored `digest_meta` column. When metadata is unavailable (legacy rows), fall back to raw text format.

**Step 5: Run all tests + type-check**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add regime classification + update user prompt with all new sections"
```

---

### Task 7: System Prompt Rewrite + Model Upgrade

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`

This task has no unit test — the system prompt is a string constant and the model/timeout are config values. Verification is via type-check and existing test pass.

**Step 1: Rewrite SYSTEM_PROMPT**

Replace the entire `SYSTEM_PROMPT` constant with the new version. Structure (see design doc 5b, 5c, 5d, 5e for exact wording):

1. Voice directives (sardonic columnist) — **kept from current**
2. Market-impact ranking — **kept from current**
3. Formatting bans — **kept from current**
4. Calm/eventful framing — **kept from current**
5. Variety enforcement — **replaced** (5d): reference metadata summary, don't reuse lead/tone/coins from last 3 days
6. Regime-aware enrichment priority — **new** (5c): per-regime priority blocks
7. Historical context instruction — **new** (5c): "USE context lines"
8. Narrative structure — **replaced** (5b): regime-aware P1/P2/P3 with flexible PSI placement
9. Focus constraint — **new** (5b): max 3 data categories
10. Output format with `meta` field — **extended** (5d)
11. Density contract — **replaced** (5e): 30-60 words/paragraph, 80-160 total, ban filler phrases
12. Text field hook guidance — **new** (5e)

**Step 2: Update model + timeout**

```typescript
// Model
model: "claude-opus-4-6",

// Timeout (both places)
signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
// and
{ timeoutMs: 120_000 },
```

**Step 3: Run all tests + type-check**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Run: `cd worker && npx tsc --noEmit`
Expected: PASS (test checks `fetchWithRetry` call args — update expected `timeoutMs` from 60_000 to 120_000)

**Step 4: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): rewrite system prompt + upgrade to Opus + 120s timeout"
```

---

### Task 8: Meta Parsing + Variety Enforcement

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`
- Modify: `worker/src/cron/__tests__/daily-digest.test.ts`

**Step 1: Write the failing test**

```typescript
it("parses meta field from Claude response and stores in digest_meta", async () => {
  const responseWithMeta = {
    content: [{
      type: "text",
      text: JSON.stringify({
        title: "Alert Watch",
        extended: "PSI dipped below 90.\n\nFRAX entered ALERT on pool drift.",
        text: "FRAX hit ALERT while PSI slid to 88, the first STEADY reading in 47 days.",
        meta: { lead: "dews-band-change", tone: "foreboding", coins: ["FRAX"] },
      }),
    }],
  };

  vi.mocked(fetchWithRetry).mockResolvedValueOnce(
    new Response(JSON.stringify(responseWithMeta), { status: 200, headers: { "Content-Type": "application/json" } }),
  );

  const db = mockD1(makeBaseTables());
  const result = await generateDailyDigest(db, "anthropic-key");
  expect(result.itemCount).toBe(1);

  const insertBinds = getInsertDigestBinds(db as MockD1Database);
  // digest_meta should be the 6th bind (after generated_at, digest_text, digest_title, input_data, digest_extended)
  const metaJson = insertBinds?.[5];
  expect(metaJson).toBeDefined();
  const meta = JSON.parse(String(metaJson));
  expect(meta.lead).toBe("dews-band-change");
  expect(meta.tone).toBe("foreboding");
  expect(meta.coins).toEqual(["FRAX"]);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Expected: FAIL

**Step 3: Implement meta parsing and storage**

In the JSON response parsing section (~line 544):

```typescript
  // Parse meta from response (for variety enforcement)
  let digestMeta: string | null = null;
  try {
    const parsed = JSON.parse(jsonText) as { title?: string; text?: string; extended?: string; meta?: { lead?: string; tone?: string; coins?: string[] } };
    // ... existing title/text/extended extraction ...
    if (parsed.meta) {
      digestMeta = JSON.stringify(parsed.meta);
    }
  } catch { /* existing fallback */ }
```

Update the INSERT statement to include `digest_meta`:

```typescript
  await db
    .prepare(
      "INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(now, digestText, digestTitle || null, JSON.stringify(inputData), digestExtended || null, digestMeta)
    .run();
```

Update the recent digests query to read `digest_meta`:

```typescript
  const recentRows = await db
    .prepare("SELECT digest_title, digest_text, digest_extended, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 5")
    .all<{ digest_title: string | null; digest_text: string; digest_extended: string | null; digest_meta: string | null }>();
```

Build variety metadata in `buildUserPrompt` — use `meta` when available, fall back to raw text:

```typescript
  // Variety section
  const metaLines: string[] = [];
  const rawFallbacks: string[] = [];
  for (let i = 0; i < recentMeta.length; i++) {
    const m = recentMeta[i];
    if (m.meta) {
      metaLines.push(`  Day -${i + 1}: ${m.regime ?? "?"}, led with ${m.meta.lead}, tone: ${m.meta.tone}, coins: ${m.meta.coins.join(", ")}`);
    } else if (m.rawText) {
      rawFallbacks.push(`- "${m.rawText}"`);
    }
  }
  if (metaLines.length > 0) {
    lines.push("", "Recent digest angles (DO NOT repeat any of these approaches):", ...metaLines);
  }
  if (rawFallbacks.length > 0) {
    lines.push("", "RECENT DIGESTS — do NOT reuse phrasing, metaphors, or structure:", ...rawFallbacks);
  }
```

**Step 4: Run test + type-check**

Run: `npm test -- --run worker/src/cron/__tests__/daily-digest.test.ts`
Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts worker/src/cron/__tests__/daily-digest.test.ts
git commit -m "feat(digest): add meta parsing, storage, and structured variety enforcement"
```

---

### Task 9: Full Test Suite + Build Verification

**Files:** None modified — verification only

**Step 1: Run full test suite**

Run: `npm test`
Expected: PASS (all tests including existing ones)

**Step 2: Run full build**

Run: `npm run build`
Expected: PASS (includes type-check)

**Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 4: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

---

### Task 10: Documentation Update

**Files:**
- Modify: `docs/digest-pipeline.md`

Update the following sections:

1. **Data Sources table** — add 4 new rows:
   - `mint_burn_hourly` → Bank Run Gauge, FTQ, per-coin pressure shifts
   - `stress_signals` + `stress_signal_history` → DEWS band distribution, changes, elevated coins
   - `stability_index` + `supply_history` → PSI precedent, band streak, supply mover context
   - `safety_grade_history` → Grade transitions with dimensional context

2. **LLM Prompt section** — update:
   - Model: claude-sonnet-4-6 → claude-opus-4-6
   - Timeout: 60s → 120s
   - Note regime classification and regime-aware narrative structure
   - Note enrichment priority is regime-dependent
   - Note `meta` output field for variety enforcement

3. **Output Format section** — add `meta` field to JSON spec

4. **DigestInputData section** — add new optional fields

5. **Storage section** — note `digest_meta` column

**Step 1: Update docs/digest-pipeline.md with all changes above**

**Step 2: Commit**

```bash
git add docs/digest-pipeline.md
git commit -m "docs: update digest pipeline for v2 (flows, DEWS, history, grades, Opus)"
```

---

## Task Dependency Graph

```
Task 1 (types + migration)
  ├── Task 2 (mint-burn flows)
  ├── Task 3 (DEWS stress)
  ├── Task 4 (historical context)
  └── Task 5 (grade transitions)
        └── Task 6 (regime + user prompt) ← depends on 2-5
              └── Task 7 (system prompt + model)
                    └── Task 8 (meta + variety)
                          └── Task 9 (verification)
                                └── Task 10 (docs)
```

Tasks 2, 3, 4, 5 are independent of each other and can run in parallel after Task 1.
