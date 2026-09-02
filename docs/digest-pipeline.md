# Digest Pipeline

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Generation · Data collection · DEX liquidity admission gate · LLM call · Editorial style gate · Failure handling · Storage · API Endpoints · Distribution · Weekly Recap · Frontend · Static Generation Pipeline · Internal sentinel rows · Environment Variables.

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
| Safety Map census | dated map manifest + validated `mapSummary` | Mapped supply, per-tier coin counts and supply shares, tier leaders, not-rated count, and explicit poster freshness/date |
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
| Cause context | `shared/data/annotations/coins/*.json` via `shared/data/annotations/curated-annotations.ts` | Curated, primary-sourced cause annotations for coins in the depeg set (resolved annotation timestamp within 90d before event start), rendered as a `CAUSE CONTEXT` prompt block so coverage can say *why* a coin broke; the model is instructed never to invent causes beyond the curated list |
| Standing conditions | derived from `topDepegs` | Chronic ledger: ongoing depegs ≥48h old (`standingConditions[]`) with day counts and live deviation — served through `/api/daily-digest`/snapshot, rendered as a compact "Standing:" strip on digest pages, and appended as one deterministic line to the Telegram edition, so demoted stories stay visible without narrated day-count headlines |
| Digest intelligence | current `DigestInputData` + latest archived `input_data` | Deterministic risk tape, what changed since yesterday, prior next-trigger outcomes, next triggers, calm-day frame, and editorial audit |

`DigestInputData` is defined in `shared/types/digest.ts` (re-exported via `shared/types/index.ts`) and imported by the digest cron, digest snapshot API, and frontend snapshot hook. Its optional `aggregateUniverse` marker preserves compatibility with archived pre-cutover rows.

Four additional optional fields were added to `DigestInputData` in the v2 refinement: `mintBurnFlows`, `dewsStress`, `historicalContext`, and `gradeTransitions`. All are populated only when their source data exists — the LLM writes from what's available.

A further enrichment pass added four more optional fields: `psiContributors`, `yieldAnomalies`, `liquidityShifts`, and `crossDayTrends`. All are populated only when their source data exists.

`safetyMap` is another optional, archive-compatible field. It stores the exact dated image URL, manifest capture (including the validated summary), and `current` or `carried-forward` freshness with whole-day age. It is persisted only when the summary is complete and capture-matched and the edition's canonical `safetyContext` is available; older rows and degraded editions omit it.

The digest intelligence pass runs after editorial candidates are built and before the LLM prompt is assembled. It adds:

- `riskTape`: compact reader-facing state for PSI, active depegs, Bank Run Gauge, DEWS, and the largest supply mover.
- `changeSummary`: deterministic "what changed since yesterday" buckets (`newSignals`, `worsenedSignals`, `improvedSignals`, `resolvedSignals`, `repeatedSignals`) derived from the previous archived input.
- `forwardLookOutcomes`: evaluation of yesterday's `nextTriggers` against today's input (`hit`, `missed`, `pending`, `expired`).
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

**Retraction propagation.** The four admission layers govern collection and publication of a new daily edition; they cannot retroactively invalidate evidence already stored in an archived daily row. `shared/lib/digest-signal-quarantine.ts` is therefore the checked-in, runtime-neutral registry for confirmed contaminated signals, keyed by stablecoin id, signal family, and an inclusive ingestion window. The initial entry quarantines the USDS liquidity ingestion at 2026-08-21 08:05:23 UTC that produced edition #179's false `$162.28M -> $13.72M` claim. The registry is deliberately scoped to that ingestion rather than the whole day, so unrelated signals and the 2026-06-22 YLDS `$13.72M` coincidence remain admissible.

