# DEWS Telegram Alerts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Post a Telegram alert to the existing Pharos channel whenever DEWS detects a coin entering the WARNING (56-75) or DANGER (76-100) band, with coin context (name, backing, governance, mcap, price) and the top elevated stress signals.

**Architecture:** Add pure helper functions (`buildDewsAlertMessage`, `extractTopSignals`, `postDewsAlert`) to `telegram.ts`. Extend the DEWS cron's prev-signals query to also fetch the previous `band`. After writing new results to `stress_signals`, iterate transitions and fire Telegram alerts (non-fatal). Wire `telegramCreds` through from `index.ts`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Telegram Bot API (HTML parse mode), Vitest

---

## Background

- **DEWS bands (from `docs/dews.md`):** CALM (0-15), WATCH (16-35), ALERT (36-55), WARNING (56-75), DANGER (76-100)
- **Trigger:** `new_band ∈ {WARNING, DANGER}` AND `BAND_ORDER.indexOf(newBand) > BAND_ORDER.indexOf(prevBand)`
- **No new DB table needed:** `stress_signals` already stores `band` per coin; the cron already reads the previous row for smoothing — just extend the SELECT to include `band`
- **Non-fatal:** failures log a warning and never throw
- **Channel:** same `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` as the daily digest

---

## Task 1: Add DEWS alert helpers to `telegram.ts`

**Files:**
- Modify: `worker/src/lib/telegram.ts`
- Create: `worker/src/lib/__tests__/telegram-dews.test.ts`

### Step 1: Write the failing tests

Create `worker/src/lib/__tests__/telegram-dews.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildDewsAlertMessage, extractTopSignals } from "../telegram";
import type { DewsAlertParams } from "../telegram";

const BASE_PARAMS: DewsAlertParams = {
  stablecoinId: "5",
  name: "USD Coin",
  symbol: "USDC",
  backing: "rwa-backed",
  governance: "centralized",
  mcapUsd: 43_200_000_000,
  price: 0.9987,
  score: 62,
  band: "WARNING",
  prevBand: "ALERT",
  topSignals: [
    { label: "Pool Balance Drift", value: 68 },
    { label: "Liquidity Erosion", value: 54 },
    { label: "Supply Velocity", value: 42 },
  ],
};

describe("buildDewsAlertMessage", () => {
  it("uses warning emoji for WARNING band", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("⚠️");
    expect(msg).not.toContain("🚨");
  });

  it("uses danger emoji for DANGER band", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, band: "DANGER", score: 82, prevBand: "WARNING" });
    expect(msg).toContain("🚨");
    expect(msg).not.toContain("⚠️");
  });

  it("includes coin symbol and band in header", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("<b>WARNING: USDC</b>");
  });

  it("includes score and previous band", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("62");
    expect(msg).toContain("up from ALERT");
  });

  it("formats mcap in billions", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("$43.2B");
  });

  it("formats small mcap in millions", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, mcapUsd: 750_000_000 });
    expect(msg).toContain("$750M");
  });

  it("includes price when provided", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("$0.9987");
  });

  it("omits price line when price is null", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, price: null });
    expect(msg).not.toContain("Price:");
  });

  it("lists top signals", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("Pool Balance Drift: 68");
    expect(msg).toContain("Liquidity Erosion: 54");
    expect(msg).toContain("Supply Velocity: 42");
  });

  it("omits signal section when no elevated signals", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, topSignals: [] });
    expect(msg).not.toContain("Top stress signals");
  });

  it("includes pharos link with correct stablecoin id", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("https://pharos.watch/stablecoin/5");
  });

  it("escapes HTML in coin name", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, name: "Coin <Test> & More" });
    expect(msg).toContain("Coin &lt;Test&gt; &amp; More");
    expect(msg).not.toContain("<Test>");
  });

  it("formats backing as display label", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS); // backing: "rwa-backed"
    expect(msg).toContain("RWA-backed");
    expect(msg).not.toContain("rwa-backed");
  });

  it("formats governance as display label", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS); // governance: "centralized"
    expect(msg).toContain("Centralized");
  });

  it("formats centralized-dependent governance", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, governance: "centralized-dependent" });
    expect(msg).toContain("Centralized-dep.");
  });
});

describe("extractTopSignals", () => {
  const signals = {
    supply: { value: 42, available: true },
    pool: { value: 68, available: true },
    liq: { value: 54, available: true },
    price: { value: 10, available: true },    // below threshold
    diverg: { value: 35, available: false },  // unavailable
    black: { value: 0, available: true },
  };

  it("returns available signals above threshold, sorted descending", () => {
    const result = extractTopSignals(signals);
    expect(result).toEqual([
      { label: "Pool Balance Drift", value: 68 },
      { label: "Liquidity Erosion", value: 54 },
      { label: "Supply Velocity", value: 42 },
    ]);
  });

  it("excludes unavailable signals", () => {
    const result = extractTopSignals(signals);
    const labels = result.map(s => s.label);
    expect(labels).not.toContain("Cross-source Divergence");
  });

  it("excludes signals below threshold", () => {
    const result = extractTopSignals(signals);
    const labels = result.map(s => s.label);
    expect(labels).not.toContain("Price Confidence");
    expect(labels).not.toContain("Blacklist Activity");
  });

  it("respects maxCount", () => {
    const result = extractTopSignals(signals, 2);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("Pool Balance Drift");
    expect(result[1].label).toBe("Liquidity Erosion");
  });

  it("uses human-readable labels", () => {
    const result = extractTopSignals({ supply: { value: 50, available: true } });
    expect(result[0].label).toBe("Supply Velocity");
  });

  it("returns empty array when no signals meet criteria", () => {
    const result = extractTopSignals({ price: { value: 5, available: true } });
    expect(result).toEqual([]);
  });
});
```

