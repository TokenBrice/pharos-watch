# Daily And Weekly Digest Implementation Audit

Date: 2026-04-15

Scope: daily digest generation, weekly recap generation, Opus prompts, collector inputs, publication, archive/snapshot support, and the checked-in historical digest output sample.

## Assumptions

- This is a read-only audit. No production behavior was changed.
- The desired product bar is an editorial morning note: entertaining, selective, market-aware, resistant to data artifacts, and useful enough that readers expect it daily.
- The digest should not depend on Opus to discover basic data-quality caveats from an unordered evidence dump. Code should pre-rank and label candidate stories before the model writes.

## Executive Assessment

The daily digest prompt is already well above a generic LLM summary prompt. It has a distinct voice, regime-aware structure, market-impact language, recent-angle variety, historical context guidance, and a JSON output contract. The core weakness is not voice. The weakness is editorial triage.

Today, the code sends Opus many signal sections and asks it to pick the "sharpest" story. Some signals are already filtered, but they are not normalized into a single scored candidate set with freshness, novelty, confidence, market impact, and artifact risk. That leaves the model responsible for deciding whether a chronic tiny depeg, missing collector, stale off-peg condition, implausible yield, or weak liquidity change is a story. That is exactly where a daily market rendez-vous can become repetitive or over-comment on flukes.

The weekly recap has a larger gap. It mostly sees daily headlines/summaries plus coarse aggregate counters, not the underlying weekly event leaderboard. It can synthesize the prior editorial choices, but it cannot reliably discover the week's most important omitted event.

## What Is Working

- `worker/src/cron/daily-digest/prompt.ts` has a clear editorial voice and enough constraints to avoid bland summaries.
- Stablecoins-cache failure is fail-closed in `worker/src/cron/daily-digest/input.ts`, so the system avoids generating a false zero-market digest when the main market payload is unavailable.
- `daily_digest.input_data` preserves the full generation snapshot, which is excellent for auditability and historical pages.
- Anthropic, Telegram, and Twitter are circuit-aware, and social delivery failures are non-fatal to persistence.
- The prompt now uses recent `meta` to discourage lead/tone/coin repetition, which is the right direction.

## Priority Findings

### P0. Add a pre-prompt editorial candidate layer

Location: `worker/src/cron/daily-digest/input.ts`, `worker/src/cron/daily-digest/prompt.ts`, collectors under `worker/src/cron/daily-digest/`

The current prompt receives separate sections: active depegs, PSI, trajectories, supply velocity, mint/burn, DEWS, grades, yield anomalies, liquidity shifts, resolved depegs, and recent angles. It tells Opus to rank by market impact, but it does not provide a unified ranking table.

Recommendation: add a generated `editorialCandidates` block before the raw sections. Each candidate should include:

- `id`: stable key, such as `depeg:usdt-tether:active` or `flow:usdc-circle:velocity-reversal`
- `kind`: depeg, supply, DEWS, mint-burn, blacklist, grade, yield, liquidity, PSI, structural
- `headlineFacts`: 2-4 source-backed facts
- `impactScore`: common scale, based on mcap x deviation, flow size, mcap affected, or breadth
- `novelty`: new, worsening, improving, recurring, chronic
- `confidence`: high, medium, low
- `artifactRisk`: none, low, medium, high
- `suppressReason`: present when the story should not be used as a lead
- `whyItMatters`: one plain-English reason a reader should care today

Then change the prompt from "inspect all sections and pick" to "lead from the highest candidate that is not suppressed; raw sections are supporting evidence only." This would directly address the user's goal of avoiding obvious data flukes while still keeping the prose lively.

### P0. The prompt needs explicit artifact and chronic-condition rules

Location: `worker/src/cron/daily-digest/prompt.ts:10`

The system prompt says not to lead with small illiquid coins that have been off-peg for weeks, but it does not define how the model can know a depeg is stale or artifact-prone. The active depeg payload only sends symbol, bps, and mcap, not start time, age, source confidence, or whether the condition is chronic.

Recommendation: add data fields and prompt rules:

- Send `startedAt`, `ageHours`, `lastUpdatedAt`, `direction`, `sourceCount`, and `isChronic` for active depegs.
- Suppress chronic off-peg assets unless they changed materially in the last 24h, crossed a new threshold, recovered, or have large market impact.
- For yield and liquidity, suppress single-source jumps unless corroborated by TVL, price, flow, or DEWS changes.
- For blacklist rows with zero/unknown amount, treat count-only activity as background unless the issuer or chain pattern changed.
- Add a prompt rule: "Do not make jokes out of artifacts. Ignore them unless the artifact itself is operationally relevant."

### P0. Active and resolved depeg ranking is signed, not absolute market impact

Locations:

