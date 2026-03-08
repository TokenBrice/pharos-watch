# Daily Digest Refinement — Design Document

**Date:** 2026-03-08
**Status:** Design complete — ready for implementation planning

## Design Philosophy

The Pharos Daily Digest should be the one thing a stablecoin professional reads every morning. Not a data dump. Not an AI summary. A sharp, opinionated editorial column that tells you what happened, why it matters, and what to watch — in under 160 words. It earns its daily read through precision, wit, and the kind of contextual awareness that makes you feel smarter for having read it.

## Goal

Make the daily digest more professional, informative, and qualitative by:

1. Adding mint-burn flow signals (Bank Run Gauge, Flight-to-Quality, per-coin pressure)
2. Adding DEWS threat band signals (band distribution, band changes, elevated coins)
3. Adding historical context injection (precedent, streaks, extremes)
4. Adding report card grade transitions (grade changes with dimensional context)
5. Refining the LLM prompt: regime-aware narrative structure, regime-aware enrichment priority, structured variety enforcement with metadata, output density contract
6. Upgrading the model from Sonnet to Opus

## Current State

The digest cron (`worker/src/cron/daily-digest.ts`) collects 8 data categories, builds a user prompt, calls Claude Sonnet, and stores/distributes the result. Current inputs:

| # | Source | Signal |
|---|--------|--------|
| 1 | Stablecoins cache | Total mcap, 7d delta, biggest supply mover |
| 2 | `depeg_events` | Active count, top 3 by impact (bps x mcap) |
| 3 | `stability_index_samples` | PSI score, band, components; yesterday for comparison |
| 4 | `blacklist_events` | 24h event count, total USD, top events |
| 5 | `supply_history` | 1d vs 7d velocity for top 10 coins |
| 6 | Computed safety scores | Grades for mentioned coins + tension coins, distribution |
| 7 | `depeg_events` (resolved) | Peak >200 bps, mcap >$50M, last 48h |
| 8 | `daily_digest` | Last 5 digests for variety enforcement |

**Not currently used:** DEWS stress signals, mint-burn flows, grade history, PSI history, yield data, DEX liquidity scores.

---

## Change 1: Mint-Burn Flow Enrichment

### Data Collection

New block in the cron after supply velocity (section 4b). Queries `mint_burn_hourly` directly and uses existing pure scoring functions from `worker/src/lib/mint-burn-scoring.ts`.

**Queries:**

1. **24h aggregate per coin** — `SUM(net_flow_usd)`, `SUM(mint_volume_usd)`, `SUM(burn_volume_usd)` from `mint_burn_hourly` where `hour_ts >= nowSec - 86400`
2. **30d baseline per coin** — daily average net and absolute flows for FIS denominator, plus `COUNT(DISTINCT days)` for the 7-day minimum guard

**Computation (imported, not reimplemented):**

- `computeFlowIntensity()` per coin with 24h net, 30d baseline net, 30d baseline abs, data age days
- `computeGaugeScore()` across all coins with FIS + mcap — produces Bank Run Gauge
- `detectFlightToQuality()` with safe-haven net (USDC, USDT, FDUSD, PYUSD) vs all others

**Safe-haven list:** Reuse the same list the mint-burn API handler uses. If it's not already a shared constant, extract one.

### DigestInputData Extension

```typescript
mintBurnFlows?: {
  gaugeScore: number;              // -100 to +100, mcap-weighted composite
  gaugeBand: string;               // "CALM" | "CAUTIOUS" | "ELEVATED" | "CRITICAL"
  flightToQuality: {
    active: boolean;
    safeNetUsd: number;            // 24h net into safe havens
    riskyNetUsd: number;           // 24h net out of risky coins
  };
  topPressure: {                   // Top 3 coins by |FIS|, filtered to |FIS| > 20
    symbol: string;
    intensity: number;             // -100 to +100
    net24hUsd: number;
  }[];
}
```