### Step 2: Run tests to confirm they fail

```bash
npm test -- worker/src/lib/__tests__/telegram-dews.test.ts
```

Expected: FAIL — `buildDewsAlertMessage`, `extractTopSignals`, `DewsAlertParams` not exported from `telegram.ts`

### Step 3: Implement the helpers in `telegram.ts`

Add to the **bottom** of `worker/src/lib/telegram.ts` (after the existing `postDigestToTelegram`):

```typescript
// ---------------------------------------------------------------------------
// DEWS alert helpers
// ---------------------------------------------------------------------------

const SIGNAL_LABELS: Record<string, string> = {
  supply: "Supply Velocity",
  pool: "Pool Balance Drift",
  liq: "Liquidity Erosion",
  price: "Price Confidence",
  diverg: "Cross-source Divergence",
  black: "Blacklist Activity",
  flow: "Mint/Burn Flow",
  yield: "Yield Anomaly",
};

const BACKING_LABELS: Record<string, string> = {
  "rwa-backed": "RWA-backed",
  "crypto-backed": "Crypto-backed",
  "algorithmic": "Algorithmic",
};

const GOVERNANCE_LABELS: Record<string, string> = {
  "centralized": "Centralized",
  "decentralized": "Decentralized",
  "centralized-dependent": "Centralized-dep.",
};

export interface DewsAlertParams {
  stablecoinId: string;
  name: string;
  symbol: string;
  backing: string;
  governance: string;
  mcapUsd: number;
  price: number | null;
  score: number;
  band: string;
  prevBand: string;
  topSignals: { label: string; value: number }[];
}

/** Extract the top N available signals above a score threshold, sorted descending. */
export function extractTopSignals(
  signals: Record<string, { value: number; available: boolean }>,
  maxCount = 3,
  threshold = 30,
): { label: string; value: number }[] {
  return Object.entries(signals)
    .filter(([, s]) => s.available && s.value >= threshold)
    .sort(([, a], [, b]) => b.value - a.value)
    .slice(0, maxCount)
    .map(([key, s]) => ({ label: SIGNAL_LABELS[key] ?? key, value: Math.round(s.value) }));
}

/** Build the HTML Telegram message for a DEWS band-entry alert. */
export function buildDewsAlertMessage(params: DewsAlertParams): string {
  const { stablecoinId, name, symbol, backing, governance, mcapUsd, price, score, band, prevBand, topSignals } = params;
  const emoji = band === "DANGER" ? "🚨" : "⚠️";
  const backingLabel = BACKING_LABELS[backing] ?? backing;
  const governanceLabel = GOVERNANCE_LABELS[governance] ?? governance;
  const mcapStr = mcapUsd >= 1e9
    ? `$${(mcapUsd / 1e9).toFixed(1)}B`
    : `$${Math.round(mcapUsd / 1e6)}M`;
  const priceStr = price != null ? ` | Price: $${price.toFixed(4)}` : "";
  const signalLines = topSignals.length > 0
    ? `\n\n<b>Top stress signals:</b>\n${topSignals.map(s => `• ${escapeHtml(s.label)}: ${s.value}`).join("\n")}`
    : "";

  return (
    `${emoji} <b>${band}: ${escapeHtml(symbol)}</b>\n\n` +
    `<b>${escapeHtml(name)}</b> (${escapeHtml(backingLabel)}, ${escapeHtml(governanceLabel)}) has entered the DEWS <b>${band}</b> band.\n` +
    `Score: <b>${score}</b>/100 — up from ${escapeHtml(prevBand)}\n` +
    `Market cap: ${mcapStr}${priceStr}` +
    signalLines +
    `\n\n<a href="https://pharos.watch/stablecoin/${escapeHtml(stablecoinId)}">View full analysis →</a>`
  );
}

/**
 * Format and post a DEWS band-entry alert to the Telegram channel.
 * The caller is responsible for catching errors (this is non-fatal).
 */
export async function postDewsAlert(
  params: DewsAlertParams,
  creds: TelegramCreds,
): Promise<void> {
  const text = buildDewsAlertMessage(params);
  await postTelegramMessage(text, creds);
  console.log(`[telegram] Posted DEWS alert: ${params.symbol} entered ${params.band} (score: ${params.score})`);
}
```