- `worker/src/cron/daily-digest/collectors-market.ts:29`
- `worker/src/cron/daily-digest/collectors-market.ts:160`
- `worker/src/api/digest-snapshot.ts:107`

`collectActiveDepegs()` computes impact as `peak_deviation_bps * mcapUsd` and sorts descending. A large below-peg event has negative impact and can sort behind a much smaller above-peg event. `collectResolvedDepegs()` orders SQL by `peak_deviation_bps DESC LIMIT 10` before converting to absolute bps, so large negative deviations can be dropped before filtering. The snapshot API does the same signed ordering for historical depeg cards.

This conflicts with the prompt's core instruction: rank by deviation x market cap. It also increases the chance that Opus comments on a less important above-peg move while missing a more important below-peg stress event.

Recommendation: rank by `ABS(peak_deviation_bps) * mcapUsd` and query/order resolved depegs by absolute deviation before limiting.

### P0. Weekly recap input is too thin to guarantee the week's real story

Location: `worker/src/cron/weekly-recap.ts:110`

The weekly prompt receives:

- PSI range and dominant band
- market-cap start/end
- summed active-depeg counts
- summed blacklist counts
- grade transition count
- gauge range
- daily headlines and daily short summaries

It does not receive weekly leaderboards for the actual underlying events: largest active or resolved depeg by impact, biggest supply flows, largest DEWS escalations, top mint/burn pressure shifts, largest blacklist value, grade changes by mcap, liquidity collapses, or yield anomalies. Because of that, the weekly recap can only synthesize what the daily digests already chose to mention.

Recommendation: build a real `WeeklyInputData.signals` object from the stored daily `inputData`:

- top depeg episodes by max `abs(bps) * mcap`
- unique affected coins and chronic depeg exclusions
- largest 7d and single-day supply movers
- biggest DEWS band changes and ALERT+ mcap
- gauge min/max plus worst daily pressure coin
- blacklist total value and top issuer/chain
- grade transitions with direction and mcap
- yield/liquidity anomalies, with confidence/artifact risk

Then tell Opus: "The weekly recap must synthesize from weekly signals, not just restate daily summaries."

### P1. Post-generation quality gates are too permissive

Locations:

- `worker/src/cron/daily-digest/response.ts:83`
- `worker/src/lib/schemas.ts:22`
- `worker/src/cron/digest/platform.ts:104`

The schema defaults missing `title`, `text`, and `extended` to empty strings. If JSON parse fails, raw text is stored as `digestText`, `digestExtended` is empty, and generation still proceeds. The parser strips forbidden dashes and phrases but does not enforce paragraph count, word count, combined tweet length, title duplication, JSON-only output, or minimum data density.

For a public editorial product, malformed output should not be automatically distributed.

Recommendation:

- Make `title`, `text`, and `extended` required for non-fallback digests.
- Add a validator after parsing: title 2-8 words, extended 3-4 paragraphs for daily, daily extended 150-280 words, weekly extended 250-400 words, title+text <= 270 before social posting, no title prefix in text, no code fence, no empty extended.
- On validation failure, do one corrective retry with the failed checks included.
- If the retry fails, persist a degraded row only if useful for debugging, but skip Twitter/Telegram.

### P1. Degraded collector state is not shown to Opus

Locations:

- `worker/src/cron/daily-digest/input.ts:31`
- `worker/src/cron/daily-digest/prompt.ts:115`

Collector failures are stored in `inputData.degradedSources` and logged, but `buildUserPrompt()` does not include them. If a collector fails, the model sees the section missing and may infer "nothing happened."

Recommendation: include a short "Data quality notes" block near the top:

```text
Data quality notes:
  Missing collectors: dews-stress-query, supply-velocity-query
  Do not infer calm from missing sections. Avoid claims about unavailable categories.
```

This is especially important for the desired "key events of the market" behavior: missing DEWS or mint/burn data should narrow claims, not quietly disappear.

### P1. Daily prompt is good stylistically but over-indexes on forced drama

Location: `worker/src/cron/daily-digest/prompt.ts:20`

"When nothing happened, make the calm sound ominous or amusing" helps voice, but it can also push the model to manufacture tension from low-quality micro-signals. The checked-in historical output shows the digest sometimes repeatedly frames BEDROCK as "calm but the plumbing flinched" or "serene surface, stress underneath." That can become a house style tic rather than insight.

Recommendation: replace this with a reader-value rule:

```text
If the market is genuinely calm, say so clearly. The job is not to force menace.
Use wit to make the calm memorable, but only imply tension when a fresh, high-confidence signal supports it.
Every lead must answer: why this matters today, why the size matters, and what changed.
```

### P1. Variety metadata is model-authored and not normalized

Locations:

- `worker/src/cron/daily-digest/runtime-helpers.ts:9`
- `worker/src/lib/schemas.ts:26`
- `worker/src/cron/daily-digest/prompt.ts:302`

