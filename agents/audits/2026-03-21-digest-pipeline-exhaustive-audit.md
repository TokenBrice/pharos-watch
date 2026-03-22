# Digest Pipeline Exhaustive Audit

**Date**: 2026-03-21
**Scope**: All digest code (generation, collectors, prompt, API, distribution, frontend) + all 25 generated digests (24 daily + 1 weekly recap)

---

## Executive Summary

The digest pipeline produces **excellent editorial output** — 72% of digests are issue-free, voice consistency is exceptional, and data density is best-in-class for automated financial commentary. However, the audit uncovered **9 critical code issues, 15 high-severity issues, and 12 moderate issues** across generation logic, prompt engineering, infrastructure, and content quality.

The most impactful findings: (1) DEWS band escalations within elevated tiers are silently dropped, losing the most important stress narratives; (2) weekly digest detail pages return 400 errors due to a date format mismatch; (3) variety enforcement is structurally too weak; (4) 4 of 25 digests exceed the 270-character tweet limit.

---

## Tier 1 — Critical (production bugs or data corruption)

### C1. DEWS band change filtering drops intra-elevated escalations
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 422-446

The band-change filter only detects boundary crossings between CALM/WATCH and ALERT/WARNING/DANGER:
```typescript
const ALERT_BANDS = new Set(["ALERT", "WARNING", "DANGER"]);
const wasElevated = ALERT_BANDS.has(yesterday.band);
const isElevated = ALERT_BANDS.has(today.band);
if (wasElevated === isElevated) continue;
```

**Lost signals**: WATCH→ALERT, ALERT→WARNING, WARNING→DANGER are all invisible. These are the most important stress escalations — a coin worsening from ALERT to DANGER is a bigger story than a coin entering WATCH from CALM.

**Fix**: Track transitions by ordinal rank, not binary group membership.

### C2. Weekly digest detail pages return 400
**File**: `worker/src/api/digest-snapshot.ts`, ~line 28-47

Weekly digests have date format `YYYY-MM-DD-weekly` (e.g., `2026-03-16-weekly`). The snapshot API's `DATE_RE` regex only matches `^\d{4}-\d{2}-\d{2}$` and rejects the `-weekly` suffix, returning 400. The frontend silently swallows this (`if (isError) return null`), so weekly recap pages render with no data snapshot cards.

**Fix**: Strip `-weekly` suffix in the snapshot API before regex match, or pass only the base date from the page component.

### C3. Missing NULL/NaN guards in collector aggregation
**File**: `worker/src/cron/daily-digest.ts`, ~line 456-457

```typescript
mcapById.set(coin.id, getCirculatingRaw(coin));
```

No validation that `getCirculatingRaw()` returns a finite number. If DefiLlama returns NaN or null-coerced-to-0, then `topDepegs` impact calculations, totalMcapUsd, and all mcap-weighted rankings are corrupted.

**Fix**: Guard with `Number.isFinite()` and skip or default coins with bad mcap.

### C4. Variety enforcement mechanism structurally weak
**File**: `worker/src/cron/daily-digest.ts`, ~line 364-384

Only shows last 5 digests' meta for variety tracking. System prompt says "DO NOT reuse lead/tone/coin as any of the last 3 days" but:
- If `meta` is missing (legacy digests), falls back to raw title+text which is hard for the LLM to parse
- No enforcement for "primary coin" rotation — just a prose instruction
- No signal-type diversity tracking (if "psi-streak" was used on day 6, it can reuse on day 7 since window is 5)

**Evidence**: Title "USDC Touches Its Ceiling" used for both 2026-03-13 and 2026-03-11.

**Fix**: Expand window, enforce coin rotation programmatically, always populate `meta`.

### C5. Regime classification ignores market-cap weighting
**File**: `worker/src/cron/daily-digest.ts`, ~line 129-145

```typescript
if (activeDepegs >= 2 || gaugeScore < -20 || alertPlus >= 3) return "TENSION";
```

Thresholds are coin-count-based, not impact-weighted. 3 ALERT coins at $1M each = TENSION, but 1 ALERT coin at $10B = WATCHFUL. The system prompt says "rank everything by market impact (deviation x market cap)" but the regime logic ignores this.

**Fix**: Weight thresholds by aggregate mcap of affected coins.

### C6. JSON extraction doesn't handle escaped braces
**File**: `worker/src/cron/daily-digest.ts`, ~line 634-646

Brace-counting parser for extracting JSON from LLM output doesn't account for braces inside strings (e.g., `"text": "see {note}"`). Can extract truncated JSON, causing parse failure and fallback to raw text.

**Fix**: Use `JSON.parse()` with try/catch on progressively smaller slices, or use a proper JSON stream parser.