### User Prompt Format

```
Mint/Burn Flows (24h on-chain):
  Bank Run Gauge: -18 [CALM]
  Flight-to-Quality: inactive
  Top pressure shifts vs 30d baseline:
    USDe: -42 (net -$85M yesterday)
    USDC: +15 (net +$220M yesterday)
    DAI: -28 (net -$12M yesterday)
```

When FTQ is active:
```
  Flight-to-Quality: ACTIVE, $310M out of risky coins, $280M into safe havens
```

### Inclusion Thresholds

- Gauge score + band: always included (one line)
- FTQ block: only when `active === true` (>$100M both directions)
- topPressure: only coins with `|intensity| > 20`, capped at 3
- Entire section omitted if no coin has 7+ days of mint-burn data

---

## Change 2: DEWS Threat Band Enrichment

### Data Collection

New block in the cron after mint-burn flows. Queries pre-computed `stress_signals` and `stress_signal_history` tables.

**Queries:**

1. **Latest DEWS per coin** — latest `stress_signals` row per `stablecoin_id` (score, band, signals_json). Use a subquery with `ROW_NUMBER() OVER (PARTITION BY stablecoin_id ORDER BY computed_at DESC)` or equivalent D1-compatible pattern.
2. **Yesterday's snapshot** — `stress_signal_history` at yesterday's midnight epoch for band-change detection.

**Processing:**

- Count coins per band (today and yesterday) for distribution line
- Diff today vs yesterday bands to find transitions
- Parse `signals_json` for band-change coins to extract top driver (highest-weight sub-signal)
- Filter elevated coins (ALERT+) by mcap > $10M

**Sub-signal key to label mapping:**

| Key | Label |
|-----|-------|
| `supply` | supply velocity |
| `pool` | pool balance drift |
| `liq` | liquidity erosion |
| `price` | price confidence |
| `diverg` | cross-source divergence |
| `black` | blacklist activity |
| `flow` | mint/burn flow |
| `yield` | yield anomaly |

### DigestInputData Extension

```typescript
dewsStress?: {
  bandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
  yesterdayBandCounts: { calm: number; watch: number; alert: number; warning: number; danger: number };
  bandChanges: {
    symbol: string;
    from: string;                   // yesterday's band
    to: string;                     // today's band
    score: number;
    topDriver: string;              // human-readable sub-signal label
  }[];
  elevatedCoins: {
    symbol: string;
    band: string;
    score: number;
    mcapUsd: number;
  }[];
}
```

### User Prompt Format

```
DEWS Stress Signals:
  Band distribution: 128 CALM, 12 WATCH, 5 ALERT, 2 WARNING, 1 DANGER (vs yesterday: 131/11/4/2/0)
  Band changes (last 24h):
    FRAX: WATCH -> ALERT (score 68, driven by pool balance drift)
    crvUSD: ALERT -> CALM (score 22, driven by liquidity erosion recovery)
    PYUSD: CALM -> WATCH (score 41, driven by supply velocity)
  Elevated coins (ALERT+):
    USR: DANGER (score 88, mcap $45M)
    FRAX: ALERT (score 68, mcap $640M)
    hyUSD: ALERT (score 62, mcap $28M)
```

### Inclusion Thresholds

- Band distribution: always included (one line)
- bandChanges: only transitions crossing WATCH/ALERT boundary or higher (CALM<->WATCH excluded as low-signal), capped at 5
- elevatedCoins: only ALERT+ with mcap > $10M, capped at 5
- Entire section omitted if `stress_signals` table is empty

---

## Change 3: Historical Context Injection

### Purpose

Transform data points into journalism by providing temporal precedent. "PSI at 72" is a number. "PSI at 72, lowest since the SVB weekend" is a story. This gives the LLM the ammunition to write with historical grounding instead of daily amnesia.

### Data Collection

Three lightweight query groups, all on indexed columns in existing tables. No new tables.

