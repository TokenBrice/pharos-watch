# Digest Pipeline

Daily AI-generated stablecoin market recap, distributed to the web, Twitter/X, and Telegram.

---

## Overview

The digest pipeline has four layers:

1. **Generation** — a Cloudflare Worker cron collects market data and calls Claude to produce a short editorial recap
2. **Storage** — the result is persisted to D1 (`daily_digest` table)
3. **Distribution** — immutable Telegram editions are persisted before Bot API delivery, then sent immediately or retried from the stored payload
4. **Frontend** — served via public API endpoints, displayed on the homepage and a dedicated archive

Daily and weekly generation now share a common worker substrate in `worker/src/cron/digest/platform.ts` for the Anthropic request/parse path, `daily_digest` row insertion, and circuit-aware delivery wrappers. The daily and weekly jobs still own their distinct input-building and prompt logic.

Each digest has four fields produced by the LLM:

| Field | Description | Constraint |
|-------|-------------|------------|
| `title` | 2–6 word punchy headline | — |
| `text` | Tweet-sized distillation of the day's key take | ≤270 chars combined with title |
| `extended` | 3–4 short paragraphs of editorial analysis | 150–280 words target |
| `meta` | Editorial choice metadata for variety enforcement and audit | `{ leadSignalId, lead, tone, coins, usedCandidateIds, suppressedCandidateIds }` |

---

## Generation

**File:** `worker/src/cron/daily-digest.ts`
**Schedule:** daily at **08:05 UTC** (`"5 8 * * *"`)
**Dependency:** runs on the daily 08:05 UTC slot, five minutes after `snapshot-psi` writes the daily PSI row at 08:00 UTC
**Dedup guard:** skips if the latest digest is <1 hour old (bypassed by `force=true`)

### Data collection

The cron assembles a `DigestInputData` object from the collector set below before calling the LLM:

All ecosystem monetary aggregates use the `core-stablecoins-v1` universe: active `core-stablecoin` and `cash-equivalent` listings only. Tracked variants and stable-value investments remain fully monitored and can appear in digest depeg, DEWS, safety, yield, and liquidity signals, but they are excluded from total market cap, supply change/velocity, mint/burn aggregates, and PSI contribution. Every new input snapshot persists `aggregateUniverse: "core-stablecoins-v1"`; weekly rollups prefer marked rows so legacy and core totals are not mixed during the cutover week.