### C7. Telegram appendix state race condition
**File**: `worker/src/cron/daily-digest.ts`, ~line 722-744

Appendix (cemetery, tracked coins) is sent to Telegram, then state is committed separately. If send succeeds but commit fails, next digest run re-detects the same entries and sends duplicate appendices.

**Fix**: Wrap send+commit in a transaction-like pattern, or commit state first and compensate on send failure.

### C8. Safety scores empty when no coins mentioned in earlier signals
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 189-241

`collectSafetyScores` filters to only coins mentioned in depegs, supply changes, or velocity signals. If all those collectors return empty (calm day, all coins stable), `mentionedCoins = []` even though there may be F-rated or newly downgraded coins worth highlighting.

**Fix**: Always include grade extremes (top-3 worst-graded coins above a mcap threshold) regardless of mention status.

### C9. Contradictory regime narrative guidance in system prompt
**File**: `worker/src/cron/daily-digest.ts`, ~line 58-94

- Line 94: "FOCUS: never mention more than 3 data categories" — but CRISIS guidance (line 85) names 4+ categories as P2 material
- Line 91: suggests P1/P2/P3/P4 structure — but line 94 says "three tight paragraphs beat four that pad"
- Tone guidance is regime-locked but should also depend on data (CALM + 3 resolved depegs should be celebratory, not wistful)

**Fix**: Reconcile paragraph count guidance; allow tone to vary with data, not just regime.

---

## Tier 2 — High (data quality issues, content violations, UX gaps)

### H1. 4 digests exceed 270-character tweet limit
| Date | Title chars | Text chars | Total | Over by |
|------|-------------|------------|-------|---------|
| 2026-03-07 | 32 | 241 | **273** | 3 |
| 2026-03-04 | 29 | 244 | **273** | 3 |
| 2026-03-02 | 37 | 251 | **288** | 18 |
| 2026-02-28 | 22 | 249 | **271** | 1 |

System prompt says "under 270 characters" but code uses `MAX = 280`. The 10-char headroom comment (prompt line 113) creates ambiguity. Additionally, `injectCashtags()` runs after truncation sizing, increasing length post-calculation.

**Fix**: Enforce 270 hard limit in code; run cashtag injection before length check.

### H2. Three early digests severely underdeveloped
Digests from 2026-02-25, 2026-02-26, and 2026-02-27 have only ~2 sentences in the extended field, far below the "3-4 paragraphs, 150-280 words" density contract. These were likely early runs before the prompt was refined.

**Fix**: Consider regenerating these three digests with the current prompt, or add a minimum word-count validation gate.

### H3. Forbidden phrase "Meanwhile" used twice
- 2026-03-16: "Meanwhile, FDUSD is printing..."
- 2026-03-14: "Meanwhile SUSD escalated..."

System prompt explicitly forbids "Meanwhile" (line 118). The LLM ignores this constraint ~8% of the time.

**Fix**: Add post-processing regex to catch and log forbidden phrases; consider adding "Meanwhile" to the dash-stripping post-processor.

### H4. Title duplication across digests
"USDC Touches Its Ceiling" used for both 2026-03-13 and 2026-03-11 (2 days apart). Variety enforcement should catch this but doesn't because it tracks meta signals, not titles.

**Fix**: Include last 5 titles in the variety context sent to the LLM.

### H5. Active depegs semantics unclear to LLM
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 47-68

`activeDepegCount` means "currently-live depegs" (WHERE ended_at IS NULL), not "depegs in the last 24h." A depeg that resolved 2 minutes ago is excluded. The prompt doesn't clarify this, so the LLM may build incorrect narratives about depeg frequency.

**Fix**: Either rename to `currentlyActiveDepegs` and add `depegsLast24h` as a separate metric, or clarify semantics in the prompt.

### H6. Supply velocity signals fire on noise
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 152-166

`velocityRatio > 2.5` with a small baseline fires on noise: if 7d avg = +$100/day and today = +$300, ratio = 3.0 (signal emitted) but absolute change is $200 on a $10B coin (0.002%). No mcap-normalization.

**Fix**: Add minimum absolute-change threshold (e.g., $1M or 0.1% of mcap).

### H7. Trajectory data missing gap detection
**File**: `worker/src/cron/daily-digest.ts`, ~line 210-228

7-day PSI/mcap/gauge trajectory is presented without indicating missing days. LLM may overfit trends to gaps (e.g., PSI 95→92 looks like a 2-point slide but might span 4 calendar days with 2 missing).

**Fix**: Include dates alongside values, or note gap count.

### H8. PSI component semantics undefined in prompt
**File**: `worker/src/cron/daily-digest.ts`, ~line 180-182

Prompt outputs `severity=20, breadth=15, trend=+2` without explaining what these numbers mean (scale, range, interpretation). LLM must guess.