The digest relies on the model to report its own `lead`, `tone`, and `coins`. There is no enum validation, title repetition check, metaphor/style tracking, or programmatic enforcement. Historical output in `data/digests.json` includes repeated titles such as "USDC Touches Its Ceiling" two days apart, which the current prompt alone would not reliably prevent.

Recommendation:

- Normalize `lead` and `tone` to enums.
- Derive `coins` from output text as a backstop.
- Store `titleFingerprint` and `metaphorTags` or at least recent title n-grams.
- Add a hard retry if title, lead, or primary coin repeats within the configured window unless all other candidate leads are suppressed.
- Exclude weekly rows from the daily variety window or label them explicitly as weekly context.

### P1. Regime classification can be moved by counts rather than impact

Location: `worker/src/cron/daily-digest/prompt.ts:92`

`classifyRegime()` returns TENSION when `activeDepegs >= 2` or `alertPlus >= 3`, regardless of mcap or freshness. A few tiny chronic depegs or ALERT coins can change the tone of the whole digest. The prompt later tells Opus to ignore small illiquid coins, but the regime has already biased structure and tone.

Recommendation: use impact-weighted regime thresholds:

- active depeg impact score, not just count
- ALERT+ mcap and new ALERT+ mcap, not just ALERT+ count
- chronic/stale depegs excluded from regime escalation unless market impact is high
- FTQ/gauge thresholds unchanged but accompanied by affected mcap

### P1. Weekly depeg totals double-count persistent conditions

Location: `worker/src/cron/weekly-recap.ts:80`

`totalDepegsThisWeek` sums each daily `activeDepegCount`. That is a daily stock count, not a weekly event count. One persistent depeg active all week counts seven times. The prompt labels it "Total depeg events across the week," which can mislead Opus and readers.

Recommendation: either rename it to "daily active-depeg observations" or compute unique depeg episodes from `depeg_events`. For editorial weekly use, compute both: unique episodes and active-observation burden.

### P1. Weekly recap period is implicit and can be surprising

Location: `worker/src/cron/weekly-recap.ts:166`

The job runs Monday after the daily digest and selects rows newer than `now - 8 days`. At 08:05 UTC, the prior Monday digest is usually just outside the cutoff, while the current Monday daily digest is included. The effective period is Tuesday through Monday, not a conventional Monday-Sunday week.

That may be intentional, but it should be explicit in the prompt/title and docs. If readers expect a "week of Monday" recap, this is off by one day.

Recommendation: choose one contract:

- calendar week: previous Monday through Sunday, generated Monday
- trailing seven daily editions through Monday, titled as such

Then make `weekStartDate`, `weekEndDate`, Telegram copy, and archive labels match that contract.

### P1. Weekly Telegram links point at the daily slug

Locations:

- `worker/src/cron/weekly-recap.ts:234`
- `worker/src/lib/telegram.ts:28`
- `scripts/sync-digests.ts:82`

Weekly archive routes use `/digest/YYYY-MM-DD-weekly/`, but `generateWeeklyRecap()` passes a plain `YYYY-MM-DD` date to `postDigestToTelegram()`. Telegram therefore links weekly readers to the daily digest page for that date, not the weekly recap page.

Recommendation: pass `${date}-weekly` for weekly Telegram posts or let `postDigestToTelegram()` accept an explicit route slug.

### P1. Digest snapshot selection does not distinguish daily and weekly rows

Location: `worker/src/api/digest-snapshot.ts:58`

The snapshot API strips `-weekly` for date parsing but then queries the latest row for that UTC day without filtering by digest type. On a Monday with both a daily and weekly row, the daily page can receive weekly snapshot data if weekly was generated later. Conversely, a manual daily regeneration after the weekly recap could make the weekly page receive daily snapshot data.

Recommendation: when `date` has `-weekly`, require `digest_meta.type = 'weekly'`; otherwise require non-weekly rows. Apply the same distinction to previous-row lookup.

### P2. Blacklist "last 24h" is actually the prior UTC day

Locations:

- `worker/src/cron/daily-digest/collectors-market.ts:52`
- `worker/src/cron/daily-digest/prompt.ts:198`

The query filters `timestamp >= todayTs - ONE_DAY AND timestamp < todayTs`, which is the previous UTC calendar day. The prompt says "Blacklist activity (last 24h)." Since the digest runs around 08:05 UTC, events from 00:00 to 08:05 are excluded while older events from the prior midnight are included.

Recommendation: either change the query to rolling `nowSec - 24h` or label it "previous UTC day" in prompt and UI.

### P2. Supply velocity cannot produce deceleration

Location: `worker/src/cron/daily-digest/collectors-market.ts:133`