**Query 1: PSI precedent** — last time PSI was at or below current level.

```sql
SELECT computed_at, score, band
FROM stability_index
WHERE score <= ?  -- current PSI score
  AND computed_at < ?  -- before today
ORDER BY computed_at DESC
LIMIT 1
```

If no result, the current score is an all-time low — that's the context line.

**Query 2: PSI band streak** — consecutive days in the current band.

```sql
SELECT computed_at, band
FROM stability_index
WHERE computed_at <= ?  -- today
ORDER BY computed_at DESC
LIMIT 90  -- 3 months max lookback
```

Count backwards from today until band differs. "Day 47 of BEDROCK" or "3rd day in TREMOR."

**Query 3: Supply mover context** — how the biggest supply mover's current change compares to its own history.

```sql
-- Coin's all-time high mcap
SELECT MAX(circulating_usd) as ath_mcap
FROM supply_history
WHERE stablecoin_id = ?

-- Coin's largest 7d absolute change (to contextualize today's move)
-- Computed from adjacent snapshots in supply_history
SELECT s1.snapshot_date,
       ABS(s1.circulating_usd - s2.circulating_usd) as abs_change
FROM supply_history s1
JOIN supply_history s2
  ON s1.stablecoin_id = s2.stablecoin_id
  AND s2.snapshot_date = s1.snapshot_date - (7 * 86400)
WHERE s1.stablecoin_id = ?
ORDER BY abs_change DESC
LIMIT 1
```

### DigestInputData Extension

```typescript
historicalContext?: {
  psiPrecedent: {
    lastSeenDate: number;           // Unix timestamp of last time PSI was at/below current
    lastSeenDaysAgo: number;        // Days since lastSeenDate (pre-computed, don't make the LLM do date math)
    lastSeenScore: number;
    lastSeenBand: string;
  } | null;                         // null = current score is all-time low
  psiBandStreak: number;            // Consecutive days in current band (minimum 1)
  supplyMoverContext: {
    allTimeHighMcap: number;        // Coin's historical peak mcap
    allTimeHighDate: number;        // When peak occurred
    largestWeeklyChange: number;    // Coin's largest historical 7d abs change (USD)
    largestWeeklyChangeDate: number;
    largestWeeklyChangeDaysAgo: number;
  } | null;
}
```

### User Prompt Format

Appended as context lines to existing sections (not a standalone block):

After the PSI line:
```
  Context: lowest since 2025-03-11, 47 days ago (SVB aftermath). Current BEDROCK streak: 47 days.
```

After the biggest supply mover line:
```
  Context: USDC's largest single-week gain since 2025-01-15 (52 days ago). Current mcap is 12% below its ATH ($55.8B on 2024-06-01).
```

### Inclusion Thresholds

- PSI precedent: always included if `stability_index` has >30 days of history
- Band streak: always included (even "Day 1 of TREMOR" is informative — it signals a fresh transition)
- Supply mover context: only included if `biggestSupplyChange` is non-null and `supply_history` has >30 days for that coin
- If `stability_index` has <30 days of data, omit the entire section

---

## Change 4: Report Card Grade Transitions

### Purpose

Grade changes are narrative events. The digest currently shows current grades for mentioned coins but has no awareness of *change*. "PYUSD dropped from A- to B+" is a story. On quiet market days, grade transitions give the columnist something structural to write about.

### Data Collection

Query `safety_grade_history` for transitions in the last 48 hours. This table records rows only when grades change (or on first seeding), with `prev_grade` capturing the prior value.

**Query:**

```sql
SELECT
  stablecoin_id,
  recorded_at,
  grade,
  score,
  prev_grade,
  prev_score
FROM safety_grade_history
WHERE recorded_at >= ?             -- nowSec - 2 * 86400
  AND prev_grade IS NOT NULL       -- exclude seed rows
ORDER BY ABS(score - prev_score) DESC
LIMIT 5
```