**Fix**: Add a one-line glossary in the Context block (e.g., "severity: weighted depeg impact 0-100; breadth: affected coins as % of mcap; trend: 24h score delta").

### H9. Resolved depegs thresholds too high
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 247-280

Filter: `peakBps > 200 AND mcapUsd > 50_000_000`. This drops recovery narratives for medium events: a 199-bps depeg on a $100M coin resolving is silently excluded.

**Fix**: Lower to `peakBps > 100 AND mcapUsd > 20_000_000`, or include impact-weighted scoring.

### H10. DEWS elevated coins sorted by raw score, not by change
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 448-472

A coin in DANGER for 30 days (stable high score) ranks above a coin that just jumped from CALM to ALERT (fresh escalation). The LLM sees stale stress as more important than new stress.

**Fix**: Sort by score delta or include `changeFromYesterday` field.

### H11. Archive API hard-limited to 365 entries
**File**: `worker/src/api/digest-archive.ts`, line 5-6

`LIMIT 365` with no pagination. Once the database accumulates >365 digests (~1 year), older entries become inaccessible. Frontend pagination is client-side only and doesn't know about the truncation.

**Fix**: Implement cursor-based pagination, or increase to a higher limit with lazy loading.

### H12. Grade transition "methodology bump" detection too brittle
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 663-672

Assumes ">10 simultaneous transitions = version change" but:
- 11 coins changing due to a real event (not a bump) → falsely excluded
- A bump affecting exactly 10 coins → not detected
- Doesn't check if all changes are in the same direction

**Fix**: Compare against known methodology version timestamps, or check for directional uniformity.

### H13. DailyDigestResponse type marks always-present fields as optional
**File**: `shared/types/digest.ts`, ~line 142-148

`digestTitle`, `digestExtended`, `generatedAt`, `editionNumber` are marked optional (`?`) but the API always returns them (as value or `null`). Creates maintenance confusion.

**Fix**: Change to required `string | null` / `number | null`.

### H14. Liquidity shifts depend on cron timing
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 775-832

Digest runs at 08:05 UTC. If yesterday's dex_liquidity_history snapshot hasn't arrived yet (snapshots come from :10/:40 cron), the code compares stale data. Shift not captured.

**Fix**: Use a lookback window (e.g., latest row within 36h) instead of exact midnight alignment.

### H15. Text field title duplication (2026-02-28)
The text field for "Gold Moves, Cops Busy" repeats the title inside the body: "Gold Moves, Cops Busy\n\nXAUT +$222M...". System prompt says "Do NOT start or repeat the title in this field — the title is prepended automatically."

**Fix**: Add post-processing check that strips the title from the text field if it appears as a prefix.

---

## Tier 3 — Moderate (inefficiencies, edge cases, polish)

### M1. Dash post-processing is a bandaid
**File**: `worker/src/cron/daily-digest.ts`, ~line 671-675

`stripDashes()` replaces em/en dashes with commas. If Claude respects the constraint, this is unnecessary. If it doesn't, blind comma replacement mangles intent ("A or B — here's why" becomes "A or B, here's why").

**Fix**: Log when dashes are found (prompt compliance signal); consider smarter replacement (dash → semicolon or period based on context).

### M2. Blacklist collector fetches all event types then filters in JS
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 74-110

Query fetches all events; JS filters to `blacklist` and `destroy`. Wastes bandwidth if other event types exist.

**Fix**: Add `WHERE event_type IN ('blacklist', 'destroy')` to SQL.

### M3. PSI contributor validation too lenient
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 486-515

Only checks `typeof === "number"`, not range. Extreme outliers (1M bps, negative factors) pass through and corrupt marketImpact calculation.

**Fix**: Add range guards (e.g., bps 0-10000, factor 0-1).

### M4. User prompt data format inconsistency
**File**: `worker/src/cron/daily-digest.ts`, ~line 160-387

Different collectors format data differently:
- Depegs: "symbol: Xbps off-peg, mcap $Y"
- Supply: "symbol $change (now $mcap)"
- DEWS: "symbol: grade (score), mcap $X — dimensions: ..."
- Yield: "symbol: X% APY, mcap $Y, warnings: list"

**Fix**: Standardize to "symbol | metric | mcap | extra" for all data blocks.

### M5. Historical context queries are fragmented (N+1)
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 521-650

7 sequential queries for historical context (PSI depth, oldest digest, precedent, band history, ATH, ATH date, largest change). Some can be combined.

**Fix**: Merge ATH + date into subquery; parallelize independent queries.

### M6. Twitter cashtag injection increases length after sizing
**File**: `worker/src/lib/twitter.ts`, ~line 79-94

`injectCashtags()` runs after truncation sizing, so `USDC → $USDC` adds 1 char per symbol post-truncation.