### Step 4: Run tests to confirm they pass

```bash
npm test -- worker/src/lib/__tests__/telegram-dews.test.ts
```

Expected: all tests pass

### Step 5: Run full test suite to confirm no regressions

```bash
npm test
```

Expected: 50 test files pass (all 704+ tests)

### Step 6: Commit

```bash
git add worker/src/lib/telegram.ts worker/src/lib/__tests__/telegram-dews.test.ts
git commit -m "feat(dews): add DEWS alert helpers to telegram.ts"
```

---

## Task 2: Extend `computeAndStoreDEWS` to detect transitions and fire alerts

**Files:**
- Modify: `worker/src/cron/compute-dews.ts`

### Step 1: Add `telegramCreds` param and import

At the top of `worker/src/cron/compute-dews.ts`, add to the existing imports:

```typescript
import { postDewsAlert, extractTopSignals, type TelegramCreds } from "../lib/telegram";
import type { DewsAlertParams } from "../lib/telegram";
```

Change the function signature from:

```typescript
export async function computeAndStoreDEWS(db: D1Database, _signal?: AbortSignal): Promise<CronResult> {
```

to:

```typescript
export async function computeAndStoreDEWS(
  db: D1Database,
  _signal?: AbortSignal,
  telegramCreds: TelegramCreds | null = null,
): Promise<CronResult> {
```

### Step 2: Extend the prev-signals query to include `band`

**Declare `prevBandMap` at the same scope as `prevSignals`** (line 121 in the current file). Find:

```typescript
const prevSignals = new Map<string, Record<string, { value: number }>>();
```

Add immediately after it (outside the try-catch, same scope):