| Category | Source | Key signals |
|----------|--------|-------------|
| Market metrics | stablecoins cache + listing governance registry | Core-universe total mcap, 7d delta, biggest supply mover (>$1M), cache age |
| Editorial candidates | derived from all collected signals | Pre-ranked lead candidates with impact, novelty, confidence, artifact risk, and suppression reasons |
| Depeg events | `depeg_events` table + fresh `stablecoins` cache price and the event's `peg_reference` | Active count and active depeg inclusion follow open `depeg_events` rows (the canonical detector closes recovered events). Severity decisions — criticality, suppression, sort order, impact score, candidate titles — run on the **live deviation** (`currentBps`, computed from a cache price within the public stablecoins freshness budget vs the event's peg reference); the stored peak is carried separately as context (`peakBps`) and used only as a flagged fallback (`severityBasis: "peak-fallback"`) when no live price resolves or the stablecoins cache is stale. Top 8 are ranked by critical severity then impact (\|live bps\| × mcap when fresh, peak fallback otherwise), with active age/chronic suppression and the critical-depeg override evaluated on the selected severity basis |
| Stability Index | `stability_index_samples` + `stability_index` | Current PSI from latest 30-minute sample, yesterday's from daily table |
| Blacklist activity | `blacklist_events` (rolling last 24h) | Event count, total USD affected; threshold: ≥2 events OR >$10M single; zero-value bursts are artifact-risk candidates |
| Supply velocity | top 10 coins by mcap | 1d vs 7d changes; signals: "reversed", "accelerating", "decelerating" with material daily/weekly thresholds |
| Safety scores | canonical V9 publication | Native V9 grades, three pillars, reviewed reasons, caps, and publication health |
| Resolved depegs | `depeg_events` (last 48h) | Filters: peak >100 bps AND mcap >$20M; top 5 by impact score |
| Mint-burn flows | published `GET /api/mint-burn-flows` aggregate payload (cache key `mint-burn-flows:v3:aggregate:24`) | Bank Run Gauge (mcap-weighted composite, **re-binned from the publication, never recomputed**), Flight-to-Quality (safe-haven vs risky net flows from the canonical V9 publication), top pressure coins (\|FIS\| > 20), top 3 chains by absolute 24h net flow |
| Total mcap ATH | derived from core-marked `daily_digest` rows (`json_extract` on stored `totalMcapUsd`) | Anchors current core total mcap against its post-cutover Digest-window ATH value and date |
| DEWS stress | `stress_signals` + `stress_signal_history` | Band distribution (CALM/WATCH/ALERT/WARNING/DANGER), up to 5 rank-changing band moves, up to 5 elevated coins (ALERT+ with mcap >$10M) |
| Historical context | `daily_digest` + `stability_index` + `supply_history` | PSI precedent from prior digest rows (last time score was at/below current) and digest tracking days, band streak from `stability_index`, supply mover ATH and largest historical weekly change from `supply_history` |
| Grade transitions | `safety_score_history_v2` | Organic report-card grade changes from the active model/policy/build (last 48h); activation, rollback, restoration, and methodology/build baselines are excluded |
| PSI contributors | `stability_index_samples` (input_snapshot) | Top 3 coins driving PSI severity by market impact (|bps| x mcap x factor) |
| Yield anomalies | `yield_data` (is_best rows) | Coins with active warning signals (yield-spike, yield-divergence, negative-trend, reward-heavy, tvl-outflow, zero-yield); APY vs 7d/30d averages; filtered to mcap >$10M and APY <500%; top 5 |
| DEX liquidity shifts | `dex_liquidity_history` | Day-over-day score changes >=8 points; TVL comparison; filtered to mcap >$10M. Every pair must clear the [liquidity admission gate](#dex-liquidity-admission-gate) before it becomes editorial evidence |
| Cross-day trends | `daily_digest` (archived input_data) | 7-day trajectories for PSI score/band, total mcap, and Bank Run Gauge; requires >=3 days of history |
| Data quality | collector status + window metadata | Degraded collectors, cache age, PSI source time, mint/burn and blacklist windows |
| Recent digests | last 7 non-weekly rows from `daily_digest` | Passed to LLM to enforce daily variety |
| Cause context | `shared/data/annotations/curated-annotations.ts` | Curated, primary-sourced cause annotations for coins in the depeg set (annotation `ts` within 90d before event start), rendered as a `CAUSE CONTEXT` prompt block so coverage can say *why* a coin broke; the model is instructed never to invent causes beyond the curated list |
| Standing conditions | derived from `topDepegs` | Chronic ledger: ongoing depegs ≥48h old (`standingConditions[]`) with day counts and live deviation — served through `/api/daily-digest`/snapshot, rendered as a compact "Standing:" strip on digest pages, and appended as one deterministic line to the Telegram edition, so demoted stories stay visible without narrated day-count headlines |
| Digest intelligence | current `DigestInputData` + latest archived `input_data` | Deterministic risk tape, what changed since yesterday, prior next-trigger outcomes, next triggers, calm-day frame, and editorial audit |

`DigestInputData` is defined in `shared/types/digest.ts` (re-exported via `shared/types/index.ts`) and imported by the digest cron, digest snapshot API, and frontend snapshot hook. Its optional `aggregateUniverse` marker preserves compatibility with archived pre-cutover rows.

Four additional optional fields were added to `DigestInputData` in the v2 refinement: `mintBurnFlows`, `dewsStress`, `historicalContext`, and `gradeTransitions`. All are populated only when their source data exists — the LLM writes from what's available.

A further enrichment pass added four more optional fields: `psiContributors`, `yieldAnomalies`, `liquidityShifts`, and `crossDayTrends`. All are populated only when their source data exists.

The digest intelligence pass runs after editorial candidates are built and before the LLM prompt is assembled. It adds:

- `riskTape`: compact reader-facing state for PSI, active depegs, Bank Run Gauge, DEWS, and the largest supply mover.
- `changeSummary`: deterministic "what changed since yesterday" buckets (`newSignals`, `worsenedSignals`, `improvedSignals`, `resolvedSignals`, `repeatedSignals`) derived from the previous archived input.
- `forwardLookOutcomes`: evaluation of yesterday's `nextTriggers` against today's input (`hit`, `missed`, `pending`).
- `nextTriggers`: structured threshold checks the next digest can evaluate — depeg bps, supply velocity, DEWS band, Bank Run Gauge, PSI, yield-anomaly cooling (`yield-apy`), and DEX liquidity follow-through (`liquidity-score`). Triggers have a lifecycle: an armed threshold is **sticky** (never re-derived toward the metric's drift — the PSI goalpost once moved 89→93 chasing the index), a trigger that fires re-arms fresh, and a trigger pending for 3 consecutive editions **expires** (recorded as an `expired` forward-look outcome) and cedes its slot. Depeg thresholds arm off the live deviation, not the stored peak.
- `calmNarrativeFrame`: a fallback editorial frame for calm regimes so quiet days can explain what changed, what did not happen, and what would make the next day less calm.
- `editorialAudit`: added after the LLM response is parsed; stores top/usable/suppressed/momentum candidate ids, required lead ids, declared `leadSignalId`, used candidate ids, and quality issue codes.

Digest safety reads resolve through `worker/src/lib/safety-score-active-source.ts` (bound into digest copy by `worker/src/lib/digest-safety-context.ts`). The loader accepts only the complete current canonical V9 publication. Held, invalid, stale, or unavailable V9 is explicit and never triggers V8 computation or fallback.

The digest's Flight-to-Quality collector uses `buildFlightToQualityClassificationFromV9Snapshot()` from `worker/src/lib/flight-to-quality-classification.ts` via `worker/src/cron/daily-digest/mint-burn-ftq.ts`, aligned with the public `/api/mint-burn-flows` classification path.

**Bank Run Gauge — one producer, one universe.** The gauge is computed exactly once, by `refreshAggregateMintBurnFlowCache()` (`worker/src/api/mint-burn-flows.ts`), over the active tracked-pair universe with tracked-chain mcap weighting. The digest reads that publication through `worker/src/lib/mint-burn-published-gauge.ts` and re-bins it (gauge score, band, per-coin pressure, per-chain net flow, and the net flows the FTQ split runs on); it no longer queries `mint_burn_hourly`. Fail-closed behavior: a publication that is unparseable or older than 24 h is dropped and marks the run degraded (`mint-burn-gauge-malformed` / `mint-burn-gauge-expired`); a publication older than 2 h (≈6 missed producer runs) is still used but marks `mint-burn-gauge-stale`; a gauge that has never been published is silently omitted, matching the pre-existing "no flow rows yet" behavior.

### DEX liquidity admission gate

Edition #179 (2026-08-21) published "USDS bled 91% of its DEX liquidity to $13.72M in a day" to X and Telegram. Nothing had drained. A partial upstream pool inventory — DefiLlama's `/protocols` index is accepted whenever it is non-empty and then used as a project whitelist, and partial direct-API pages are recorded only as `fallbackSignals` — dropped most of one coin's pools. The producer's abort guards are aggregate (global TVL, top-10 TVL, row coverage), so a single coin's hole passed every one. The digest then compared two `dex_liquidity_history` rows on score delta and market cap alone.

DEX liquidity is a **single-source signal**: score, TVL, pool count, and the DEWS liquidity input all descend from the same ingestion. When that ingestion is partial, every number agrees with every other number and the artifact reads as a coherent story. Four layers now stand in the way, each of which independently withholds the #179 claim.

**1. Producer visibility.** `computeDexLiquidityDriftSummary()` (`worker/src/cron/dex-liquidity/orchestrator-drift.ts`) flags `major-tvl-cliff:<id>` at `qualityDriftSeverity: "high"` for any coin that was among the previous run's ten largest by TVL, held at least $5M, and landed below 60% of that value. Same ratio as `hardValueGuard`, applied per coin instead of in aggregate. The run still publishes — the primary dataset must record real crises — but the cliff reaches cron metadata, the status page drift line, and the `199` warning header on `/api/dex-liquidity`.

**2. Collector admission — comparability only.** `admitLiquidityShift()` (`shared/lib/digest-liquidity-admission.ts`) decides whether a history pair is a comparable measurement of the same thing on two adjacent days. Every rule is decidable from the pair itself:

| Rejection | Rule |
|---|---|
| `non-adjacent-snapshots` | The rows are not exactly 86,400s apart |
| `methodology-basis-change` | `methodology_version` differs across the pair — a recompute, not a market move. Liquidity v6.0 moved USDS 58 → 46 with no on-chain change |
| `non-trendworthy-coverage` | Either row fails `isTrendworthyLiquiditySnapshot()` (fallback class or confidence <0.75), or carries a non-finite measurement |

A rejected pair produces **no signal at all**, recorded as `liquidity-shift-<rejection>` in `degradedSources` so a withheld story is distinguishable from a quiet day. Admitted shifts carry `coverageClass`, `coverageConfidence`, `tvlChangePct`, and `expectedScoreDeltaFromTvl`.

Magnitude is deliberately **not** an admission rule. A large drop is either a partial snapshot or a genuine crisis, and nothing in the pair distinguishes them; the collector has no access to prices, flows, or supply. Rejecting on magnitude here would discard real drains unread — exactly the events Pharos exists to report.

**3. Editorial corroboration.** A liquidity candidate is suppressed unless an **independent pipeline** agrees on the same coin: an active depeg (prices), mint/burn pressure (transfer flows), or supply evidence (a supply-velocity signal, or being the week's largest supply mover). DEWS is deliberately excluded — its liquidity signal reads the same `dex_liquidity` rows, so a band move can be the artifact agreeing with itself. Market cap sizes a story and never corroborates one; the system prompt said otherwise until this change.

This is where magnitude is judged, because this layer can see the corroborating evidence. An uncorroborated drop past `UNCORROBORATED_TVL_DROP_RATIO` (40%, the producer's own aggregate "this cannot be real" bound, above v6.0's documented 2-35% recompute range) is suppressed as an `unverified single-source DEX TVL collapse` at `artifactRisk: "high"`, and the prompt's raw evidence line is marked `UNVERIFIED` so the model may not state its TVL figures as fact anywhere — lead or body. A **corroborated** collapse of the same size is not suppressed: a real drain alongside a depeg or a supply exodus is the story.

Liquidity impact is scored per $1B of market cap, matching `getDepegMarketImpactScore`; the previous per-$1M divisor put liquidity on a 1000x inflated scale against every depeg, which is how an 8-point move on a mega-cap outranked real peg breaks. DEWS band moves and ALERT+ breadth moved to the same basis for the same reason — DEWS's liquidity input reads the same `dex_liquidity` rows, so a partial pool snapshot could have bought the headline through DEWS instead, and its impact carried no severity term at all (a mega-cap merely *being* ALERT+ scored ~6,710). Artifact risk now outranks impact at any gap for `liquidity` and `yield` candidates, not only within 25 points.

**4. Publication gate.** `validateDigestModelOutput()` raises a hard `suppressed-lead` issue when the declared `meta.leadSignalId` resolves to a suppressed candidate. Suppression used to be advisory: the prompt asked the model not to lead with one and nothing checked. A hard issue takes the existing path — one corrective retry, then `qualityGate = "blocked"`, no X post and no Telegram edition.

What was deliberately **not** built: no coverage-weighted rescoring (coverage never fed the score, and damping it would hide genuinely thin coins); no rule that the composite must move proportionally with TVL (TVL Depth is `35 * log10(depthRatio / 0.0007)` at 30% weight, so a 91% TVL drop implies only about -11 points **by design** — #179's "score fell only ten points" was a correct number framed as a scandal, and the prompt now carries the implied move as `tvl-implies` so coverage cannot repeat that reading); no per-coin publication hold in the producer, because withholding a real crisis from the primary dataset is worse than reporting it and refusing to headline it; and no magnitude cap anywhere that a corroborated event cannot pass, because every gate here must fail toward *not publishing an unverified claim*, never toward *not seeing a real one*.

### LLM call

- **Model:** `claude-opus-4-8` (swapped from Opus 4.7 on 2026-07-18; identical price and API contract, watch the first ~5-7 editions for voice drift) via `https://api.anthropic.com/v1/messages`, with adaptive thinking (`thinking.type = "adaptive"`) and `xhigh` reasoning effort (`output_config.effort = "xhigh"`)
- **Reasoning:** adaptive thinking is on by default with omitted display; no `budget_tokens` is needed (and is rejected on Opus 4.7+). Sampling parameters (`temperature` / `top_p` / `top_k`) are not sent (also rejected). `xhigh` is Opus's recommended level for complex editorial work; `max` was dropped on 2026-04-18 after a second runaway-thinking failure (`stopReason=max_tokens, outputTokens=32000`, only a `signature_delta` emitted) — `max` has no constraint on thinking depth.
- **Timeout:** 12-minute Anthropic outer timeout with an 11-minute per-attempt fetch timeout. The daily digest cron wrapper allows 14 minutes total, which stays below Cloudflare's 15-minute scheduled-trigger wall-clock ceiling while leaving tail room for persistence, logging, and channel delivery.
- **Streaming:** Requests set `Accept: text/event-stream` and `stream: true`. This is part of the Worker runtime contract because Opus adaptive thinking can take minutes before emitting text; streaming keeps the subrequest active with early headers / ping events during long thinking phases.
- **Max tokens:** 64000 daily, 64000 weekly (max_tokens covers thinking + output). Anthropic's documented floor for Opus at xhigh/max effort. Earlier bumps to 16k → 32k at `effort: "max"` both hit `stop_reason=max_tokens` with no text emitted; the root-cause fix on 2026-04-18 was lowering effort to `xhigh` and raising the ceiling per Anthropic's guidance in one change.
- **Overload retries:** Anthropic `529 Overloaded` responses retry at most 2 times (3 attempts total), bounded by the 12-minute outer timeout
- **Voice:** sardonic financial columnist — dry, precise, no emojis, no exclamation marks, with a compact few-shot EXEMPLAR embedded in the system prompt to anchor voice and structure
- **Priority rule:** lead from the highest-impact unsuppressed editorial candidate. Raw evidence sections are supporting material, not the lead-selection source.
- **Critical depeg override (novelty-gated with a lead quota):** active depegs at or above 2,500 bps on at least $50M mcap, or 5,000 bps on at least $10M mcap — measured on the **live deviation** — bypass stale/chronic suppression. The top eligible critical is ranked by impact score (not raw bps) and produces a **hard** lead-validation requirement only when it is newly critical (event ≤48h old) or worsened ≥500 bps since the previous edition. One event may hard-lead at most 2 consecutive editions and 3 per trailing 7 (`shared/lib/digest-lead-policy.ts`, owner-ratified constants); past quota, and for older unchanged criticals, the requirement demotes to a **soft mention-only** rule (the symbol must appear, the lead is free). A material worsening re-qualifies the story regardless of quota. The prompt receives an explicit `REQUIRED LEAD TODAY` or `REQUIRED MENTION` line plus an `ONGOING STORIES` lead-streak ledger, and `editorialAudit` records `leadRequirementReasons` and `demotedLeadMentionTokens`. If Opus ignores a hard requirement, the quality gate retries and then blocks external delivery if unresolved.
- **Momentum candidates:** a separate in-prompt block surfaces candidates with `novelty ∈ {new, accelerating, reversal}` so the model has explicit forward-watch material upstream of the regex-based forward-look validator.
- **Deterministic next triggers:** the prompt receives `nextTriggers` with concrete thresholds. The model should use one for the required forward-look line instead of writing vague "watch this" closers.
- **Change/outcome context:** the prompt receives `changeSummary` plus `forwardLookOutcomes`, allowing the digest to say what changed since yesterday and whether prior forward-look checks hit, missed, or remain pending.
- **Opening rule:** the first sentence of the extended field must surface a fact from the lead candidate (coin/number), not a templated PSI verb. Opening-fingerprint validator raises a soft issue on PSI-verb openings that repeat within the last 3 digests.
- **Forward-look mandate:** every digest must contain at least one anticipatory line (if/when/next-trigger/watch-for); a soft validator rejects retrospective-only digests.
- **Calm-day storytelling:** in CALM regimes without a critical lead, the prompt uses `calmNarrativeFrame` to frame documented quiet, supply rotation, issuer concentration, liquidity divergence, chronic risk boundaries, or explicit non-events without manufacturing menace.
- **Spice budget:** the prompt allows one sharp sentence per digest (named analogy, historical parallel, concrete-stakes observation, or ironic contrast); over-reach is discouraged by the forbidden-tic list.
- **Artifact policy:** candidates can be marked high-risk or suppressed for chronic small depegs, zero-value blacklist bursts, thin-liquidity artifacts, very high APY anomalies, or other weak evidence. The prompt explicitly tells Opus not to dramatize these.
- **Regime classification:** a `classifyRegime()` function labels each day as CRISIS, TENSION, WATCHFUL, or CALM based on PSI band, impact-weighted active depeg pressure, gauge score, FTQ status, and ALERT+ mcap rather than raw coin counts alone. Depegs older than 7 days contribute to regime pressure only when they worsened since the previous edition, so chronic standing conditions cannot pin the register at TENSION indefinitely (which had made the calm-day machinery unreachable).
- **Narrative structure:** regime-aware P1/P2/P3 paragraph structure; PSI is always referenced but doesn't have to open; default 3 paragraphs, 4 only when a distinct secondary story cannot fold into 1-3
- **Density contract:** 40–70 words per paragraph, 150–280 words total for the extended field
- **Structured sections:** When the digest covers two distinct stories, the LLM may use bold inline headers (e.g., `**Peg Watch**`, `**Capital Flows**`) to separate paragraphs. P1 (the lead) never has a header. The frontend renders these as styled inline spans.
- **Variety enforcement:** normalized structured `meta` field (lead signal id, lead type, tone, featured coins, used/suppressed candidate ids) from recent non-weekly digests replaces raw text dump; falls back to raw text for pre-meta entries. A coarse `leadFamily` mapper (psi, depeg, dews, flow, risk, macro) drives `repeated-lead-family` so variety enforcement survives the 28-token allowed-leads enum.
- **Voice guards:** a forbidden-tic list (21 anywhere-patterns plus closer-position bans on "worth watching / monitoring / bears watching"; the enforced source of truth is `FORBIDDEN_TICS_ANYWHERE` / `FORBIDDEN_TICS_CLOSER` in `worker/src/cron/daily-digest/voice-guards.ts`) fires a soft issue when hit. Opening-pattern fingerprint flags repeated "PSI [verb]" openings. Forward-look cue detector flags retrospective-only digests. Tone-cluster detector flags a register appearing 3+ times in the last 5 digests.
- **Quality gate:** parsed LLM output is validated for required fields, paragraph/word budget, title+text length, code fences, forbidden tics, opening-pattern repetition, missing forward-look, repeated lead-family, tone-cluster, and recent title/tone/coin repetition. Editorial-consistency lints (all soft): `price-bps-mismatch` (a sentence quoting a coin's dollar price and a bps figure must have the two agree within 150 bps against the coin's live facts), `unverifiable-movement-claim` ("narrowed/widened from N bps" must trace to a previous-edition depeg fact), `title-symbol-streak` (same coin in three consecutive titles), `title-day-counting` (day/hour-count titles on repeat coverage), and title dedupe against a 30-edition trailing window. Sub-$50M depegs are suppressed as lead material after 48h (break-day-only coverage, owner-ratified floor). The worker retries once with validation errors before accepting the copy. If hard issues remain after retry, the digest is stored as degraded and social posting is skipped. Soft-only residual issues stay in cron metadata but do not mark the operational cron lane degraded.
- **Output:** raw JSON `{ "title": "...", "extended": "...", "text": "...", "meta": { "lead": "...", "tone": "...", "coins": [...] } }` — no markdown fences

### Failure handling

If quality validation fails with **hard** issues, the worker sends one corrective retry to Opus containing the hard checks plus the failed response itself, so the model fixes the flagged problems instead of regenerating blind. Soft-only issues never trigger a retry (during the July 2026 forced-lead streak, unfixable soft variety issues burned a second full Opus call every day). A `stop_reason=max_tokens` stream is treated as a hard failure before parsing — truncated output can no longer flow into the raw-text fallback.

If the retry still has hard quality issues, the digest row is stored with `digest_meta.qualityGate = "blocked"` for operator inspection: blocked rows are excluded from every public read endpoint, from edition numbering, from recent-copy variety context, and from lead-streak history (they never reached readers), and external delivery is skipped as `quality-gate`. Soft-only quality issues remain visible in run metadata without changing cron health. Forbidden throat-clearing phrases are now flagged as a soft `forbidden-phrase` issue rather than silently stripped (which left grammar fragments), and `meta.coins` labels are cross-checked against the copy (`meta-coins-mismatch`).

`suppressed-lead` is a hard issue: a declared `meta.leadSignalId` that resolves to a suppressed editorial candidate fails validation instead of publishing. Suppression previously lived only in prompt instructions, which is how edition #179's suppression-eligible USDS liquidity claim reached X and Telegram. See [DEX liquidity admission gate](#dex-liquidity-admission-gate).

The active-depeg collector also computes **lifecycle review flags** over the full open-event set (`worker/src/lib/depeg-lifecycle.ts`): `stalled-collapse` (open ≥21d at ≥2,500 bps live deviation) and `chronic-shallow` (open ≥30d under 300 bps). Flags are persisted to the `depeg:lifecycle-flags` cache entry and appended to cron metadata as `lifecycle-review: SYMBOL:kind|…` for owner review — see [`runbooks/depeg-lifecycle-review.md`](./runbooks/depeg-lifecycle-review.md). Flagging never freezes or closes anything automatically.

Digest generation now fails closed on stablecoins-cache availability: if the cached stablecoin payload is missing, malformed, or otherwise non-`ok`, the cron returns `status: "degraded"` and skips regeneration instead of synthesizing a false zero-mcap digest.

Safety-score enrichment also uses explicit degraded semantics. When the expected active publication is unavailable or mismatched, the digest still renders from the remaining inputs, but the safety section and grade movers are omitted and `safetyContext` records the expected model and reason. Healthy output carries the full model, schema, methodology/policy, evaluation-build, base-input, and publication-generation identity. The shared hard validator rejects Safety Score, report-card, grade/rating, V9-pillar, or binding-cap claims when an identified publication is unavailable, so the standard corrective retry can remove that topic; the final post-generation gate repeats the check as defense in depth. A degraded edition is deliverable only when its copy is safety-free.

All collectors now distinguish "no signal" from "collector failed". If the active-depeg, blacklist-activity, supply-velocity, resolved-depeg, mint-burn, liquidity-shift, PSI-contributor, total-mcap-ATH, historical-context, cross-day-trend, DEWS-stress, grade-transition, or yield-anomaly queries error, `generateDailyDigest()` still stores the digest but:

- returns cron `status: "degraded"`
- appends the collector key to the cron metadata string
- stores the collector keys in `input_data.degradedSources`

Staleness is also degradation, not silent currency: a PSI sample older than 2h (`psi-sample-stale`), a PSI-contributor snapshot older than 2h (`psi-contributors-stale`, dropped rather than displayed), a stablecoins cache outside the 600-second public freshness budget (`stablecoins-cache-stale`, with cached prices withheld from live depeg severity), and yield rows older than 24h (filtered out in SQL) are all treated as degraded or excluded rather than presented as current observations.

Change detection and trigger matching key depegs by `stablecoinId` (falling back to symbol only for archived rows without ids), so two tracked coins sharing a symbol can no longer produce fabricated cross-coin movement in `changeSummary` or forward-look outcomes. Depeg candidate `novelty` is computed from the day-over-day live-deviation delta (`new` ≤24h, `worsening`/`improving` at ±100 bps, `chronic` when old and unchanged) instead of labeling every unsuppressed depeg "worsening".

---

## Storage

**Table:** `daily_digest`

```sql
CREATE TABLE daily_digest (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,   -- Unix seconds
  digest_text  TEXT    NOT NULL,   -- tweet-sized text
  digest_title TEXT,               -- headline
  digest_extended TEXT,            -- longer editorial
  digest_meta    TEXT,             -- editorial metadata (lead, tone, coins) for variety enforcement
  input_data   TEXT    NOT NULL    -- full DigestInputData JSON for reconstruction
);

CREATE INDEX idx_daily_digest_generated_at ON daily_digest(generated_at);
```

The full `input_data` JSON is stored verbatim so detail pages can reconstruct the contextual snapshot for any historical date without re-fetching live data. It includes the deterministic intelligence fields listed above and the authored `safetyContext` when generated by the current pipeline. When one of the early collectors fails, `input_data.degradedSources` records the failed collector keys (`active-depegs-query`, `blacklist-activity-query`, `supply-velocity-query`, etc.).

The `digest_meta` column stores structured metadata about editorial choices (lead signal, tone, featured coins) for variety enforcement across consecutive digests. Older rows with `NULL` `digest_meta` fall back to raw text comparison.

Retention policy: `daily_digest` is a product archive kept forever. The public archive/detail pages, static digest sync, recent-copy context, cross-day trends, and the total-mcap ATH collector all read historical rows. Do not add age-based pruning unless ATH and archive dependencies are materialized first or an explicit public-output change is accepted.

`telegram_digest_outbox` is the delivery ledger, not the editorial archive. Successfully sent rows are retained for 90 days and pruned in bounded batches by the five-minute drain. `execution_unknown` and `failed_permanent` rows remain until operator reconciliation so uncertainty is not erased by retention cleanup.

---

## API Endpoints

Read endpoints are public, but they do not all share the same cache profile: `GET /api/daily-digest` and `GET /api/digest-archive` use the standard 5-minute edge profile, while `GET /api/digest-snapshot` is treated as archive data and uses `s-maxage=86400, max-age=3600`. The manual trigger endpoint is admin-only. See [API Reference](./api-reference.md) for the full response shapes.

| Endpoint | Description |
|----------|-------------|
| `GET /api/daily-digest` | Latest digest only, with compact `riskSignal`, `riskTape`, change/outcome summaries, and structured next triggers when stored input data has them |
| `GET /api/digest-archive` | All digests, newest first (up to 365), including compact PSI/mcap/risk summaries plus stored `riskTape`, `nextTriggers`, and forward-look outcomes parsed from input data |
| `GET /api/digest-snapshot?date=YYYY-MM-DD` | Input data + depeg/blacklist context for a daily digest date — used by SSG detail pages; cached as archive data (`s-maxage=86400, max-age=3600`) |
| `GET /api/digest-snapshot?date=YYYY-MM-DD-weekly` | Input data for a weekly recap slug; the handler strips `-weekly` for date parsing and returns the weekly snapshot when that digest row exists |
| `POST /api/trigger-digest` *(admin)* | **Deferred**: writes a bounded pending intent (`requestId`, timestamps, attempt count, retry state, and last error) into the D1 `cache` table and returns 202. A dedicated `*/5 * * * *` polling cron (`digestTriggerPoll`) runs the digest under scheduled-event wall-clock (up to 15 min), retries transient failures with bounded backoff, retains exhausted/permanent failures as dead letters, and persists outcome to `digest:last-trigger-result`. Expected latency: ≤ 5 min. Requires Access service-token headers on `ops-api.pharos.watch`. See [`worker-and-api-limits.md`](./worker-and-api-limits.md#manual-trigger-runtime-model) for the rationale. |

An idle `digestTriggerPoll` with no pending force-run intent is a neutral conditional poll, not an omitted daily-digest execution. Stale-slot reconciliation therefore creates no synthetic `daily-digest` failure when no durable child progress exists. If a forced digest did start and left durable progress before losing ownership, the sweeper still records the real abandoned attempt using its original progress timestamps.

---

## Distribution

After the digest is stored in D1, it is posted to configured Twitter/X and Telegram channels. Delivery never removes the D1 digest record. Before either channel send, the worker reads `/safety-scores/map.json` and HEAD-probes today's dated PNG. A same-day manifest with data under 24 hours old enables the attachment; every unavailable or stale state omits it and records degraded ops telemetry without blocking the digest. The manifest's optional `mapSummary` enables deterministic channel prose only when its complete typed shape is valid and the digest has an available canonical Safety Score context. An absent, partial, malformed, or capture-mismatched summary still permits the image attachment but emits no map prose. Twitter/X persists a same-day delivery ledger in the D1 `cache` table; Telegram first persists the exact rendered edition in `telegram_digest_outbox`, then sends only that stored payload.

### Web archive and sitemap policy

`/digest/` remains the primary indexable archive hub and links to every generated daily or weekly detail page present in `data/digests.json`. Individual digest detail pages stay indexable and sitemap-listed because they are durable archive/citation pages with unique editorial text and point-in-time snapshots. Crawl and URL Inspection quota should be managed through post-deploy GSC prioritization, not by dropping older daily digests from `src/app/sitemap.ts`.

### Twitter

**File:** `worker/src/lib/twitter.ts`

- Auth: **OAuth 1.0a** signed with `crypto.subtle.HMAC-SHA1` (no third-party library)
- Format: `{title} (#N)\n\n{text}` — an edition-number suffix `(#N)` is appended to the title (N = running count of non-weekly digests, present on every post); a `$` cashtag prefix auto-injected on the single earliest tracked-ticker mention in the text (only one cashtag per tweet; Twitter rejects multiple); truncated to 270 chars if needed. When map media upload succeeds with a valid summary and Safety Score context, the full computed hook `Of {total} USD in mapped supply, A tier’s {count} coins hold {share}%; C/D/F’s {count} hold {share}%. Find yours on today’s map.` is reserved inside that budget, and the digest text is word-boundary truncated first.
- Endpoints: `POST https://upload.twitter.com/1.1/media/upload.json` for the PNG, then `POST https://api.twitter.com/2/tweets` with its media id

**Required secrets:**

| Variable | Description |
|----------|-------------|
| `TWITTER_API_KEY` | OAuth consumer key |
| `TWITTER_API_SECRET` | OAuth consumer secret |
| `TWITTER_ACCESS_TOKEN` | OAuth access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | OAuth access token secret |

If any of the four are absent, Twitter posting is skipped silently. Twitter/X delivery is replay-safe per UTC date: `daily-digest.ts` atomically advances `daily-digest:twitter-sent:YYYY-MM-DD` through `queued` → `sending` → `sent`, `execution_unknown`, or `failed`. Success records the tweet id. A clear Twitter 4xx rejection enters `failed` and may retry up to three total attempts; timeout, network, ambiguous 5xx, lost sending ownership, or accepted-post persistence ambiguity enters or is treated as `execution_unknown`, retains the ledger marker, disables automatic retry, and emits a structured warning with the manual reconciliation step. Legacy markers and terminal `sent` rows remain duplicate-safe. If the ledger claim fails, Twitter/X delivery is not attempted, avoiding duplicate force-run posts during cache/D1 contention. A map download or media-upload failure is handled before tweet creation and falls back to the text-only post; the map can never turn a publishable digest into a failed Twitter delivery.

### Telegram

**Files:** `worker/src/lib/telegram.ts`, `worker/src/lib/telegram-digest-outbox.ts`

- Auth: bot token embedded in the request URL (no OAuth)
- Parse mode: **HTML** — title is wrapped in `<b>`, link uses `<a href>`
- Format (the `Pharos Daily Digest #N` kicker is prepended whenever an edition number is present, which is the normal case):
  ```
  Pharos Daily Digest #N
  <b>{title}</b>

  {extended}

  <b>Today’s map</b>
  Mapped supply: ${total} across {gradedCount} coins
  A tier: {count} coins · {share}%
  C/D/F tiers: {count} coins · {share}%

  <a href="https://pharos.watch/safety-scores/map.png?date=YYYY-MM-DD">View today’s map →</a>

  <a href="https://pharos.watch/digest/YYYY-MM-DD/">Read on Pharos →</a>
  ```
- Endpoint: `POST https://api.telegram.org/bot{token}/sendMessage`

The `extended` field is used instead of `text`. The four-line map block shown above is present only when the optional map summary and canonical Safety Score context are both available; every count, supply total, and share is computed from the summary's tier market caps. When today's map passes the readiness contract, the canonical dated URL and any map block are persisted together in the rendered HTML at enqueue time, and the matching chunk is sent with `link_preview_options` selecting a large preview above the text. The final rendered HTML is split on safe structural boundaries below the 4096-character Bot API ceiling. Every chunk is persisted before the first external request, including unusually large appendix editions.

Before the Telegram channel post is sent, `worker/src/cron/daily-digest.ts` also asks `worker/src/lib/telegram-digest-appendices.ts` for any pending deploy-diff notices. When present, those notices are appended beneath the digest body:

- `New Cemetery Entries` for newly added cemetery rows
- `Tracking Changes` for newly tracked coins, split into live tracked vs pre-launch

Active tracked additions are queued earlier by `worker/src/cron/sync-stablecoins.ts`, which diffs the just-built stablecoins payload against the previous `stablecoins` cache before the cache row is overwritten. That queue is then consumed by the next successful Telegram digest post, so tracked additions are not lost when the digest appendix snapshot key is missing or has to be reseeded.

Appendix snapshot writes are stored with the immutable edition and committed atomically with its `sent` transition after every chunk is accepted. A failed or partial channel delivery therefore does not lose pending additions.

Telegram delivery is keyed by immutable daily or weekly edition. The outbox stores the target chat, exact ordered chunk array, authored safety context, accepted-chunk cursor, and owner/generation-fenced state. An edition containing safety content is sent only while its complete Safety Score publication identity remains current; another model, policy, build, base input, or generation terminalizes it before a Bot API effect. A safety-free digest authored during an explicit degraded state remains deliverable; enqueue and delivery both reject persisted Safety Score or grade claims paired with an unavailable context. Confirmed retryable HTTP responses return the edition to `pending` with bounded exponential or Telegram `retry_after` backoff. A timeout/network failure, expired `sending` owner, or persistence failure after acceptance becomes `execution_unknown` and is never replayed automatically. Confirmed permanent rejection becomes `failed_permanent`. The five-minute digest-trigger slot drains due `pending` editions without rerunning Anthropic or re-rendering copy; operator reconciliation for terminal states is documented in [`runbooks/telegram-digest-outbox.md`](./runbooks/telegram-digest-outbox.md).

A same-day forced regeneration can render different copy after that immutable Telegram edition is already `sent`. The enqueue result reports the payload mismatch for auditability, but the digest cron treats the already-sent state as an idempotent skip instead of a delivery warning because no pending payload can be replaced and no resend is allowed. A mismatch while the edition is still pending remains degraded and operator-visible.

**Required secrets:**

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Channel username (e.g. `@pharoswatch`) or numeric channel ID |

If either is absent, Telegram posting is skipped silently.

**Channel setup (one-time):**

1. Create a bot via @BotFather → `/newbot` → copy token
2. Create the public channel
3. Add the bot as Admin with "Post Messages" permission only
4. Add secrets from the worker directory: `cd worker && npx --no-install wrangler secret put TELEGRAM_BOT_TOKEN` and `cd worker && npx --no-install wrangler secret put TELEGRAM_CHAT_ID`

`telegram.ts` also exports `sendToChat()` for the Telegram webhook command handler, but digest generation still uses the same HTML `sendMessage` API path and credentials.

### Distribution status logging

Daily and weekly channel outcomes are returned in scheduled-run cron metadata. `POST /api/trigger-digest` does not run delivery inline anymore; it enqueues a retryable force-run intent and returns `202` with `{ ok, accepted, requestId, message }`, then the 5-minute digest-trigger poll writes each eventual result to cron history and the `digest:last-trigger-result` cache entry. Transient failures remain pending with bounded backoff for up to three attempts; permanent or exhausted failures remain as a retained `dead_letter` intent, while a successful run clears the intent.

```json
{ "metadata": "243 chars, tweet: ok, telegram: ok" }
```

Possible channel values include `"no-creds"`, `"ok"`, `"failed: <truncated error>"`, `"queued: <state>"`, `"skipped: circuit-open"`, `"skipped: quality-gate"`, `"skipped: already-sent"`, and successful appendixed delivery strings such as `ok+appendix(...)`. Outbox retry and terminal backlog counts are separately exposed under the budget-only `telegram-digest-outbox-drain` status surface.

---

## Weekly Recap

**File:** `worker/src/cron/weekly-recap.ts`
**Schedule:** Mondays only in the `daily-0810` slot (`"10 8 * * *"`)
**Dedup guard:** returns `skipped_neutral` outside Monday UTC or when a recent weekly row is already delivered; retries a recent row with `digest_meta.telegramDelivered = false` only while its delivery status is non-terminal. Quality-gate, `execution_unknown`, and `failed_permanent` rows require review rather than automatic weekly reruns.
**Period semantics:** trailing daily editions available at the Monday 08:10 UTC start, not a strict Monday-Sunday calendar week. `digest_meta.periodType` is `"trailing-daily-editions"`.

### Data collection

Fetches the last 15 daily digests (`LIMIT 15`, cutoff `now - 15d`, excluding weekly entries via `json_extract(digest_meta, '$.type') != 'weekly'`), splits them at a UTC-day boundary (`todayTs - 6d`, last Tuesday 00:00 UTC for the Monday run), and aggregates both summary ranges and weekly signal leaderboards for the current week plus basic aggregates for the prior week. Structured safety fields and raw daily title/summary copy are retained only when their authored model, schema, methodology, policy, and evaluator build are comparable with the active weekly source; incompatible or unbound raw copy is withheld from the prompt.

| Metric | Derivation |
|--------|-----------|
| PSI range | Min, max, start, end scores + dominant band (most frequent) |
| Market cap range | Start, end, net change, percentage change |
| Active depeg observations | Sum of `activeDepegCount` across all days; explicitly not described as unique events |
| Unique depeg signals | Reconstructed from `stablecoinId` + `startedAt` where present, with symbol/direction/bps fallback for legacy rows |
| Top depeg signals | Active and resolved signals sorted by absolute market impact |
| Weekly risk leaderboard | Unified cross-signal ranking across depegs, DEWS, mint/burn pressure, blacklist, grade, yield, liquidity, and supply contraction. Depeg severity uses the live deviation when the daily rows carry it. Signals whose event predates the week window are flagged `carriedOver`, get halved severity, render under a **STANDING CONDITIONS** split (one line each, never the headline), and cannot hard-pin the weekly lead — only unsuppressed criticals that are **new this week** outrank everything else |
| Spike metrics | Worst PSI day, lowest Bank Run Gauge day, worst depeg by bps, and largest depeg market impact |
| Supply signals | Biggest weekly movers and daily velocity reversals/acceleration/deceleration |
| DEWS signals | Top band changes and max ALERT+ mcap |
| Blacklist total | Sum of `blacklistActivity.eventCount` and `totalAmountUsd`; top events by value |
| Grade transitions | Deduplicated V2 organic transitions comparable with the active model/policy/build; boundary and cross-identity rows are excluded |
| Gauge range | Min/max `mintBurnFlows.gaugeScore` (null if <3 data points) |
| Other anomalies | Top mint/burn pressure, yield anomalies, and liquidity shifts |
| Forward-look scoreboard | sum of daily `forwardLookOutcomes` statuses | `{hit, missed, pending, expired}` across the week's editions; the prompt instructs the recap to publish the score and own the misses |
| Week-over-week deltas | prior 7 daily rows (same aggregation shape) produce `{ current, prior }` values for mcap end, PSI midpoint, PSI dominant band, active-depeg observations, unique depeg signals, blacklist events/USD, grade transitions, gauge midpoint; `null` when prior-week coverage is below 5 daily rows |

Requires >=5 current-week daily digests to proceed. Prior-week coverage below 5 is tolerated; `weekOverWeekDeltas` is then `null` and the prompt notes the gap instead.

### LLM call

- **Model:** `claude-opus-4-8` with adaptive thinking + `xhigh` effort (identical contract to the daily digest)
- **Timeout:** shared 12-minute Anthropic request cap; the scheduled weekly wrapper also has a 12-minute cron lease, so the lease can abort slow Monday recap runs
- **max_tokens:** 64000
- **Voice:** Same sardonic columnist, but synthesizing rather than reporting; rewritten system prompt adds arc framing, forward-look mandate on the last paragraph, tic list, and explicit week-over-week references
- **Structure:** 4-6 paragraphs, 250-400 words: top unsuppressed Weekly Risk Leaderboard item as the week's headline, dominant story, counter-narrative, supply/capital flows, optional structural observation
- **Artifact policy:** Same suppression principle as daily. Weekly recaps separate repeated active observations from unique signals so chronic conditions are not counted as fresh events.
- **Critical lead validation:** if the weekly risk leaderboard's top unsuppressed item is a critical depeg, its `id` is passed as a hard `leadSignalId` requirement.
- **Variety:** Recent weekly recap metadata is supplied to avoid repeating the same weekly frame. Meta is normalized on the same contract as daily (allowed leads + tones); `repeated-lead-family` applies to weekly output too.

### Storage

Stored in the same `daily_digest` table. The `digest_meta` column includes `"type": "weekly"`, `"periodType": "trailing-daily-editions"`, `weekStart` and `weekEnd` date strings, the authored safety context, and Telegram delivery fields (`telegramDelivered`, `telegramDeliveryStatus`, `telegramDeliveryUpdatedAt`, and `telegramDeliveredAt` after success). The `input_data` column stores the `WeeklyInputData` aggregation (not raw `DigestInputData`) with the exact active safety identity or an explicit unavailable state.

### Distribution

Posted to Telegram only (no Twitter for weekly recaps). Title is prefixed with "Weekly Recap:" and the link uses the weekly route slug `/digest/YYYY-MM-DD-weekly/`. The exact rendered weekly edition uses the same durable outbox as daily distribution. Confirmed retryable failures are polled every five minutes without another LLM call; ambiguous or permanent outcomes stop for operator reconciliation. The compatibility fields in `daily_digest.digest_meta` are updated after outbox success.

---

## Frontend

### Broadsheet (shared component)

**Component:** `src/components/daily-digest.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDailyDigest`) → `GET /api/daily-digest`
**Cache:** `staleTime: 86400s`, `refetchInterval: 172800s`

The latest digest is presented in a broadsheet newspaper style:
- **Masthead:** compact uppercase lockup with the full date; the homepage preview uses a slightly sharper mono masthead treatment than the archive broadsheet
- **Headline:** the homepage preview uses `Newsreader` at a larger newspaper-style display scale, while the full `/digest/` broadsheet keeps the original serif headline treatment
- **Risk badge + tape:** when `/api/daily-digest` exposes an active depeg `riskSignal`, the API prioritizes critical depegs before market impact and deviation size, and the broadsheet renders the resulting compact depeg badge near the headline so a truncated first paragraph cannot hide the risk state. New rows also render the `riskTape` chips and a compact next-trigger line in preview mode.
- **Body:** Extended text paragraphs in italic Courier-style monospace (`EDITORIAL_BODY_STYLE`). On the homepage and `/digest/` archive preview, only the first editorial paragraph is shown as a teaser; the paragraph is preserved whole and never character-clamped mid-sentence. Digest detail pages show the full editorial body.
- **Homepage preview split:** desktop uses an asymmetric two-column layout with a hairline `Executive Summary` label and headline block on the left, then the lead paragraph plus CTA rail on the right

The `text` field remains the short distribution summary used for metadata and digest detail intros. The shared broadsheet renderer prefers `extended`, and falls back to `text` only if `extended` is unavailable.

Used in three visible modes: the homepage (title + first editorial paragraph + "Read today's full digest" link), the `/digest/` archive page (`variant="preview"` with first paragraph + "Continue reading" link plus a weekly teaser before the wire table), and digest detail pages (full broadsheet body).

### Archive page

**Route:** `/digest/`
**Page:** `src/app/digest/page.tsx` (static route in the Next.js export)
**Component:** `src/components/digest-archive-client.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDigestArchive`) → `GET /api/digest-archive`

The archive page has two zones:
1. **Broadsheet** — today's digest in full broadsheet layout (via `DailyDigest`)
2. **Wire table** — all historical digests in a dense, wire-service style list

The wire table shows each digest as a compact row: **date** (monospace, e.g. "27 FEB"), **title**, optional active-depeg **risk badge**, **PSI badge** (pill colored by condition band), and **total market cap**. A month picker dropdown filters the table by month. PSI, mcap, and risk data are served from the enriched archive API response (`psiScore`, `psiBand`, `totalMcapUsd`, `riskSignal` — parsed from the stored `input_data` JSON).

The archive route emits server-rendered digest links for crawlability plus `CollectionPage` / `ItemList` JSON-LD over the checked-in `data/digests.json` entries. The visible archive, daily lead story, and latest weekly recap render in the client archive component after `/api/digest-archive` loads; detail pages remain the canonical `Article` surfaces for individual digests.

### Detail pages

**Route:** `/digest/[date]/`
**Page:** `src/app/digest/[date]/page.tsx` (SSG)
**Static params:** generated from `data/digests.json` at build time
**Component:** `src/components/digest-snapshot.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDigestSnapshot`) → `GET /api/digest-snapshot?date={date}`

Daily detail pages use slugs like `/digest/2026-03-24/`. Weekly recap pages use `/digest/2026-03-24-weekly/`; the archive client builds those slugs from `digestType === "weekly"` and the snapshot API accepts the matching `?date=YYYY-MM-DD-weekly` query. The snapshot API filters target rows by requested type, so daily and weekly rows generated on the same UTC date cannot shadow each other.

Each detail page shows the short summary intro (`text`) followed by every extended editorial paragraph plus a deterministic intelligence panel and up to 10 data-dependent contextual cards (Market Snapshot, Stability Index, Supply Mover, Active Depegs, Blacklist Activity, Safety Scores, Yield Anomalies, DEX Liquidity Shifts, Supply Velocity, Resolved Depegs). The intelligence panel renders `riskTape`, yesterday's trigger outcomes, "what changed", and next triggers when present in stored `input_data`. The Active Depegs card uses `/api/digest-snapshot` depeg episodes active on that date, ordered by absolute deviation, with stored `input_data.topDepegs` only as fallback. If snapshot context fails or has no usable input data, the page renders a small unavailable-state card instead of silently dropping the section. Detail pages also render a small research-context link grid back to PSI, depeg, flow, and safety-score surfaces. Includes JSON-LD Article structured data and prev/next navigation.

---

## Static Generation Pipeline

**Script:** `scripts/maintenance/sync-digests.ts`
**Command:** `npm run sync:digests`

Fetches `GET /api/digest-archive` from an explicit API source, transforms it to the `data/digests.json` format (`date`, `digestType`, `editionNumber`, `title`, `text`, `extended`, `generatedAt`), and writes the file. Weekly entries use a `YYYY-MM-DD-weekly` date slug so they cannot shadow daily entries for the same UTC day. The script accepts `--api-url` or `DIGEST_API_URL`, optional `--output`, forwards `DIGEST_API_KEY` when set, and falls back to `SMOKE_API_BASE` / `API_BASE_URL` when those are already set. CI syncs add a one-off query parameter plus `Cache-Control: no-cache` request headers so the static build sees a digest row that was just written, without waiting for the public archive endpoint's 5-minute edge TTL.

For local/manual use, point it at the intended environment explicitly:

```bash
npx tsx scripts/maintenance/sync-digests.ts --api-url https://ops-api.example.com
```

The scheduled/manual Pages refresh runs digest sync inside `.github/workflows/pages-release.yml`:

1. When `refresh_data=true`, the `pages-release` job fetches `GET /api/digest-archive` once and writes normalized `data/digests.json` before `next build`. Code releases via `deploy-cloudflare.yml` now also pass `refresh_data: true`, so a merge no longer regresses digest detail pages, the sitemap, and the RSS feed to the committed snapshot's age until the next scheduled rebuild.
2. The refresh step is fail-open: if any sync command fails, or the refreshed digest archive has fewer entries than the committed snapshot (grow-only guard), the job restores the committed `data/digests.json`, `data/depeg-events.json`, and `public/datasets` and continues the build with a step-summary warning instead of failing the deploy.
3. The refresh calls `https://stablecoin-dashboard.pages.dev/_site-data`, whose Pages Function authenticates upstream requests to `site-api.pharos.watch`; it does not depend on the custom-domain edge path used by public traffic.
4. The scheduled `Rebuild Pages` workflow runs once at 08:17 UTC after the 08:05 UTC daily digest slot and remains the safety net if a fail-open deploy shipped the committed snapshot.

Because the committed snapshot is the fail-open fallback, refresh it roughly monthly (`npx tsx scripts/maintenance/sync-digests.ts --api-url https://api.pharos.watch --output data/digests.json` with `DIGEST_API_KEY` set, then commit) so a fallback build is never more than a few weeks stale.

### Internal sentinel rows

`daily_digest` rows flagged with `digest_meta.internal = true` (operational sentinel artifacts such as the `__bluechip_replay_guard__` weekly replay-guard row) are hidden from `GET /api/daily-digest`, `GET /api/digest-archive`, and `GET /api/digest-snapshot`. The archive endpoint still counts hidden rows when assigning per-type edition numbers, so edition numbers already published on socials and detail pages do not shift. Flag a row with:

```sql
UPDATE daily_digest
SET digest_meta = json_set(COALESCE(digest_meta, '{}'), '$.internal', json('true'))
WHERE id = <row id>;
```

---

## Environment Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `ANTHROPIC_API_KEY` | Secret | Yes | Claude API key for digest generation |
| `TWITTER_API_KEY` | Secret | No | Twitter OAuth consumer key |
| `TWITTER_API_SECRET` | Secret | No | Twitter OAuth consumer secret |
| `TWITTER_ACCESS_TOKEN` | Secret | No | Twitter OAuth access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | Secret | No | Twitter OAuth access token secret |
| `TELEGRAM_BOT_TOKEN` | Secret | No | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Secret | No | Telegram channel username or numeric ID |

Without `ANTHROPIC_API_KEY`, generation is skipped entirely. Telegram delivery is optional — the digest is always stored regardless.