The code enters the branch only when direction reversed or `velocityRatio > 2.5`. Inside that branch, the ternary marks ratio > 2.5 as "accelerating"; the "decelerating" label is effectively unreachable. A large top-coin slowdown without a full direction reversal can be missed.

Recommendation: add separate acceleration and deceleration rules:

- accelerating: `abs(change1d) > 2.5 * abs(dailyAvg7d)` and same direction
- decelerating: same direction but `abs(change1d) < 0.4 * abs(dailyAvg7d)`, with a material weekly base
- reversed: direction changed and absolute threshold passed

### P2. Data windows and readiness are mixed

Locations:

- `worker/src/handlers/scheduled/daily-0805.ts:19`
- `worker/src/cron/daily-digest/input.ts:122`
- `worker/src/cron/daily-digest/collectors-market.ts:193`

The daily digest combines rolling data, UTC-day snapshots, latest 15-minute PSI samples, and prior-day blacklist windows. The 08:05 slot assumes the 08:00 snapshots are ready, but the digest does not verify that today's supply/PSI snapshot exists before drawing "yesterday" comparisons.

Recommendation: add a lightweight readiness block to the prompt input:

- stablecoins cache age
- supply snapshot date used
- PSI sample timestamp and daily snapshot timestamp
- mint/burn window end
- blacklist window start/end

Then suppress specific story classes when their supporting snapshot is stale or missing.

### P2. Prompt ordering can bias Opus toward sections that happen to print first

Location: `worker/src/cron/daily-digest/prompt.ts:120`

The user prompt always begins with market cap, active depegs, and PSI before other categories. Even with regime rules, this can bias the model toward PSI/depeg framing and contributes to repetitive "PSI is calm but..." openings.

Recommendation: put the computed `editorialCandidates` block first, sorted by score. Put raw sections below under "Supporting evidence."

### P2. The weekly prompt lacks its own artifact policy and variety policy

Location: `worker/src/cron/weekly-recap.ts:15`

The weekly system prompt is shorter than the daily prompt and lacks explicit market-impact ranking, artifact suppression, chronic-condition handling, degraded data handling, and recent weekly variety. It inherits the voice, but not the quality controls.

Recommendation: give weekly the same artifact policy and add weekly-specific rules:

- do not merely average the daily tone
- do not turn seven repeated chronic depeg observations into seven events
- prefer turning points and cross-day arcs over largest raw count
- state when a calm week was genuinely calm

## Prompt-Specific Rewrite Direction

Keep the voice, but make the contract more editorial and less theatrical. Suggested additions:

```text
Your first job is selection. Your second job is style.

Use the Editorial Candidates block as the source of truth for lead selection.
Do not lead with a candidate marked artifactRisk=high or suppressReason present.
Raw evidence sections are supporting material only.

A lead must pass all three tests:
1. What changed in the last digest window?
2. Why is the affected market size large enough to matter?
3. Why should a stablecoin reader care today?

If the market is calm, say so. Do not manufacture menace from weak data.
Wit is welcome; false drama is not.

Do not comment on obvious data artifacts, chronic tiny depegs, stale off-peg conditions, first-day no-baseline anomalies, impossible APYs, or zero-amount blacklist rows unless the data explicitly marks them as editorially relevant.

When data quality notes list a missing collector, avoid claims about that category.
Missing evidence is not evidence of calm.
```

Recommended `meta` shape:

```json
{
  "leadSignalId": "dews:musd:watch-alert",
  "lead": "dews-band-change",
  "tone": "clinical",
  "coins": ["MUSD"],
  "usedCandidateIds": ["dews:musd:watch-alert", "liquidity:musd:score-jump"],
  "suppressedCandidateIds": ["depeg:eurs:chronic-small"]
}
```

That makes future variety and artifact audits programmatic rather than dependent on prose.

## Recommended Implementation Sequence

1. Fix correctness bugs first: absolute depeg ranking, weekly Telegram slug, daily/weekly snapshot filtering, weekly depeg count semantics.
2. Add response validation and one corrective retry before any social posting.
3. Add `editorialCandidates` and artifact/freshness labels to daily input.
4. Rewrite the daily prompt around candidates first, supporting evidence second.
5. Expand weekly input from daily summaries to structured weekly signal aggregation.
6. Normalize `meta` and add tests for title/lead/coin repetition.
7. Add fixture-based prompt tests for fluke suppression: chronic small depeg, high APY artifact, zero-amount blacklist burst, missing DEWS collector, and one real high-impact event that must win.

## Verification Gaps

No tests were run for this audit because it made no code changes. The relevant future tests should live near:

- `worker/src/cron/__tests__/daily-digest.test.ts`
- `worker/src/cron/__tests__/weekly-recap.test.ts`
- `worker/src/api/__tests__/digest-snapshot.test.ts`
- `worker/src/lib/__tests__/telegram.test.ts`