```typescript
const prevBandMap = new Map<string, string>();
```

Update the SQL string from:
```sql
SELECT s.stablecoin_id, s.signals_json
```
to:
```sql
SELECT s.stablecoin_id, s.signals_json, s.band
```

Update the query result type from:
```typescript
.all<{ stablecoin_id: string; signals_json: string }>();
```
to:
```typescript
.all<{ stablecoin_id: string; signals_json: string; band: string }>();
```

Inside the existing loop that populates `prevSignals`, add one line after the inner try/catch:

```typescript
for (const row of prevRows.results) {
  try {
    prevSignals.set(row.stablecoin_id, JSON.parse(row.signals_json));
  } catch {
    /* ignore malformed JSON */
  }
  if (row.band) prevBandMap.set(row.stablecoin_id, row.band); // add this line
}
```

### Step 3: Add transition detection and alert dispatch after the batch INSERT

Add the band ordering constants at **module scope** in `compute-dews.ts`, after the import block and before the `BLACKLIST_SYMBOL_TO_IDS` declaration (around line 15). These are pure immutable values with no dependency on function arguments — module scope avoids re-creating them on every 15-min cron run:

```typescript
const BAND_ORDER = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"] as const;
const ALERT_BANDS = new Set(["WARNING", "DANGER"]);
```

After the batch INSERT block (step 9, around line 323), and before step 10 (daily snapshot), add:

```typescript
// 9b. Post Telegram alerts for WARNING/DANGER band entries (non-fatal)
if (telegramCreds && results.length > 0) {
  for (const r of results) {
    if (!ALERT_BANDS.has(r.band)) continue;
    const prevBand = prevBandMap.get(r.stablecoinId);
    if (!prevBand) continue; // no previous reading — skip first run
    const prevIdx = BAND_ORDER.indexOf(prevBand as typeof BAND_ORDER[number]);
    const newIdx = BAND_ORDER.indexOf(r.band as typeof BAND_ORDER[number]);
    if (newIdx <= prevIdx) continue; // not an upward transition

    const meta = PSI_ELIGIBLE_META_BY_ID[r.stablecoinId];
    if (!meta) continue;
    const asset = assetById.get(r.stablecoinId);

    const signals = r.signals as Record<string, { value: number; available: boolean }>;
    const topSignals = extractTopSignals(signals);

    const params: DewsAlertParams = {
      stablecoinId: r.stablecoinId,
      name: meta.name,
      symbol: meta.symbol,
      backing: meta.flags.backing,
      governance: meta.flags.governance,
      mcapUsd: asset ? getCirculatingRaw(asset) : 0,
      price: asset?.price ?? null,
      score: r.score,
      band: r.band,
      prevBand,
      topSignals,
    };

    try {
      await postDewsAlert(params, telegramCreds);
    } catch (err) {
      console.warn(`[dews] Failed to post Telegram alert for ${meta.symbol} (non-fatal):`, err);
    }
  }
}
```

### Step 4: Type-check the worker

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors

### Step 5: Run full test suite

```bash
cd .. && npm test
```

Expected: all tests pass

### Step 6: Commit

```bash
git add worker/src/cron/compute-dews.ts
git commit -m "feat(dews): detect WARNING/DANGER band transitions and fire Telegram alerts"
```

---

## Task 3: Wire `telegramCreds` into the `*/15` cron handler

**Files:**
- Modify: `worker/src/index.ts`

### Step 1: Pass `telegramCreds` to `computeAndStoreDEWS`

Find the `*/15 * * * *` case in the `scheduled` handler. The DEWS job currently looks like:

```typescript
ctx.waitUntil(stablecoinsSync.then(() =>
  logCronRun(db, "compute-dews", (signal) => computeAndStoreDEWS(db, signal))
));
```

Change it to:

```typescript
const telegramCreds =
  env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
    : null;

ctx.waitUntil(stablecoinsSync.then(() =>
  logCronRun(db, "compute-dews", (signal) => computeAndStoreDEWS(db, signal, telegramCreds))
));
```