**Fix**: Run cashtag injection first, then measure and truncate.

### M7. Telegram HTML escape doesn't handle quotes
**File**: `worker/src/lib/telegram.ts`, ~line 8-11

`escapeHtml()` only handles `&`, `<`, `>`. If a coin name contains quotes (unlikely but possible), href attributes break.

**Fix**: Add `"` → `&quot;` and `'` → `&#39;` escaping.

### M8. Cross-day trends don't indicate included dates
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 856-888

Trajectory arrays show 3-7 values without dates. LLM can't tell if gaps exist.

**Fix**: Include ISO date alongside each trajectory point.

### M9. Yield anomalies missing APY sanity check
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 725-769

No upper bound on `current_apy`. Values like 1000%+ pass through and could skew LLM narrative.

**Fix**: Cap or flag anomalous APY values (e.g., >100% gets a warning annotation).

### M10. Snapshot cache profile suboptimal
**File**: `worker/src/api/digest-snapshot.ts`, ~line 150

Uses `CACHE_PROFILES.slow` (3600s edge). Digest snapshots are immutable after generation — could use 24h+ cache.

**Fix**: Set `s-maxage=86400` for digest endpoints.

### M11. Mint-burn flows silently skip coins without 30d baseline
**File**: `worker/src/cron/daily-digest/collectors.ts`, ~line 286-370

New coins with <30d history are excluded from flow analysis without logging.

**Fix**: Log exclusion count; consider shorter fallback window (e.g., 7d baseline).

### M12. No digest content versioning
Digests are stored without a version field. If the system prompt or data structures change, historical digests can't be regenerated or migration-tracked.

**Fix**: Add `digest_version: number` to input_data.

---

## Content Quality Summary (25 Digests)

### Overall Metrics
| Metric | Result |
|--------|--------|
| Issue-free digests | 18/25 (72%) |
| Excellent voice consistency | 25/25 (100%) |
| Data density (numbers + coins per digest) | 4-10 (avg ~6) |
| P1/P2/P3 structure compliance | 22/25 (88%) |
| Character limit compliance (<270) | 21/25 (84%) |
| Forbidden phrase compliance | 23/25 (92%) |
| Title uniqueness | 24/25 (96%) |

### Coin Feature Distribution
| Coin | Appearances | Role |
|------|-------------|------|
| USDC | 25/25 | Constant protagonist (ATH narrative arc) |
| USDT | 20/25 | Big Three counterpoint |
| KAU/KAG | 12/25 | Gold-backed volatility cluster |
| LUSD | 10/25 | Recurring stress signal |
| PYUSD/USDS | 9/25 | Secondary flow stories |
| EURS | 7/25 | "Zombie depeg" metaphor vehicle |
| DAI | 6/25 | Acceleration pattern support |

### Quality Arc
- **Feb 25-27**: Weakest period — underdeveloped extended sections (2 sentences each)
- **Mar 1-16**: Consistently strong — proper structure, data density, voice
- **Weekly recap**: Distinctly deeper than dailies; strategic 7-day arc

### Systematic Content Violations (3+ instances)
1. Character count overruns: 4 digests
2. Underdeveloped extended sections: 3 digests (all Feb 25-27)
3. "Meanwhile" usage: 2 digests

---

## Remediation Priority Matrix

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | C1: DEWS escalation filtering | 1h | Fixes missing critical stress narratives |
| **P0** | C2: Weekly snapshot 400 | 30m | Fixes broken weekly detail pages |
| **P0** | C3: NULL/NaN mcap guards | 30m | Prevents data corruption cascade |
| **P1** | C8: Safety scores always include extremes | 1h | Ensures grade data on calm days |
| **P1** | H1: Enforce 270-char limit in code | 1h | Fixes tweet overflow |
| **P1** | H6: Supply velocity mcap-normalization | 1h | Reduces false positive signals |
| **P1** | C4: Variety enforcement (titles + wider window) | 2h | Prevents title/angle duplication |
| **P1** | H3: "Meanwhile" post-processing catch | 30m | Enforces prompt constraints |
| **P2** | C5: Regime classification mcap-weighting | 2h | Better regime accuracy |
| **P2** | C9: Reconcile prompt contradictions | 1h | Clearer LLM guidance |
| **P2** | H7: Trajectory gap detection | 1h | Prevents overfit trend narratives |
| **P2** | H8: PSI component glossary | 15m | Better LLM interpretation |
| **P2** | H10: DEWS sort by delta | 1h | Fresh escalations surface first |
| **P3** | All Tier 3 items | 4-6h | Polish and efficiency |

---

*Audit methodology: parallel deep-dive into all generation code, infrastructure layer, and individual analysis of each generated digest.*