What was deliberately **not** built: no coverage-weighted rescoring (coverage never fed the score, and damping it would hide genuinely thin coins); no rule that the composite must move proportionally with TVL (TVL Depth is `35 * log10(depthRatio / 0.0007)` at 30% weight, so a 91% TVL drop implies only about -11 points **by design** — #179's "score fell only ten points" was a correct number framed as a scandal, and the prompt now carries the implied move as `tvl-implies` so coverage cannot repeat that reading); no per-coin publication hold in the producer, because withholding a real crisis from the primary dataset is worse than reporting it and refusing to headline it; and no magnitude cap anywhere that a corroborated event cannot pass, because every gate here must fail toward *not publishing an unverified claim*, never toward *not seeing a real one*.

### LLM call

- **Model:** typed per-job configuration defaults daily generation to `claude-opus-5` via `https://api.anthropic.com/v1/messages`, with adaptive thinking (`thinking.type = "adaptive"`) and `xhigh` reasoning effort (`output_config.effort = "xhigh"`). Stored editions retain requested model, served model, and effort so voice drift remains auditable when server-side refusal fallback serves another model.
- **Reasoning:** adaptive thinking is on; no `budget_tokens` or sampling parameters are sent. `xhigh` is deliberate: measured Opus 5 `high` runs omitted the mandated forward-look line on both sampled daily editions, while `xhigh` had zero soft issues. Cost is bounded with the 16k token ceiling rather than by lowering effort.
- **Timeout:** 12-minute Anthropic outer timeout with an 11-minute per-attempt fetch timeout. The daily digest cron wrapper allows 14 minutes total, which stays below Cloudflare's 15-minute scheduled-trigger wall-clock ceiling while leaving tail room for persistence, logging, and channel delivery.
- **Streaming:** Requests set `Accept: text/event-stream` and `stream: true`. This is part of the Worker runtime contract because Opus adaptive thinking can take minutes before emitting text; streaming keeps the subrequest active with early headers / ping events during long thinking phases.
- **Max tokens:** 16000 for both jobs (thinking + visible output). The former 64k value guarded runaway thinking but did not bound spend. **`max_tokens` alone still does not bound spend**: a fetch-level timeout after Anthropic has produced output is billed and retried, so one edition can bill up to `DIGEST_FETCH_MAX_RETRIES + 1` generations per leg across the original and corrective legs — six at the ceiling, roughly 3x the single-retry figure. The actual bound comes from `DIGEST_MAX_EDITION_OUTPUT_TOKENS` (24000), an aggregate per-edition output budget: no request starts unless its full `max_tokens` still fits, an unknown post-submit failure is charged the full ceiling, and a server rejection carrying an HTTP status is charged nothing because it is rejected before generation. That caps the blended daily+weekly worst case near $1.10/day even when every attempt bills. Measured normal cost is $0.354/day blended, $0.712/day at the measured worst-case retry rate. `stop_reason=max_tokens` remains a hard failure.
- **Overload retries:** Anthropic `529 Overloaded` responses retry at most 2 times (3 attempts total), bounded by the 12-minute outer timeout
- **Refusals:** requests enable Claude-API server-side fallback with `fallbacks: "default"` and beta header `server-side-fallback-2026-07-01`. This preserves streaming and one outer timeout; a client-side second-model call could overrun the 12-minute Anthropic, 14-minute cron, or 15-minute scheduled-trigger bounds after existing HTTP retries. A final streamed refusal discards partial text, records nullable `stop_details.category`, publishes no edition, and does not affect the infrastructure circuit breaker.
- **Attempt telemetry:** every original, corrective, and HTTP attempt records requested/served model, effort, ceiling, input/cache/output tokens, attempt identities, stop reason, refusal category, latency, HTTP status, and computed cost in cron progress/run metadata. Successful editions also store the full attempt list under `digest_meta.llm`.
- **Editorial style:** Daily prose follows [Pharos Editorial Style](./editorial-style.md). `buildEditorialPrompt("daily")` in `shared/lib/editorial-style.ts` derives the system prompt from the authority's register and policy. This document does not restate voice rules.
- **Priority rule:** lead from the highest-impact unsuppressed editorial candidate. Raw evidence sections are supporting material, not the lead-selection source.
- **Critical depeg override (novelty-gated with a lead quota):** active depegs at or above 2,500 bps on at least $50M mcap, or 5,000 bps on at least $10M mcap — measured on the **live deviation** — bypass stale/chronic suppression. The top eligible critical is ranked by impact score (not raw bps) and produces a **hard** lead-validation requirement only when it is newly critical (event ≤48h old) or worsened ≥500 bps since the previous edition. One event may hard-lead at most 2 consecutive editions and 3 per trailing 7 (`shared/lib/digest-lead-policy.ts`, owner-ratified constants); past quota, and for older unchanged criticals, the requirement demotes to a **soft mention-only** rule (the symbol must appear, the lead is free). A material worsening re-qualifies the story regardless of quota. The prompt receives an explicit `REQUIRED LEAD TODAY` or `REQUIRED MENTION` line plus an `ONGOING STORIES` lead-streak ledger, and `editorialAudit` records `leadRequirementReasons` and `demotedLeadMentionTokens`. If Opus ignores a hard requirement, the quality gate retries and then blocks external delivery if unresolved.
- **Momentum candidates:** a separate in-prompt block surfaces candidates with `novelty ∈ {new, accelerating, reversal}` so the model has explicit forward-watch material upstream of the regex-based forward-look validator.
- **Deterministic next triggers:** the prompt receives `nextTriggers` with concrete thresholds. The model should use one for the required forward-look line instead of writing vague "watch this" closers, but must paraphrase the condition rather than transcribe its label/detail. Armed thresholds are explicitly identified as conditions, never prior observations; this prevents an unchanged trigger value from being laundered into a false "narrowed from N bps" claim.
- **Change/outcome context:** the prompt receives `changeSummary` plus `forwardLookOutcomes`, allowing the digest to say what changed since yesterday and whether prior forward-look checks hit, missed, or remain pending.
- **Safety desk:** when `input_data.safetyMap` passes the same capture and canonical-context gate, daily and weekly prompts receive one deterministic census block with mapped supply, every tier's count/share and leaders, not-rated count, and the UTC date depicted. A carried-forward census always names that date. The census is stock; `gradeTransitions` remains the sole per-coin mover/tier-crossing source. Missing, partial, malformed, or mismatched captures add no map language to the prompt, and the model may quote only the injected tier statistics rather than derive new ones.
- **Opening rule:** the first sentence of the extended field must surface a fact from the lead candidate (coin/number), not a templated PSI verb. The opening-fingerprint validator now checks the trailing 7-edition variety window, rather than only 3 editions, and raises a soft issue on a repeated PSI-verb opening. PSI remains the headline index but is no longer compulsory copy: include it when it moved, materially diverged, or frames the lead.
- **Forward-look mandate:** every digest must contain at least one anticipatory line (if/when/next-trigger/watch-for); a soft validator rejects retrospective-only digests.
- **Calm-day storytelling:** in CALM regimes without a critical lead, the prompt uses `calmNarrativeFrame` to frame documented quiet, supply rotation, issuer concentration, liquidity divergence, chronic risk boundaries, or explicit non-events without manufacturing menace.
- **Spice budget:** The prompt allows one sharp sentence per digest when the evidence earns it. The [daily register](./editorial-style.md) defines its temperature and limits.
- **Artifact policy:** candidates can be marked high-risk or suppressed for chronic small depegs, zero-value blacklist bursts, thin-liquidity artifacts, very high APY anomalies, or other weak evidence. The prompt explicitly tells Opus not to dramatize these.
- **Regime classification:** a `classifyRegime()` function labels each day as CRISIS, TENSION, WATCHFUL, or CALM based on PSI band, impact-weighted active depeg pressure, gauge score, FTQ status, and ALERT+ mcap rather than raw coin counts alone. Depegs older than 7 days contribute to regime pressure only when they worsened since the previous edition, so chronic standing conditions cannot pin the register at TENSION indefinitely (which had made the calm-day machinery unreachable).
- **Narrative structure:** regime-aware P1/P2/P3 paragraph structure; PSI appears when it moved, materially diverged, or frames the lead, rather than by daily fiat; default 3 paragraphs, 4 only when a distinct secondary story cannot fold into 1-3
- **Density contract:** 40–70 words per paragraph, 150–280 words total for the extended field
- **Structured sections:** When the digest covers two distinct stories, the LLM may use bold inline headers (e.g., `**Peg Watch**`, `**Capital Flows**`) to separate paragraphs. P1 (the lead) never has a header. The frontend renders these as styled inline spans.
- **Variety enforcement:** normalized structured `meta` field (lead signal id, lead type, tone, featured coins, used/suppressed candidate ids) from recent non-weekly digests replaces raw text dump; falls back to raw text for pre-meta entries. A coarse `leadFamily` mapper (psi, depeg, dews, flow, risk, macro) drives `repeated-lead-family` so variety enforcement survives the 28-token allowed-leads enum.
- **Variety and local guards:** The digest still validates opening and structural repetition, forward-look coverage, lead-family rotation, tone clusters, and recent title, tone, and coin repetition. These are digest-specific checks. Universal prose rules come from the style gate below.
- **Quality gate:** Parsed output is checked for required fields, paragraph and word budgets, title plus text length, code fences, lead requirements, movement-claim evidence, and safety-copy binding. Hard content issues can block after the applicable retry. Editorial style findings follow the staged gate below.
- **Output:** raw JSON `{ "title": "...", "extended": "...", "text": "...", "meta": { "lead": "...", "tone": "...", "coins": [...] } }` — no markdown fences

### Editorial style gate

The daily and weekly prompts derive their voice and register rules from [Pharos Editorial Style](./editorial-style.md) through `buildEditorialPrompt(register)` in `shared/lib/editorial-style.ts`. The prompt and scanner use the same policy records.

Pass 1 scans the model-owned `title`, `text`, and `extended` fields before any compatibility mutation or persistence. Each finding records its rule id, severity, field, excerpt, and position. Hard findings count as `would-block` events. Advisory findings feed telemetry and review and never block.

The gate mode comes from two validated D1 runtime values: `digest:style-gate-mode:daily` and `digest:style-gate-mode:weekly`. Each kind reads only its own key, and a missing or invalid value fails safe to `shadow` independently. The Access-authenticated `POST /api/trigger-digest` action accepts one explicitly scoped update, such as `{"styleGateMode":{"daily":"enforce"}}` or `{"styleGateMode":{"weekly":"enforce"}}`; an unscoped string, unknown kind, invalid mode, or two-kind update is rejected. The response returns the full effective `{daily, weekly}` state. No deploy is needed after these controls exist. For the selected kind, shadow keeps `stripForbiddenDashes` active after the trustworthy raw scan and does not block an edition on a style finding. Enforce disables the repair and lets unresolved hard findings block after the corrective retry. The repair covers the same U+2012 through U+2015 range as `no-clause-dash`.

Every generated row stores a bounded `digest_meta.editorialStyleGate` object and copies it into completion cron metadata. It contains the effective mode; an uncapped `firstPassWouldBlock` boolean; at most 12 first-pass findings as `{ruleId, field, excerpt, originalSeverity}` with excerpts capped at 160 characters; uncapped counts and truncation flags; `{eligible, attempted, outcome}` retry state; and at most 12 final unresolved findings under the same bound. `firstPassWouldBlock` makes the flip count reliable even when detail is truncated, while `retry.eligible` separately records whether the corrective generation fit the time and token budgets. Daily and weekly rows remain distinguishable through `digest_meta.type`; the operator query and flip procedure live in [`blocked-digest-edition.md`](./runbooks/blocked-digest-edition.md).

Daily enforcement flips independently after its 30-edition window records at most one would-block event. Weekly remains in shadow until its separate readiness criterion is met, then its own key flips without changing daily. An unresolved hard style finding blocks only editions of an enforced kind after at most one corrective retry. Advisory findings never block.

The corrective retry is field-targeted. It names the rule, field, and excerpt and asks for corrected JSON while preserving unaffected fields. The retry is skipped when the first pass crosses the elapsed-time threshold, currently half of the Anthropic timeout, or when the aggregate output-token budget cannot reserve another request. Shadow telemetry records each skip reason. These limits are why enforcement is staged.

Wrapper-owned findings are scanned under `delivery-wrapper` against the fully rendered X or Telegram payload immediately before send/enqueue. Model-owned spans are masked from this second enforcement decision because they have already passed their own mode-aware gate. A hard wrapper finding returns `skipped: editorial-style-wrapper` only for that channel, records bounded `wrapperEditorialAlerts` in cron metadata, and never calls the model. Telegram scans the cemetery appendix separately with the named `literal-cemetery` exemption; the remainder of the rendered payload receives no cemetery exemption. The Worker stores `editorialStyleVersion` and `editorialStyleHash` on each current edition, and the archive API returns those fields as copy provenance. Legacy editions without stored fields are surfaced as `pre-policy` at the API and UI read boundary. Archives remain historical record, byte-identical, and are never edited or retroactively tagged. See [`runbooks/blocked-digest-edition.md`](./runbooks/blocked-digest-edition.md) for operator triage.

### Failure handling


If parsing or content validation produces hard issues, the worker sends one corrective retry to the configured model containing the hard checks plus the failed response itself, so the model fixes the flagged problems instead of regenerating blind. Style hard findings use the same retry when enforcement is active; in shadow they remain telemetry-only. Soft-only content issues never trigger a retry. A `stop_reason=max_tokens` stream is treated as a hard failure before parsing. A `stop_reason=refusal` is a distinct policy outcome: pre-output and mid-stream refusals both discard text, skip publication, retain the classifier category for operators, and never count as Anthropic circuit failures.

When a blocking hard issue remains after the applicable retry, the digest row is stored with `digest_meta.qualityGate = "blocked"` for operator inspection: blocked rows are excluded from every public read endpoint, from edition numbering, from recent-copy variety context, and from lead-streak history because they never reached readers, and external delivery is skipped as `quality-gate`. Style-only findings in shadow do not set `qualityGate = "blocked"`. Advisory findings remain visible in run metadata without changing cron health. `meta.coins` labels are cross-checked against the copy (`meta-coins-mismatch`).

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

The `digest_meta` column stores structured metadata about editorial choices (lead signal, tone, featured coins) for variety enforcement across consecutive digests. It also stores `editorialStyleVersion` and `editorialStyleHash` for current editions. Older rows without style provenance remain absent and are surfaced as `pre-policy` at the API and UI read boundary; they are never edited or retroactively tagged. Older rows with `NULL` `digest_meta` fall back to raw text comparison.

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
| `POST /api/trigger-digest` *(admin)* | **Deferred**: optionally validates and persists one explicitly scoped `styleGateMode` update (`{"daily":"shadow|enforce"}` or `{"weekly":"shadow|enforce"}`), writes a bounded pending intent (`requestId`, timestamps, attempt count, retry state, and last error) into the D1 `cache` table, and returns 202 with the full effective `{daily, weekly}` mode state. A dedicated `*/5 * * * *` polling cron (`digestTriggerPoll`) runs the digest under scheduled-event wall-clock (up to 15 min), retries transient failures with bounded backoff, retains exhausted/permanent failures as dead letters, and persists outcome to `digest:last-trigger-result`. Poll-driven daily runs are resume-first: when today already has a publishable digest row, delivery resumes from the stored edition instead of regenerating a duplicate. The same poll resumes a missed weekly recap on Monday after 08:10 UTC when no non-blocked weekly row exists for that scheduled edition day. Expected latency: ≤ 5 min. Requires Access service-token headers on `ops-api.pharos.watch`. See [`worker-and-api-limits.md`](./worker-and-api-limits.md#manual-trigger-runtime-model) for the rationale. |

An idle `digestTriggerPoll` with no pending force-run intent or due Monday recovery is a neutral conditional poll, not an omitted daily or weekly execution. Stale-slot reconciliation therefore creates no synthetic digest failure when neither child has durable progress. If a digest did start and left durable progress before losing ownership, the sweeper still records the real abandoned attempt using its original progress timestamps.

---

## Distribution

The daily digest never blocks on Safety Score map publication. A current manifest or one carried forward by up to two whole UTC days enables the dated map attachment; otherwise the digest still generates and delivers without map attachment or map prose. Attached and persisted URLs always use `manifest.date`, never `latest.png`, and carried-forward captions and prompts identify the date the poster depicts. A complete capture is resolved before generation so the same immutable `safetyMap` object feeds the prompt, stored web snapshot, and channel copy.

After the digest is stored in D1, it is posted to configured Twitter/X and Telegram channels. Delivery never removes the D1 digest record. The manifest's optional `mapSummary` enables deterministic channel prose only when its complete typed shape is valid and the digest has an available canonical Safety Score context. An absent, partial, malformed, or capture-mismatched summary still permits the image attachment but emits no map prose. Twitter/X persists a same-day delivery ledger (see below).

### Web archive and sitemap policy

`/digest/` remains the primary indexable archive hub and links to every generated daily or weekly detail page present in `data/digests.json`. Individual digest detail pages stay indexable and sitemap-listed because they are durable archive/citation pages with unique editorial text and point-in-time snapshots. Crawl and URL Inspection quota should be managed through post-deploy GSC prioritization, not by dropping older daily digests from `src/app/sitemap.ts`.

The interactive archive may narrow the visible wire table with URL-addressable `view` (`all`, `daily`, or `weekly`), `month`, and `q` (title/body search) parameters. These controls do not alter the server-rendered crawlable link index or the sitemap's complete digest membership.

### Twitter

**File:** `worker/src/lib/twitter.ts`

- Auth: **OAuth 1.0a** signed with `crypto.subtle.HMAC-SHA1` (no third-party library)
- Format: `{title} (#N)\n\n{text}` — an edition-number suffix `(#N)` is appended to the title (N = running count of non-weekly digests, present on every post); exactly one `$` cashtag is retained on a tracked-ticker mention, preferring the declared lead ticker when metadata is supplied and it appears, otherwise falling back to the earliest match; truncated to 270 chars if needed. When map media upload succeeds with a valid summary and Safety Score context, the short pointer hook `See the map.` (or `See the {UTC date} map.` for a carried-forward map) is reserved inside that budget, and the digest text is word-boundary truncated first.
- Endpoints: `POST https://upload.twitter.com/1.1/media/upload.json` for the PNG, then `POST https://api.twitter.com/2/tweets` with its media id
- Mapped editions are all-or-nothing: a media upload failure is retried once, then aborts the tweet as a `definitive_failure` (no tweet was attempted, so the ledger's bounded retry path stays open) instead of degrading to a text-only post.

**Required secrets:**

| Variable | Description |
|----------|-------------|
| `TWITTER_API_KEY` | OAuth consumer key |
| `TWITTER_API_SECRET` | OAuth consumer secret |
| `TWITTER_ACCESS_TOKEN` | OAuth access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | OAuth access token secret |

If any of the four are absent or blank, Twitter posting returns `skipped: no-creds`; the missing variable names are surfaced in structured run metadata, and the digest run is non-green rather than silently skipped. Twitter/X delivery is replay-safe per UTC date: `daily-digest.ts` atomically advances `daily-digest:twitter-sent:YYYY-MM-DD` through `queued` → `sending` → `sent`, `execution_unknown`, or `failed`. Success records the tweet id. A clear Twitter 4xx rejection enters `failed` and may retry up to three total attempts; timeout, network, ambiguous 5xx, lost sending ownership, or accepted-post persistence ambiguity enters or is treated as `execution_unknown`, retains the ledger marker, disables automatic retry, and emits a structured error with the manual reconciliation step. Legacy markers and terminal `sent` rows remain duplicate-safe. If the ledger claim fails, Twitter/X delivery is not attempted, avoiding duplicate force-run posts during cache/D1 contention. When no acceptable map is available, the tweet remains text-only; when a map is selected, a media upload failure aborts the mapped tweet before creation and remains eligible for the ledger's bounded retry path.

### Telegram

**Files:** `worker/src/lib/telegram.ts`, `worker/src/lib/telegram-digest-outbox.ts`

- Auth: bot token embedded in the request URL (no OAuth)
- Parse mode: **HTML** — title is wrapped in `<b>`, link uses `<a href>`
- Format (the `Pharos Daily Digest #N` kicker is prepended whenever an edition number is present, which is the normal case):
  ```
  <b>Today’s map</b>
  Mapped supply: ${total} across {gradedCount} coins
  A tier: {count} coins · {share}%
  C/D/F tiers: {count} coins · {share}%

  Pharos Daily Digest #N
  <b>{title}</b>

  {extended}

  <a href="https://pharos.watch/digest/YYYY-MM-DD/">Read on Pharos →</a>

  <a href="https://t.me/PharosWatchBot">Open @PharosWatchBot for a private /recap →</a>
  ```
- Endpoints: `POST https://api.telegram.org/bot{token}/sendPhoto` for mapped editions, followed by `POST https://api.telegram.org/bot{token}/sendMessage` for text chunks

The `extended` field is used instead of `text`. The four-line map block shown above is present only when the optional map summary and canonical Safety Score context are both available; every count, supply total, and share is computed from the summary's tier market caps. It is the first text section after the separate map photo so the numbers stay adjacent to the image. A deterministic `Standing:` chronic-conditions line is rendered as its own expandable context blockquote (still capped at five entries). `New Cemetery Entries` and `Tracking Changes` are each rendered as expandable blockquotes; they remain in the same message, so no second-message cursor is needed. The private-recap CTA is emitted only when the resolved rollout policy is `public`, and links to `@PharosWatchBot` rather than suggesting that a channel can receive a private recap; a missing policy deliberately emits no CTA. Telegram persists the dated map URL, depicted date, and media delivery state with the immutable edition. Delivery sends the map first through `sendPhoto`, durably records `media_state=sent`, then resumes text from the existing chunk cursor. Retryable photo failures do not advance that cursor, and text retries never resend an accepted photo. Editions without a map remain text-only with `media_state=none`. The final rendered HTML is split on safe structural boundaries below the 4096-character Bot API ceiling. Every chunk is persisted before the first external request, including unusually large appendix editions.

Before the Telegram channel post is sent, `worker/src/cron/daily-digest.ts` also asks `worker/src/lib/telegram-digest-appendices.ts` for any pending deploy-diff notices. When present, those notices are appended beneath the digest body as expandable blockquotes:

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

If either is absent or blank, Telegram delivery returns `no-creds`, surfaces the missing variable names in run metadata, and degrades the digest run.

**Channel setup (one-time):**

1. Create a bot via @BotFather → `/newbot` → copy token
2. Create the public channel
3. Add the bot as Admin with "Post Messages" permission only
4. Add secrets from the worker directory: `cd worker && npx --no-install wrangler secret put TELEGRAM_BOT_TOKEN` and `cd worker && npx --no-install wrangler secret put TELEGRAM_CHAT_ID`

`telegram.ts` also exports `sendToChat()` for the Telegram webhook command handler; digest media and text use the same bot/channel credentials through the durable outbox.

### Distribution status logging

Daily and weekly channel outcomes are returned in scheduled-run cron metadata. `POST /api/trigger-digest` does not run delivery inline anymore; it optionally updates one kind's runtime style mode, enqueues a retryable force-run intent, and returns `202` with `{ ok, accepted, requestId, styleGateMode: { daily, weekly }, message }`, then the 5-minute digest-trigger poll writes each eventual result to cron history and the `digest:last-trigger-result` cache entry. Transient failures remain pending with bounded backoff for up to three attempts; permanent or exhausted failures remain as a retained `dead_letter` intent, while a successful run clears the intent.

```json
{
  "summary": "243 chars, tweet: ok, telegram: ok",
  "channels": {
    "twitter": { "status": "ok", "disposition": "delivered", "missingCredentialNames": [] },
    "telegram": { "status": "ok", "disposition": "delivered", "missingCredentialNames": [] }
  }
}
```

Possible channel values include `"skipped: no-creds"` (Twitter), `"no-creds"` (Telegram), `"ok"`, `"failed: <truncated error>"`, `"queued: <state>"`, `"skipped: circuit-open"`, `"skipped: quality-gate"`, `"skipped: already-sent"`, and successful appendixed delivery strings such as `ok+appendix(...)`. Outbox retry and terminal backlog counts are separately exposed under the budget-only `telegram-digest-outbox-drain` status surface.

---

## Weekly Recap

**File:** `worker/src/cron/weekly-recap.ts`
**Schedule:** Mondays only in the `daily-0810` slot (`"10 8 * * *"`), with missed-edition recovery from the five-minute digest poll after 08:10 Monday UTC
**Dedup guard:** derives Monday and the edition date from the scheduled slot timestamp, returns `skipped_neutral` outside Monday UTC or when that scheduled day already has a non-blocked weekly row with no retryable channel, and retries only duplicate-safe channel states. Quality-gate, `execution_unknown`, and `failed_permanent` outcomes require review rather than blind channel replay.
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

Before these aggregates are built, archived daily signals are checked against the shared quarantine registry using the signal ingestion timestamp. A quarantined liquidity row and its canonical editorial candidate, trigger context, and archived authored headline/summary are withheld from weekly input. The weekly input records `liquidity-shift-quarantined-signal:<stablecoinId>:<date>` in `degradedSources`, distinguishing an explicit retraction from a quiet week. As a second fail-closed layer, weekly validation raises the hard `quarantined-signal-claim` issue if generated copy repeats a registered collapse/drain claim; the normal single corrective retry applies, then unresolved copy is stored with `qualityGate = "blocked"` and is not distributed.

Requires >=5 current-week daily digests to proceed. Prior-week coverage below 5 is tolerated; `weekOverWeekDeltas` is then `null` and the prompt notes the gap instead.

### LLM call

- **Model:** weekly typed configuration defaults to `claude-opus-5` with adaptive thinking + `xhigh` effort; validated runtime overrides are resolved at the shared scheduled invocation seam and invalid values fall back to checked-in weekly defaults
- **Timeout:** shared 12-minute Anthropic request cap; the scheduled weekly wrapper has a 14-minute cron lease, preserving about two minutes for persistence and two-channel delivery
- **max_tokens:** 16000, with the same hard truncation, refusal fallback, provenance, and per-attempt telemetry contract as daily generation
- **Editorial style:** Weekly prose uses the same authority through `buildEditorialPrompt("weekly")`; its register and policy findings follow the staged style gate above.
- **Structure:** 4-6 paragraphs, 250-400 words: top unsuppressed Weekly Risk Leaderboard item as the week's headline, dominant story, counter-narrative, supply/capital flows, optional structural observation
- **Artifact policy:** Same suppression principle as daily. Weekly recaps separate repeated active observations from unique signals so chronic conditions are not counted as fresh events.
- **Critical lead validation:** if the weekly risk leaderboard's top unsuppressed item is a critical depeg, its `id` is passed as a hard `leadSignalId` requirement.
- **Variety:** Recent weekly recap metadata is supplied to avoid repeating the same weekly frame. Meta is normalized on the same contract as daily (allowed leads + tones); `repeated-lead-family` applies to weekly output too.

### Storage

Stored in the same `daily_digest` table. The `digest_meta` column includes `"type": "weekly"`, `"periodType": "trailing-daily-editions"`, `weekStart` and `weekEnd` date strings, the authored safety context, and parallel Twitter/Telegram delivery status, update, and delivered-at fields. The `input_data` column stores the `WeeklyInputData` aggregation (not raw `DigestInputData`) with the exact active safety identity or an explicit unavailable state.

### Distribution

Posted to both Twitter/X and Telegram. Twitter/X uses the distinct replay-safe ledger key `weekly-recap:twitter-sent:YYYY-MM-DD`; both channels attach the current or bounded carried-forward dated Safety Score map when available and otherwise publish without map prose or media. Telegram's title is prefixed with "Weekly Recap:" and the link uses the weekly route slug `/digest/YYYY-MM-DD-weekly/`. The exact rendered weekly edition uses the same durable outbox as daily distribution. Confirmed retryable Telegram failures are polled every five minutes without another LLM call; ambiguous or permanent outcomes stop for operator reconciliation. Channel compatibility fields in `daily_digest.digest_meta` are updated after delivery.

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

The wire table shows each digest as a compact row: **date** (monospace, e.g. "27 FEB"), **title**, optional active-depeg **risk badge**, **PSI badge** (pill colored by condition band), and **total market cap**. The archive exposes URL-addressable All/Daily/Weekly, month, and title/body search controls; the selected view is shareable without dropping the server-rendered links. PSI, mcap, and risk data are served from the enriched archive API response (`psiScore`, `psiBand`, `totalMcapUsd`, `riskSignal` — parsed from the stored `input_data` JSON).

The archive also renders a trigger record from `forwardLookOutcomes`. Hit, missed, expired, and pending outcomes remain separate; the headline hit share is `hit / (hit + missed + expired)`, with pending excluded from that denominator. Rows are grouped by the archived trigger metric when it is available, and outcomes without a metric stay in an explicit unclassified bucket. No single-edition claim is promoted to a site-wide accuracy statement.

The archive route emits server-rendered digest links for crawlability plus `CollectionPage` / `ItemList` JSON-LD over the checked-in `data/digests.json` entries. The visible archive, daily lead story, and latest weekly recap render in the client archive component after `/api/digest-archive` loads; detail pages remain the canonical `Article` surfaces for individual digests.

### Detail pages

**Route:** `/digest/[date]/`
**Page:** `src/app/digest/[date]/page.tsx` (SSG)
**Static params:** generated from `data/digests.json` at build time
**Component:** `src/components/digest-snapshot.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDigestSnapshot`) → `GET /api/digest-snapshot?date={date}`

Daily detail pages use slugs like `/digest/2026-03-24/`. Weekly recap pages use `/digest/2026-03-24-weekly/`; the archive client builds those slugs from `digestType === "weekly"` and the snapshot API accepts the matching `?date=YYYY-MM-DD-weekly` query. The snapshot API filters target rows by requested type, so daily and weekly rows generated on the same UTC date cannot shadow each other.

Each detail page shows the short summary intro (`text`) followed by every extended editorial paragraph plus a deterministic intelligence panel, the stored dated Safety Score map when its complete `input_data.safetyMap` capture is present, and up to 10 data-dependent contextual cards (Market Snapshot, Stability Index, Supply Mover, Active Depegs, Blacklist Activity, Safety Scores, Yield Anomalies, DEX Liquidity Shifts, Supply Velocity, Resolved Depegs). The map uses the stored `imageUrl` and `manifest.date` (never `latest.png`) plus the validated summary's deterministic tally; a missing or failed poster renders the existing unavailable state and never fabricates figures. The intelligence panel renders `riskTape`, yesterday's trigger outcomes, "what changed", and next triggers when present in stored `input_data`. The Active Depegs card uses `/api/digest-snapshot` depeg episodes active on that date, ordered by absolute deviation, with stored `input_data.topDepegs` only as fallback. If snapshot context fails or has no usable input data, the page renders a small unavailable-state card instead of silently dropping the section. Detail pages also render a small research-context link grid back to PSI, depeg, flow, and safety-score surfaces. Includes JSON-LD Article structured data and prev/next navigation.

---

## Static Generation Pipeline

**Script:** `scripts/maintenance/sync-digests.ts`
**Command:** `npm run sync:digests`

Fetches `GET /api/digest-archive` from an explicit API source, transforms it to the `data/digests.json` format (`date`, `digestType`, `editionNumber`, `title`, `text`, `extended`, `generatedAt`, `editorialStyleVersion`, `editorialStyleHash`), and writes the file. Each style field is copied only when upstream carries a real value. If upstream returns `pre-policy` for display or omits a field, sync leaves that field absent; it never writes the sentinel into `data/digests.json` or back-fills archived rows. Weekly entries use a `YYYY-MM-DD-weekly` date slug so they cannot shadow daily entries for the same UTC day. The script accepts `--api-url` or `DIGEST_API_URL`, optional `--output`, forwards `DIGEST_API_KEY` when set, and falls back to `SMOKE_API_URL` (or the Pages URL) only when explicitly enabled.

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