Note: the `telegramCreds` const can be defined once at the top of the `*/15` case block and reused.

### Step 2: Type-check the worker

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors

### Step 3: Run full test suite

```bash
cd .. && npm test
```

Expected: all tests pass

### Step 4: Commit

```bash
git add worker/src/index.ts
git commit -m "feat(dews): pass telegramCreds to computeAndStoreDEWS in cron handler"
```

---

## Task 4: Update documentation

**Files:**
- Modify: `docs/dews.md`
- Modify: `docs/digest-pipeline.md`

### Step 1: Add Alerts section to `docs/dews.md`

Add a new section after the "Frontend Integration" section at the bottom of the file:

```markdown
---

## Telegram Alerts

When DEWS detects a coin **entering** the WARNING or DANGER band, a Telegram alert is posted to the Pharos channel.

### Trigger conditions

| Transition | Alert sent |
|---|---|
| CALM / WATCH / ALERT → WARNING | ⚠️ WARNING alert |
| CALM / WATCH / ALERT / WARNING → DANGER | 🚨 DANGER alert |
| No band change (sustained WARNING/DANGER) | none |
| Downward movement | none |

A coin that drops below the threshold and re-enters will fire again on re-entry. No cooldown table.

### Message format

```
⚠️ <b>WARNING: USDC</b>

<b>USD Coin</b> (RWA-backed, Centralized) has entered the DEWS WARNING band.
Score: <b>62</b>/100 — up from ALERT
Market cap: $43.2B | Price: $0.9987

<b>Top stress signals:</b>
• Pool Balance Drift: 68
• Liquidity Erosion: 54
• Supply Velocity: 42

<a href="https://pharos.watch/stablecoin/5">View full analysis →</a>
```

Top signals: available signals with `value >= 30`, sorted descending, max 3. Human-readable labels from `SIGNAL_LABELS` in `telegram.ts`.

### Cadence

Alerts fire at most every 15 minutes (DEWS cron frequency). Since signals are smoothed, genuine threshold crossings typically build over multiple cycles.

### Credentials

Uses `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (same channel as the daily digest). If either is absent, alerts are skipped silently.

### Implementation

| File | Role |
|---|---|
| `worker/src/lib/telegram.ts` | `buildDewsAlertMessage`, `extractTopSignals`, `postDewsAlert` |
| `worker/src/cron/compute-dews.ts` | Transition detection + alert dispatch (step 9b) |
| `worker/src/index.ts` | Passes `telegramCreds` to `computeAndStoreDEWS` |
```

### Step 2: Update the Telegram subsection in `docs/digest-pipeline.md`

Find the line that says:
```
**Adding future post types:** any cron can import `postDigestToTelegram` (or call the lower-level `buildTelegramMessage` + a custom fetch) from `telegram.ts` — no changes to the module needed.
```

Replace with:
```
**Other post types:** the DEWS cron posts real-time band-entry alerts via `postDewsAlert` from `telegram.ts`. Any cron can import from `telegram.ts` — see `postDigestToTelegram` and `postDewsAlert` as examples of the pattern.
```

### Step 3: Commit

```bash
git add docs/dews.md docs/digest-pipeline.md
git commit -m "docs: document DEWS Telegram alert behavior"
```

---

## Verification Checklist

- [ ] `npm test` passes (all 50+ test files)
- [ ] `cd worker && npx tsc --noEmit` passes
- [ ] `buildDewsAlertMessage` produces valid HTML for WARNING and DANGER
- [ ] `extractTopSignals` correctly filters, sorts, and maps signal keys to labels
- [ ] `computeAndStoreDEWS` signature is backward-compatible (new param is optional with default `null`)
- [ ] No alert fires when `prevBand` is absent (first run)
- [ ] No alert fires for downward transitions or sustained bands
- [ ] `docs/dews.md` has new Alerts section