**Dimensional context:** The `safety_grade_history` table doesn't store per-dimension scores. However, the digest cron already computes full safety scores (section 4c) via `computeSafetyScoresSnapshot()`. For each coin with a grade transition, look up its current dimensional scores from the already-computed `allGrades` array. The LLM can infer which dimension likely drove the change from the current values (e.g., if peg=65 and everything else is 85+, peg is the weak link).

### DigestInputData Extension

```typescript
gradeTransitions?: {
  symbol: string;
  fromGrade: string;
  toGrade: string;
  fromScore: number;
  toScore: number;
  currentDimensions: {              // From already-computed safety scores
    peg: number | null;
    liq: number | null;
    resilience: number | null;
    decentralization: number | null;
  };
  mcapUsd: number;
}[];
```

### User Prompt Format

```
Grade Transitions (last 48h):
  PYUSD: A- (81) -> B+ (76), mcap $420M — dimensions: peg=72, liq=85, resilience=78, decentralization=80
  BOLD: B (71) -> B+ (75), mcap $35M — dimensions: peg=95, liq=52, resilience=88, decentralization=70
```

### Inclusion Thresholds

- Only transitions where mcap > $10M (filter out noise from tiny coins)
- Capped at 5 transitions
- Entire section omitted if no transitions occurred in 48h
- Exclude methodology-driven mass re-grades: if >10 coins changed grade on the same `recorded_at` timestamp, it's a methodology version bump, not organic change — omit all transitions from that timestamp

### Methodology Re-grade Guard

When the report card methodology version changes, many coins shift grades simultaneously. This is not organic and would flood the digest with noise. Detection:

```sql
SELECT recorded_at, COUNT(*) as cnt
FROM safety_grade_history
WHERE recorded_at >= ?  -- 48h lookback
  AND prev_grade IS NOT NULL
GROUP BY recorded_at
HAVING cnt > 10
```

Any `recorded_at` with >10 simultaneous transitions is flagged as a methodology bump. Exclude all transitions from those timestamps.

---

## Change 5: Prompt Refinement

No new data collection. Changes to the system prompt and user prompt to make the LLM use all available data more effectively.

### 5a. Day Regime Classification

Computed in the cron from already-collected data, before calling Claude. Added to the top of the user prompt as a single line.

```typescript
function classifyRegime(data: DigestInputData): "CRISIS" | "TENSION" | "WATCHFUL" | "CALM" {
  const band = data.stabilityIndex?.band ?? "BEDROCK";
  const activeDepegs = data.activeDepegCount;
  const gaugeScore = data.mintBurnFlows?.gaugeScore ?? 0;
  const ftqActive = data.mintBurnFlows?.flightToQuality.active ?? false;
  const alertPlus = (data.dewsStress?.bandCounts.alert ?? 0)
    + (data.dewsStress?.bandCounts.warning ?? 0)
    + (data.dewsStress?.bandCounts.danger ?? 0);

  // CRISIS: PSI in TREMOR+, or FTQ active, or gauge ELEVATED+
  if (band === "TREMOR" || band === "FRACTURE" || band === "CRISIS"
      || ftqActive || gaugeScore < -50)
    return "CRISIS";

  // TENSION: 2+ active depegs, or gauge CAUTIOUS, or 3+ coins ALERT+
  if (activeDepegs >= 2 || gaugeScore < -20 || alertPlus >= 3)
    return "TENSION";

  // WATCHFUL: any DEWS band changes, mild gauge movement, or 1 active depeg
  if ((data.dewsStress?.bandChanges?.length ?? 0) > 0
      || activeDepegs >= 1 || gaugeScore < -10)
    return "WATCHFUL";

  return "CALM";
}
```

User prompt line: `Market regime: WATCHFUL`

### 5b. Narrative Structure (replaces current lines 49-53 of system prompt)

Current guidance is a flat description of P1/P2/P3. Replace with regime-aware instructions:

> NARRATIVE STRUCTURE — adapt to the day's regime (provided in the data).
> Always reference the PSI score and band, but it does not have to be the opening line. In CRISIS, lead with the breaking event; PSI can frame P2 or P3. In other regimes, PSI naturally opens P1.
>
> CRISIS: Lead hard with the headline event. P1 = what broke and how bad (depegs, FTQ, gauge). P2 = capital response and PSI framing (flows, who's bleeding, where PSI sits). P3 (optional) = what to watch next. Tone: urgent, precise, no jokes.
>
> TENSION: Lead with the tension, not the break. P1 = PSI frame + what's building (DEWS band shifts, gauge drift). P2 = the specific story (which coin, what signal). P3 (optional) = historical parallel or structural observation. Tone: foreboding, sharp.
>
> WATCHFUL: Lead with the most interesting signal, even if small. P1 = PSI frame + the day's angle (a band change, a supply reversal, a grade transition). P2 = develop the observation with data. P3 (optional) = a wry or forward-looking kicker. Tone: observant, dry.
>
> CALM: Find the story in the stillness. P1 = PSI frame + structural context (macro supply trend, grade distribution, band streak). P2 = the most interesting micro-observation (a single coin's velocity, a DEWS signal ticking up from nothing, a resolved depeg aftermath). P3 (optional) = a memorable closing line. Tone: bemused, wistful, or darkly amused.
>
> The extended field is 2-3 paragraphs following the P1/P2/P3 structure above. P3 is optional — two tight paragraphs that say everything beat three that pad. The text field distills the single sharpest take.
>
> FOCUS: never mention more than 3 data categories in a single digest. Depth on 1-2 stories beats shallow coverage of 6. If a data point doesn't connect to your lead story or provide meaningful contrast, leave it out entirely.

### 5c. Regime-Aware Enrichment Priority (replaces current lines 38-44 of system prompt)

Current guidance mentions safety scores and blacklist but doesn't prioritize across signal types, and uses a static ranking regardless of context. Replace with regime-specific guidance so the model knows what matters most *given the day's energy*:

> You receive enrichment data across several categories. Not all will be present every day. What matters most depends on the regime:
>
> CRISIS priority: FTQ status > active depegs > gauge + pressure shifts > capital flows. Everything else is background — don't dilute the lead.
>
> TENSION priority: DEWS band changes > gauge drift > active depegs > grade transitions. Historical context supports the narrative but doesn't lead.
>
> WATCHFUL priority: the single most interesting signal, whatever category it's in. Grade transitions, DEWS shifts, supply reversals, and blacklist contrasts are equally valid leads. Pick the sharpest story.
>
> CALM priority: historical context > grade transitions > supply mover context > structural observations. The PSI band streak is always worth mentioning. Find the story in the micro-data.
>
> In all regimes: pick the 1-2 most compelling stories. Weave grades and scores into observations, don't list them. A D-grade on an $8M coin is noise. A coin entering DANGER band while PSI reads BEDROCK is a story.
>
> HISTORICAL CONTEXT: You will receive "Context:" lines after PSI and supply data. USE THEM. "PSI at 72" is a data point. "PSI at 72, its lowest since March" is journalism. Streaks, precedents, and ATH comparisons make the reader feel the weight of a number. Always prefer the contextual framing over the raw value.

### 5d. Smarter Variety Enforcement (replaces current raw-text approach)

Currently, the last 5 full digest texts are dumped into the user prompt (1.5-2.5KB of prose). The model has to parse those paragraphs to figure out what patterns to avoid. This is token-expensive and imprecise.

**New approach:** Extract compact structural metadata from recent digests and pass that instead. Much more targeted, fewer tokens (~600 bytes vs ~2KB).

**Output format change:** Add a `meta` field to the JSON output spec. This field is stored in D1 alongside the digest but never displayed to users — it exists purely for variety enforcement on subsequent days.

New output spec (system prompt):

> You MUST respond with valid JSON: {"title": "...", "extended": "...", "text": "...", "meta": {"lead": "...", "tone": "...", "coins": ["...", "..."]}}.
> The meta field captures your editorial choices for variety tracking:
> - lead: the primary signal you led with (e.g., "psi-streak", "dews-band-change", "ftq", "grade-transition", "supply-reversal", "blacklist-contrast", "macro-observation")
> - tone: the dominant tone (e.g., "bemused", "foreboding", "clinical", "wistful", "darkly-amused", "urgent")
> - coins: the 1-3 coin symbols you featured most prominently

**User prompt format (replaces raw digest dump):**

```
Recent digest angles (DO NOT repeat any of these approaches):
  Day -1: CALM, led with psi-streak, tone: bemused, coins: USDC, FRAX
  Day -2: WATCHFUL, led with dews-band-change, tone: foreboding, coins: FRAX, crvUSD
  Day -3: CALM, led with grade-transition, tone: wistful, coins: PYUSD, USDe
  Day -4: WATCHFUL, led with supply-reversal, tone: clinical, coins: USDT, USDC
  Day -5: CALM, led with blacklist-contrast, tone: darkly-amused, coins: USDT
```

**Backward compatibility:** Older digests (before `meta` field exists) fall back to the current raw-text approach. The cron checks whether `meta` is present in the stored JSON; if not, it uses the legacy format for that entry. Over 5 days, the new format fully phases in.

**D1 schema:** Add a `digest_meta` TEXT column to `daily_digest` via a lightweight migration. This is cleaner than overloading `input_data` (which captures generation *input*, not output metadata). The cron extracts the `meta` object from Claude's JSON response, `JSON.stringify`s it, and stores it in `digest_meta`. On read, older rows with `NULL` `digest_meta` fall back to the legacy raw-text approach.

**System prompt variety instructions** (replaces current lines 29-34):

> VARIETY IS MANDATORY. You will receive a summary of recent digest angles below. Do NOT reuse the same lead signal, tone, or primary coin as any of the last 3 days. If the data is similar to yesterday, find a completely different framing — same numbers can tell different stories. Rotate leads, tones, and featured coins deliberately.

### 5e. Output Density Contract (refines current output spec)

The current spec says "2-3 short paragraphs, each 1-2 sentences." That's loose enough for the model to produce 250+ words of wandering prose. Professional financial columns are dense — every word carries data or insight.

**Addition to the system prompt output spec:**

> DENSITY RULES for the extended field: each paragraph should be 30-60 words. Total extended field: 80-160 words. Every sentence must contain a specific number, coin name, or sharp observation. No throat-clearing ("Meanwhile", "In other news", "It's worth noting"). No hedging qualifiers ("somewhat", "arguably", "it remains to be seen"). If a sentence doesn't carry data or wit, cut it. Density is not a style preference — it is a constraint.
>
> THE TEXT FIELD IS THE HOOK. It will appear as a tweet and at the top of Telegram messages. It must make someone who reads only this line want to read the full digest. Lead with the sharpest number or most provocative observation. Don't summarize the extended field — distill it into a single take that stands alone.

This enforces the same density standard as the existing line 54 ("density is a virtue") but makes it measurable and specific rather than aspirational.

### 5f. Full Assembled User Prompt Example

This is what the complete user prompt looks like with all sections present (WATCHFUL regime, typical day). Sections are omitted when their data is absent.

```
Market regime: WATCHFUL

Total stablecoin market cap: $188.4B
7-day market cap change: +$2.1B (+1.13%)
Active depeg events: 1

Active depegs by market impact (deviation x mcap):
  FRAX: 45 bps off-peg, mcap $640M

Pharos Stability Index: 88.2 [STEADY] (severity=3, breadth=1, stressBreadth=2, trend=+2)
Yesterday: 91.0 [BEDROCK]
  Context: last below 89 on 2025-12-04, 94 days ago. Band changed today (BEDROCK -> STEADY, ending 47-day streak).

Biggest 7d supply increase: USDC +$1.8B (now $33.2B)
  Context: largest single-week gain since 2025-01-15, 52 days ago. Current mcap is 12% below ATH ($37.8B on 2024-03-08).

Blacklist activity (last 24h): 3 events, $12.4M affected
  USDT on Ethereum: blacklist ($8.2M)
  USDT on Tron: destroy ($4.1M)

Supply velocity (1d vs 7d):
  USDC: +$420M yesterday vs +$1.8B/week — accelerating
  USDT: -$85M yesterday vs +$310M/week — reversed

Safety Scores:
  FRAX: B- (66, peg=52, liq=71)
  USDC: A (84, peg=98, liq=92)
  Distribution: median B+, 42 above B, 8 rated F

Mint/Burn Flows (24h on-chain):
  Bank Run Gauge: -12 [CALM]
  Flight-to-Quality: inactive
  Top pressure shifts vs 30d baseline:
    USDe: -38 (net -$62M yesterday)
    USDC: +22 (net +$420M yesterday)

DEWS Stress Signals:
  Band distribution: 126 CALM, 14 WATCH, 5 ALERT, 2 WARNING, 1 DANGER (vs yesterday: 130/12/4/2/0)
  Band changes (last 24h):
    FRAX: WATCH -> ALERT (score 68, driven by pool balance drift)
  Elevated coins (ALERT+):
    USR: DANGER (score 88, mcap $45M)
    FRAX: ALERT (score 68, mcap $640M)
    hyUSD: ALERT (score 62, mcap $28M)

Grade Transitions (last 48h):
  FRAX: B (72) -> B- (66), mcap $640M — dimensions: peg=52, liq=71, resilience=78, decentralization=70

Recently resolved: crvUSD recovered from 310bps after 18h ($180M mcap)

Recent digest angles (DO NOT repeat any of these approaches):
  Day -1: CALM, led with psi-streak, tone: bemused, coins: USDC, FRAX
  Day -2: WATCHFUL, led with dews-band-change, tone: foreboding, coins: crvUSD, hyUSD
  Day -3: CALM, led with grade-transition, tone: wistful, coins: PYUSD, USDe
  Day -4: WATCHFUL, led with supply-reversal, tone: clinical, coins: USDT, USDC
  Day -5: CALM, led with blacklist-contrast, tone: darkly-amused, coins: USDT
```

This example is ~1.8KB — well within context limits. On quiet days with no depegs, no band changes, and no grade transitions, the prompt shrinks to ~800 bytes (core metrics + PSI + context + variety metadata).

### 5g. What stays unchanged

| System prompt section | Lines | Action |
|---|---|---|
| Voice directives (sardonic columnist) | 17-24 | Keep |
| Market-impact ranking rule | 22-24 | Keep |
| Formatting bans (emojis, dashes, exclamation marks) | 25-27 | Keep |
| Calm/eventful framing | 28-29 | Keep |
| Variety enforcement | 29-34 | **Replace** (5d) |
| PSI opening rule + band reference | 35-37 | **Replace** — softened into 5b narrative structure (always reference PSI, but doesn't have to open) |
| Enrichment guidance | 38-44 | **Replace** (5c) |
| Output format (JSON, title/text/extended specs) | 46-48 | **Extend** with `meta` field (5d) and density rules (5e) |
| Paragraph guidance | 49-53 | **Replace** (5b) |
| Density virtue | 54 | **Replace** with density contract (5e) |

---

## Change 6: Upgrade to Opus

### Rationale

The digest is a once-daily, low-token call (~2KB input, 800 tokens max output). At current Sonnet pricing, 10 days costs ~$0.25. Opus is roughly 5x the cost — ~$1.25 per 10 days, ~$4/month. Trivial for the quality uplift Opus provides on editorial writing, narrative structure, wit, and the ability to synthesize across a richer set of signals (which this design significantly expands).

### Changes

**Model ID:** `claude-sonnet-4-6` → `claude-opus-4-6`

**Timeout:** 60s → 120s. Opus generates slower than Sonnet. The digest cron has no downstream time pressure (it runs at 08:00 UTC, well outside other cron windows), so a longer timeout has no impact on other jobs.

**max_tokens:** Stays at 800. The output contract (title + extended + text as JSON) is unchanged. Opus should produce *better* output within the same budget, not longer output.

**Retry count:** Stays at 2. No change needed.

### Code Change

In `worker/src/cron/daily-digest.ts`, the API call block (line ~496):

```typescript
// Before
model: "claude-sonnet-4-6",
// After
model: "claude-opus-4-6",
```

And the timeout (line ~501):

```typescript
// Before
signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
// After
signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
```

And the retry timeout option:

```typescript
// Before
{ timeoutMs: 60_000 },
// After
{ timeoutMs: 120_000 },
```

---

## Files Changed

| File | Change |
|---|---|
| `shared/types/index.ts` | Add `mintBurnFlows`, `dewsStress`, `historicalContext`, and `gradeTransitions` fields to `DigestInputData` |
| `worker/src/cron/daily-digest.ts` | Add four data collection blocks, `classifyRegime()`, update `SYSTEM_PROMPT`, update `buildUserPrompt()`, parse + store `meta`, model + timeout upgrade |
| `worker/src/lib/mint-burn-scoring.ts` | No changes (import existing pure functions) |
| `worker/migrations/NNNN_digest_meta.sql` | Add `digest_meta TEXT` column to `daily_digest` |
| `docs/digest-pipeline.md` | Update data sources table, prompt description, input schema, output format |

## Files NOT Changed

- API handlers (no new endpoints)
- Frontend components (digest snapshot cards don't need new card types for this — the data is for LLM consumption only, stored in `input_data` JSON for historical reconstruction)
- Twitter/Telegram distribution logic
- Existing data collection blocks (1-8 remain as-is)
- D1 schema (one lightweight migration: `digest_meta` TEXT column on `daily_digest`; all new queries target existing tables)

## Risks and Mitigations

**Token budget:** Adding four new data sections increases user prompt length. Current prompt is ~1KB of text. New sections add ~800-1000 bytes worst-case (DEWS ~300, mint-burn ~200, historical context ~150, grade transitions ~200). Combined system + user prompt stays well under model context. Output `max_tokens: 800` is unchanged — the LLM picks the 1-2 best stories from richer input, not longer output.

**D1 query budget:** Four new query groups (~10 additional queries). All target indexed columns in existing tables. The cron already makes 8+ queries; the total stays well within Workers limits. All queries are read-only SELECTs. The heaviest new query (30d mint-burn baseline) aggregates `mint_burn_hourly` which has ~630K rows but the WHERE clause on `hour_ts` and GROUP BY `stablecoin_id` uses the primary key index.

**Empty data graceful degradation:** All new sections are optional (`?` in the type). If tables are empty (new deployment, insufficient history), the sections are omitted from the prompt. The LLM writes from what it has — same as today when blacklist or supply velocity data is empty.

**Regime classification stability:** The regime is a hint, not a hard constraint. If the LLM disagrees with the classification given the data, the variety enforcement and "find a different angle" instructions still apply. The regime guides tone and structure but doesn't lock content.

**Methodology re-grade noise:** The grade transitions section includes a guard against methodology version bumps (>10 simultaneous transitions = methodology change, excluded). Without this guard, a methodology update could generate a misleading "mass downgrade" narrative.

**Historical context accuracy:** PSI precedent queries depend on `stability_index` having sufficient history. If <30 days exist, the section is omitted entirely rather than providing misleading "all-time" claims on a short dataset.
