# Digest Pipeline

> **Agent navigation** — Grep the heading you need instead of reading wholesale: Overview · Generation · Data collection · DEX liquidity admission gate · LLM call (model/budget/retries) · Editorial style gate (operator policy links) · Failure handling · Storage · API Endpoints · Distribution · Telegram (immutable outbox/appendices) · Distribution status logging · Weekly Recap · Frontend · Static Generation Pipeline · Internal sentinel rows · Environment Variables.

Daily AI-generated stablecoin market recap, distributed to the web, Twitter/X, and Telegram.

---

## Overview

The digest pipeline has four layers:

1. **Generation** — a Cloudflare Worker cron collects market data and calls Claude to produce a short editorial recap
2. **Storage** — the result is persisted to D1 (`daily_digest` table)
3. **Distribution** — immutable Telegram editions are persisted before Bot API delivery, then sent immediately or retried from the stored payload
4. **Frontend** — served via public API endpoints, displayed on the homepage and a dedicated archive

Daily and weekly jobs share requests/parsing in `worker/src/cron/digest/llm-request.ts`, row insertion and circuit-aware delivery in `worker/src/cron/digest/platform.ts`, and publication orchestration in `worker/src/cron/digest/publish.ts`. Each job owns input-building and prompts.

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
**Dedup guard:** skips if the latest non-weekly, non-internal, non-blocked digest is <1 hour old, unless its text starts with a code fence or `force=true`

See [Failure handling](#failure-handling) for corrective retries, publication holds, and degraded-source behavior.

### Data collection

The cron assembles a `DigestInputData` object from the collector set below before calling the LLM:

Total market cap and supply change/velocity use `core-stablecoins-v1`: active `core-stablecoin` and `cash-equivalent` listings. PSI contribution uses `CORE_PSI_ELIGIBLE_IDS`, which also includes reviewed historical PSI assets. Tracked variants and stable-value investments remain monitored in depeg, DEWS, safety, yield, and liquidity signals. Mint/burn aggregates instead use the active tracked-pair universe described below. New daily snapshots persist `aggregateUniverse: "core-stablecoins-v1"`; weekly rollups prefer marked rows to avoid mixing legacy and core totals.

Current aggregate supply carries `supplyCoverage` (complete, observed and unavailable counts) against that full active universe. Unavailable buckets remain absent from the known subtotal; observed zero remains a measured member. Prompts identify incomplete current sums as known subtotals, never full ecosystem totals. ATH comparison and historical market-cap trajectories require proven complete coverage. Safety-map summaries separately persist known-mapped-supply coverage, including per-id reasons for unavailable values, and retain it through archive parsing.

New daily captures also include optional `supplyCoverage.memberFingerprint`: SHA-256 of JSON `[aggregateUniverse, sorted full-universe member IDs]`. This identifies membership, not supply values or observation freshness. Snapshot and archive response schemas admit coverage additively; legacy rows without it remain readable but unproven. The web archive and market snapshot label partial or legacy amounts as known subtotals with observed-member counts or “coverage unproven”; no observed members means unavailable rather than a total of zero.

After the coverage cutover, legacy rows cannot populate market-cap history: ATH is absent until a complete core-universe digest is stored; the seven-day trajectory then rebuilds from complete rows. PSI and gauge history are unaffected.

Total and per-coin ATH context uses absolute percentage distance with above/below wording; equality is at the high, not above it. These comparisons preserve the existing complete-coverage and historical-context admission rules.

Weekly market-cap ranges and endpoint comparisons also require explicit complete supply coverage. Legacy rows without coverage proof and partial known subtotals publish `N/A (supply-coverage-incomplete)` rather than becoming ecosystem totals; unrelated observed weekly metrics remain available. Monetary-threshold depeg/recovery/liquidity candidates with unavailable supply are withheld with named quality findings, while the active incident count still retains the observed open event.

Depeg statistics are independent of editorial display lists. `activeDepegCount` counts every tracked, non-frozen open event; `resolvedDepegCount` counts every tracked, non-frozen positively recovered event in the last 24h before supply, peak-size, and top-five filters. Failed reads persist null counts with `active-depegs-query` / `resolved-depegs-query`; the prompt and captured frontend never turn those into zero. `depegSignalKeys` persists the full active/resolved incident identities (`stablecoinId:startedAt:kind`) before display filtering for weekly deduplication. Legacy editions lacking those identities cannot establish a complete unique-signal statistic and publish unavailable, not a count reconstructed from capped rows.

The risk tape uses the full `activeDepegCount` as its absence authority: only an observed zero with no failed read supports “None active.” A positive count without admitted sized details retains that count and marks severity/supply unavailable; an unknown count stays unavailable. Neither state can certify a CALM regime merely because detail rows were withheld.

DEWS persists full admitted ALERT+ `alertPlusMcapUsd` and `alertPlusSupplyCoverage` before supply-size or top-five presentation filters. Missing supply remains unavailable; observed zero is a measured member. `bandChangeCount` counts all rank-changing comparisons before slicing and is null without a prior generation. Regime, breadth candidates and risk tape use these aggregates, never display-list sums or lengths; partial known supply can establish a stress threshold but cannot certify CALM. Legacy captures without full aggregates stay unavailable, not reconstructed from displayed coins.

Organic grade accounting is separate from the top-five `gradeTransitions` presentation list. `gradeTransitionAccounting` persists the half-open 48-hour capture window, comparable Safety identity, eligible distinct count and every slim `{historyId, recordedAt}` pair. The collector applies tracked graded-coin supply >$10M, active model/schema/methodology/policy/build and the existing bump exclusions before counting or limiting details. It drains fixed 500-row keyset pages on the existing recorded-at/history-id index and reconciles them with `COUNT(DISTINCT history_id)` before marking `complete: true`; a failed drain or mismatch persists explicit incomplete accounting without a partial identity list. Canonical Safety transition classification is unchanged.

| Category | Source | Key signals |
|----------|--------|-------------|
| Market metrics | stablecoins cache + listing governance registry | Core-universe total mcap, 7d delta, biggest supply mover (>$1M), cache age |
| Editorial candidates | derived from all collected signals | Pre-ranked lead candidates with impact, novelty, confidence, artifact risk, and suppression reasons |
| Depeg events | `depeg_events` + event provenance/native quote cache; fresh `stablecoins` prices for USD-reference events | Open-event inclusion and counts follow the canonical detector. Severity, suppression and ranking use `currentBps` in the event's `quoteMode` against its `pegReference`, with `priceObservedAt` from the selected observation. Native events use the canonical native evidence policy: contemporaneous start/recovery or persisted event-specific quote within its six-hour budget, never an unclocked peak or USD/FX substitution. Native prices stay in `currentPriceNative`/`peakPriceNative`, never USD-named fields. USD-reference events retain the public stablecoins freshness budget. Without admitted evidence, stored `peakBps` is explicitly `severityBasis: "peak-fallback"`. Top 8 rank by critical severity then impact (\|bps\| × mcap), with age/chronic suppression and critical overrides on that selected basis |
| Stability Index | `stability_index_samples` + `stability_index` | Admitted sample (≤2h) or completed daily fallback (window end ≤24h); future clocks rejected; day keys remain historical |
| Blacklist activity | Public `blacklist_events` (`suppression_reason IS NULL`, rolling last 24h) | Complete observed freeze/destroy counts, known USD subtotal and unpriced count are always retained (including observed zero). Only editorial promotion uses ≥2 events OR >$10M single; unknown amounts remain promotion-eligible. Unsuppressed zero-value bursts are artifact-risk candidates; suppressed mirror-zero rows cannot create candidates |
| Supply velocity | top 10 coins by mcap | 1d vs 7d changes; signals: "reversed", "accelerating", "decelerating" with material daily/weekly thresholds |
| Safety scores | canonical V9 publication | Native V9 grades, three pillars, reviewed reasons, caps, and publication health |
| Safety Map census | dated map manifest + validated `mapSummary` | Mapped supply, per-tier coin counts and supply shares, tier leaders, not-rated count, and explicit poster freshness/date |
| Resolved depegs | `depeg_events` (last 24h) | Only closures positively classified by `classifyDepegClosure` as `recovered` or `legacy_recovered` are recovery evidence; filters: peak >100 bps AND observed mcap >$20M; top 5 by impact score |
| Mint-burn flows | published `GET /api/mint-burn-flows` aggregate payload (`mint-burn-flows:v5:aggregate:24`, 24 closed UTC hours) | Bank Run Gauge (mcap-weighted, **re-binned, never recomputed**), Flight-to-Quality (canonical V9 classification), top pressure coins (\|FIS\| > 20), top 3 chains by absolute 24h net; incomplete scan-window nets remain unavailable, never inactive/zero |
| Total mcap ATH | derived from core-marked `daily_digest` rows (`json_extract` on stored `totalMcapUsd`) | Anchors current core total mcap against its post-cutover Digest-window ATH value and date |
| DEWS stress | Accepted `stress_signals` generation + `stress_signal_history` | Full band distribution, ALERT+ known-supply subtotal/coverage and band-change count; up to 5 band moves and 5 elevated coins (mcap >$10M) for presentation only |
| Historical context | `daily_digest` + `stability_index` + `supply_history` | Prior digest PSI precedent and tracking days; canonical `getPsiBandStreak` counts the current observation plus consecutive completed UTC days (gaps/band changes stop it), anchored to the admitted PSI source time; supply mover ATH/largest weekly change |
| Grade transitions | `safety_score_history_v2` | Organic report-card grade changes from the active model/policy/build (last 48h); activation, rollback, restoration, and methodology/build baselines are excluded |
| PSI contributors | `stability_index_samples` (input_snapshot) | Top 3 coins driving PSI severity by absolute market impact (\|bps\| x mcap x factor). Finite signed deviations, including above-peg values over 10,000 bps, retain their sign; finite positive cap, finite nonnegative factor and the existing sample freshness gate still apply |
| Yield anomalies | `yield_data` (is_best rows) | Active `warning_signals`, APY vs 7d/30d averages; mcap ≥$10M and APY <500%; top 5. `collectYieldAnomalies()` in `worker/src/cron/daily-digest/collectors-risk.ts` owns admission |
| DEX liquidity shifts | `dex_liquidity_history` | Day-over-day score changes >=8 points; TVL comparison; filtered to mcap ≥$10M. Every pair must clear the [liquidity admission gate](#dex-liquidity-admission-gate) before it becomes editorial evidence |
| Cross-day trends | `daily_digest` (archived input_data) | Up to 7 non-weekly rows from the last 7 days for PSI, total mcap, and Bank Run Gauge trajectories; requires >=3 rows, not distinct UTC dates |
| Data quality | collector status + window metadata | Degraded collectors, cache age, PSI source time, mint/burn and blacklist windows |
| Recent digests | last 7 non-weekly rows from `daily_digest` | Passed to LLM to enforce daily variety |
| Cause context | `shared/data/annotations/coins/*.json` via `shared/data/annotations/curated-annotations.ts` | Primary-sourced annotations for depeg-set coins, timestamped from 90d before event start through collection time, rendered as `CAUSE CONTEXT`; the model must not invent causes beyond the curated list |
| Standing conditions | derived from `topDepegs` | Chronic ledger: ongoing depegs ≥48h old (`standingConditions[]`) with day counts and live deviation — served through `/api/daily-digest`/snapshot, rendered as a compact "Standing:" strip on digest pages, and appended as one deterministic line to the Telegram edition, so demoted stories stay visible without narrated day-count headlines |
| Digest intelligence | current `DigestInputData` + latest archived `input_data` | Deterministic risk tape, what changed since yesterday, prior next-trigger outcomes, next triggers, calm-day frame, and editorial audit |

Cause-context dates are admitted by the shared strict calendar/UTC parser before annotation loading completes. Impossible days and invalid clocks fail with the coin ID and entry index rather than shifting an event into a different digest window; valid date-only values mean UTC midnight, and full UTC timestamps retain fractional seconds at millisecond precision.

`DigestInputData` is defined in `shared/types/digest.ts` (re-exported via `shared/types/index.ts`) and imported by the digest cron, digest snapshot API, and frontend snapshot hook. Its optional `aggregateUniverse` marker preserves compatibility with archived pre-cutover rows.

Partial mint/burn valuation is admitted only when the full-cohort score interval preserves the gauge band, all numeric gauge regime decisions (strict cutoffs at -50, -20, and -10), and risk-tape tone. Otherwise the mint/burn section is withheld with regime-critical degradation `mint-burn-gauge-valuation-partial`; missing valuation cannot imply CALM or produce an exact gauge tape value. Small robust partial cohorts retain their numeric scored-cohort value and named quality reason; withheld flow claims remain unavailable.

A published null mint/burn gauge omits the flow section with named quality reason `mint-burn-gauge-unavailable`. Like missing, malformed, expired, or failed gauge reads, it is regime-critical: classification may retain observed stress from other inputs, but cannot publish CALM (the existing unavailable-input floor is WATCHFUL).

Optional source fields are populated only when their evidence exists; absent evidence is not a measured empty result. `shared/types/digest.ts` owns the archive-compatible input shape.

`safetyMap` is another optional, archive-compatible field. It stores the exact dated image URL, manifest capture (including the validated summary), and `current` or `carried-forward` freshness with whole-day age. It is persisted only when the summary is complete and capture-matched and the edition's canonical `safetyContext` is available; older rows and degraded editions omit it.
`shared/types/digest-safety-map-contract.ts` owns the shared map field shapes and three distinct profiles: strict canonical Zod trims text and rejects unknown keys; canonical readers preserve text and project admitted fields; archive readers additionally admit relative dated URLs, legacy summary locations and missing age (projected as null). Archive projection does not import the full digest/Safety schema graph. Reader coverage reconciliation and invalid optional-summary omission remain separate from strict structural validation.

**Deterministic intelligence evidence contract.** The prompt remains intentionally presentation-capped: top-N rows (including active depegs, yield anomalies, and DEWS elevations) are for model context and display only. `changeSummary` and `forwardLookOutcomes` evaluate each prior target against the full current canonical evidence set by stable event or asset id, with the existing legacy symbol fallback only where an archived row has no id; absence from a top-N or admission slice is never evidence that a target cleared.

A depeg recovery claim requires a positively observed closure classified by `classifyDepegClosure` as `recovered` or `legacy_recovered`. Omission, top-N demotion, failed read, coverage loss, supersession, orphaning, or unknown closure is unavailable, not recovery. Excluded or failed evidence yields an `unavailable` outcome and is excluded from both the daily hit-share and weekly hit/miss denominators; it is never counted as a hit or miss.

Depeg movement and threshold claims require two fresh current observations on the same event, asset, and peg/reference basis: the prior observation that armed the comparison and the current observation that evaluates it. Current-to-peak, peak-to-current, or peak-to-peak comparisons cannot establish depeg movement or threshold outcomes. Stored peaks remain historical context.

These are deterministic evidence and publication contracts, not a scoring-formula or methodology-version change. They apply prospectively to new evaluation and do not rewrite already published history.

The digest intelligence pass runs after editorial candidates are built and before the LLM prompt is assembled. It adds:

- `riskTape`: compact reader-facing state for PSI, active depegs, Bank Run Gauge, DEWS, and the largest supply mover.
- `changeSummary`: deterministic "what changed since yesterday" buckets (`newSignals`, `worsenedSignals`, `improvedSignals`, `resolvedSignals`, `repeatedSignals`) derived from the previous archived input.
- `forwardLookOutcomes`: evaluation of yesterday's `nextTriggers` against today's input (`hit`, `missed`, `pending`, `expired`, `unavailable`); unavailable evidence is retained for audit but excluded from daily and weekly hit/miss denominators.
- `nextTriggers`: structured checks for depeg bps, supply velocity, DEWS, gauge, PSI, yield cooling and DEX follow-through. The complete armed condition is sticky: metric, comparator, threshold, target, label and rationale stay together even when a new daily candidate reverses direction or evidence is unavailable. Only lifecycle repetition advances, and the condition sentence is rendered from that retained tuple. A hit re-arms from the new candidate; the existing three-edition TTL releases an unhit trigger's slot (pending outcomes become `expired`, while unavailable evidence remains `unavailable`). Depeg thresholds use live deviation, not stored peak. This policy applies prospectively without changing trigger IDs or archived editions.
- `calmNarrativeFrame`: a fallback editorial frame for calm regimes so quiet days can explain what changed, what did not happen, and what would make the next day less calm.
- `editorialAudit`: added after the LLM response is parsed; stores top/usable/suppressed/momentum candidate ids, required lead ids, declared `leadSignalId`, used candidate ids, and quality issue codes.

Digest safety reads resolve through `worker/src/lib/safety-score-active-source.ts` (bound into digest copy by `worker/src/lib/digest-safety-context.ts`). The loader accepts only the complete current canonical V9 publication. Held, invalid, stale, or unavailable V9 is explicit and never triggers V8 computation or fallback.

The digest's Flight-to-Quality collector uses `buildFlightToQualityClassificationFromV9Snapshot()` from `worker/src/lib/flight-to-quality-classification.ts` via `worker/src/cron/daily-digest/mint-burn-ftq.ts`, aligned with the public `/api/mint-burn-flows` classification path.

**Bank Run Gauge — one producer, one universe.** `refreshAggregateMintBurnFlowCache()` (`worker/src/api/mint-burn-flows.ts`) computes the gauge over active tracked pairs with tracked-chain mcap weighting. The digest reads that publication through `worker/src/lib/mint-burn-published-gauge.ts` and re-bins it; it never recomputes from `mint_burn_hourly`. Malformed or >24h-old publications are dropped and degrade the run (`mint-burn-gauge-malformed` / `mint-burn-gauge-expired`); >2h-old publications (≈4 missed 30-minute producer runs) remain usable but mark `mint-burn-gauge-stale`. Missing rows omit the section and record quality finding `mint-burn-gauge-missing` in `dataQuality.degradedSources` without independently degrading cron health. The missing-input regime floor still applies. The critical lane republishes every 30 minutes; absence is not a silently optional section.

Flow captures retain original closed-hour windows and independent publication/body clocks; unavailable legacy provenance stays null. [Flow provenance details](#flow-provenance-details) never infer generation identity from a timestamp.

DEX claims pass collector comparability, independent editorial corroboration and publication suppression gates; producer visibility alone is insufficient. The [DEX liquidity admission gate](#dex-liquidity-admission-gate) in the implementation appendix retains exact thresholds and failure policy.

### LLM call

Both jobs wrap the shared 12-minute LLM deadline in a 14-minute cron budget: two minutes remain for persistence, distribution and logging, plus one before the platform's 15-minute ceiling. D1 lease TTL adds 60 seconds to the effective wrapper budget. Daily uses `heartbeatSec = 30` / `maxRenewFailures = 3` in `worker/src/handlers/scheduled/context.ts`; other jobs retain defaults.

- **Model:** daily typed configuration defaults to `claude-opus-5-5` (Claude Opus 5.5) at `https://api.anthropic.com/v1/messages`, with adaptive thinking (`thinking.type = "adaptive"`) and high effort (`output_config.effort = "high"`). Editions retain requested/served model and effort to audit voice drift across server-side refusal fallback.
- **Reasoning:** adaptive thinking is enabled with `high` effort; no `budget_tokens` or sampling parameters are sent.
- **Timeout:** one edition-wide 12-minute `ANTHROPIC_TIMEOUT_MS` covers original/corrective legs, HTTP retries, backoff and stream reading; corrective work never restarts it. The 11-minute per-attempt fetch timeout bounds headers only (`fetchWithRetry` clears it when headers arrive). The 14-minute wrapper and remaining persistence/delivery allowance are described above.
- **Streaming:** Requests set `Accept: text/event-stream` and `stream: true`. This is part of the Worker runtime contract because Opus adaptive thinking can take minutes before emitting text; streaming keeps the subrequest active with early headers / ping events during long thinking phases.
- **Max tokens:** `DIGEST_MAX_TOKENS` = 16000 for both jobs (thinking + visible output). `DIGEST_MAX_EDITION_OUTPUT_TOKENS` = 32000 is enforced by reserving a full request ceiling before each HTTP attempt. Known output usage is charged across `usage.iterations`; a fetch-level failure or successful stream without final usage is charged the full request ceiling, while an HTTP rejection is charged no output. A corrective request fits after one completed first pass within its ceiling, but prior billed retries or fallback iterations can consume that headroom. See `worker/src/cron/digest/llm-request.ts` for reservation and model-price accounting. This is a per-invocation output budget, not an enforced dollar or calendar-day cap; manual force-runs and weekly resumes have independent budgets, and server-side fallback may bill multiple model iterations inside one request. `stop_reason=max_tokens` remains a hard failure. Under the heavy profile the edition budget is `DIGEST_HEAVY_MAX_EDITION_OUTPUT_TOKENS` = 64000 (see below).
- **Generation profile:** `digest:llm-profile:daily` / `digest:llm-profile:weekly` in D1 cache select `standard` or `heavy`, once per edition through `resolveDigestLlmProfile()` in `worker/src/lib/digest-llm-profile.ts`. A missing, invalid or unreadable value selects standard. Heavy runs the standard draft (including its hard-issue corrective), then an independent evidence audit (`worker/src/cron/digest/heavy-review.ts`) against the same evidence packet, and, when audit/validators found issues, one writer revision with findings, validator notes and the last seven bodies. Audit verdicts are supported/unsupported/contradicted/misleading. Deterministic validators remain publication authority: more hard issues, unparseable revision, heavy-stage failure/refusal or time/token skip keeps the draft. Audit must start before half the 12-minute deadline, revision before 75%; both share a deadline 30 seconds inside it and never record circuit-breaker outcomes. `digest_meta.llm.profile`, `copyServedModel` and `digest_meta.heavy` retain profile, published-copy model, outcome, bounded findings/verdict counts and replaced draft.
- **Overload retries and dropped streams:** Anthropic `529 Overloaded` responses retry at most 2 times (3 attempts total), bounded by the 12-minute edition deadline. A stream that ends before `message_stop` is a dropped connection: its fragment is never parsed, and it is retried the same way while the edition budget still covers a full request.
- **Refusals:** requests enable Claude-API server-side fallback with `fallbacks: "default"` and beta header `server-side-fallback-2026-07-01`. This preserves streaming and one outer timeout; a client-side second-model call could overrun the 12-minute Anthropic, 14-minute cron, or 15-minute scheduled-trigger bounds after existing HTTP retries. After a mid-output handoff `message_start` still names the requested model, so the served model is read from the `fallback` content block and the `fallback_message` entry in `usage.iterations`. A final streamed refusal discards partial text, records nullable `stop_details.category`, publishes no edition, and does not affect the infrastructure circuit breaker.
- **Attempt telemetry:** [per-attempt audit fields](#llm-attempt-telemetry) survive in run metadata and successful editions; soft quality issues never fail a run.

Prompt assembly is owned by `worker/src/cron/daily-digest/prompt/`, factual supply rules by `worker/src/cron/daily-digest/prompt/policy.ts`, editorial registers by `shared/lib/editorial-style.ts`, and validation/vocabulary by `worker/src/cron/daily-digest/response.ts`. These sources own clause wording, density, structural and variety checks rather than a prose copy here. The pipeline retains these evidence/publication boundaries:

- Supply, TVL and vault NAV are different quantities. A supply contraction or mint/burn event alone proves no withdrawal, capital flight, lost backing or bank run. Preserve measured signals; causal attribution requires independent evidence, and protocol-internal deployment may burn base tokens without reducing protocol assets. The prompt cannot substitute TVL or double-count base tokens held by a wrapper.
- Editorial candidates use a total order: unsuppressed before suppressed; artifact risk `none` → `low` → `medium` → `high`; descending impact within each risk tier; then ascending stable candidate ID. Risk wins at every impact gap, for every kind; the pair-dependent 25-point window is not used. Lead selection respects that order among eligible candidates, not raw evidence, while suppression, corroboration and narrative eligibility remain intact. This policy applies prospectively without rewriting published editions. `shared/lib/digest-lead-policy.ts` separately owns critical depeg quotas: ≥2,500 bps on ≥$50M or ≥5,000 bps on ≥$10M bypass chronic suppression; ≤48h-old eligible criticals may hard-lead within two-consecutive/three-in-seven quotas. Fresh same-basis worsening ≥500 bps requalifies regardless of quota. Older unchanged/exhausted events require soft mention, not another headline; unresolved hard lead requirements block external delivery after retry. Severity uses fresh live deviation or explicitly flagged peak fallback.
- `nextTriggers` are conditions, never prior observations. A model may paraphrase an armed condition but cannot turn an unchanged threshold into measured narrowing. `changeSummary` and `forwardLookOutcomes` retain measured change and hit/miss/pending/unavailable distinctions.
- Map census prose requires complete capture-matched summary and canonical safety context. Quote only injected tier statistics and the depicted UTC date, including carry-forward; census is stock, while `gradeTransitions` alone establishes per-coin movement. Missing/partial/mismatched maps add no map language.
- Regime uses PSI, impact-weighted active depegs, gauge, FTQ and ALERT+ cap, not raw coin count. Every canonical `PsiConditionBand` has an exhaustive editorial regime and tape-tone mapping; MELTDOWN is CRISIS/critical, while the other established mappings are unchanged. Depegs older than seven days contribute only after worsening since the previous edition. Missing regime-critical evidence cannot certify CALM. Suppressed/chronic/weak signals cannot be dramatized into fresh crises.
- Validators bind required fields, structural/word budgets, lead requirements, evidence and safety copy before persistence. Soft forward-look/variety issues are telemetry-only, never grounds for retry/rejection; universal prose rules belong to the style gate.

**Factual numeric quality gate.** Bind price/deviation claims to one coin and the same current quote domain before severity. Compare each magnitude with the observed price and signed current deviation, not merely with the other claimed number: a self-consistent invented pair still hard-fails. Quote precision supplies rounding tolerance; no universal $1 peg is inferred, and dollar claims never bind native-unit evidence. Historical pairs and ambiguous amount roles/coins (supply, cap, flow or multi-coin sentences) remain advisory. One bounded corrective retry applies; unresolved hard copy is blocked with no delivery.

- **Output:** raw JSON `{ "title": "...", "extended": "...", "text": "...", "meta": { "lead": "...", "tone": "...", "coins": [...] } }` — no markdown fences

### Editorial style gate

The daily and weekly prompts derive their voice and register rules from [Pharos Editorial Style](./editorial-style.md) through `buildEditorialPrompt(register)` in `shared/lib/editorial-style.ts`. The prompt and scanner use the same policy records.

Pass 1 scans the model-owned `title`, `text`, and `extended` fields before any compatibility mutation or persistence. Each finding records its rule id, severity, field, excerpt, and position. Hard findings count as `would-block` events. Advisory findings feed telemetry and review and never block.

The gate mode comes from two validated D1 runtime values: `digest:style-gate-mode:daily` and `digest:style-gate-mode:weekly`. Each kind reads only its own key, and a missing or invalid value fails safe to `shadow` independently. The Access-authenticated `POST /api/trigger-digest` action accepts one explicitly scoped update, such as `{"styleGateMode":{"daily":"enforce"}}` or `{"styleGateMode":{"weekly":"enforce"}}`; an unscoped string, unknown kind, invalid mode, or two-kind update is rejected. The response returns the full effective `{daily, weekly}` state. No deploy is needed after these controls exist. For the selected kind, shadow keeps `stripForbiddenDashes` active after the trustworthy raw scan and does not block an edition on a style finding. Enforce disables the repair and lets unresolved hard findings block after the corrective retry. The repair covers the same U+2012 through U+2015 range as `no-clause-dash`.

Mode updates are mode-only: they write only the selected kind's key and never queue `digest:force-run-request`. Force-running a daily edition requires an explicit separate empty-body/`{}` trigger; it is not a weekly readiness sample. The next scheduled edition is the first enforced observation. A D1 read failure propagates rather than falling back to shadow. If the mode write commits but the subsequent read/response fails, reconcile both exact keys and the original idempotency record before a new mutation; an HTTP error is not proof of rollback.

The [shadow telemetry](./runbooks/blocked-digest-edition.md#read-shadow-telemetry) and [promotion/rollback](./runbooks/blocked-digest-edition.md#promote-or-roll-back-enforcement) contracts own bounded `digest_meta.editorialStyleGate`, complete first-pass booleans, readiness windows, continuity resets, approvals and kind-local changes. Missing/truncated detail is not clean evidence; never pool daily/weekly observations.

The corrective retry identifies the failed rule, field and excerpt, preserving unaffected fields. It skips after half the Anthropic timeout or without a full request's token headroom. Enforce telemetry retains skip reasons; shadow-only style findings never trigger correction.

Wrapper-owned findings are scanned under `delivery-wrapper` against the fully rendered X or Telegram payload immediately before send/enqueue. Model-owned spans are masked from this second enforcement decision because they have already passed their own mode-aware gate. A hard wrapper finding returns `skipped: editorial-style-wrapper` only for that channel, records bounded `wrapperEditorialAlerts` in cron metadata, and never calls the model. Telegram scans the cemetery appendix separately with the named `literal-cemetery` exemption; the remainder of the rendered payload receives no cemetery exemption. The Worker stores `editorialStyleVersion` and `editorialStyleHash` on each current edition, and the archive API returns those fields as copy provenance. Legacy editions without stored fields are surfaced as `pre-policy` at the API and UI read boundary. Archives remain historical record, byte-identical, and are never edited or retroactively tagged. See [`runbooks/blocked-digest-edition.md`](./runbooks/blocked-digest-edition.md) for operator triage.

## Failure handling

Daily and weekly generation return the same reasoned terminal outcomes: an open Anthropic circuit is `degraded` with `metadata.reason = "anthropic-circuit-open"` and `itemCount = 0`; missing Anthropic credentials intentionally skip paid generation as `skipped_neutral` with reason `missing-api-key`. A recent daily edition (`recent-digest`), insufficient current-week coverage (`insufficient-current-week-digests`), or unavailable assembled weekly input (`weekly-input-unavailable`) also returns a named neutral skip. These no-generation paths never advance `outputPublishedAt`. Missing required delivery-channel credentials retain their degraded delivery policy, and completed publication with only advisory quality findings remains successful with `metadata.quality`.

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

Staleness degrades without implying currency. PSI samples older than 2h record `psi-sample-stale`; fallback admits a completed daily observation window ending ≤24h ago, not a midnight key treated as publication time. Future clocks are rejected. Without either source, `stabilityIndex` is null and regime-critical `psi-unavailable` prevents CALM. PSI contributors older than 2h are dropped; stablecoins outside 600 seconds withhold live severity; yield rows older than 24h are filtered.

A failed read is never published as an optimistic observation. `classifyRegime()` floors the regime at WATCHFUL whenever `degradedSources` names the active-depeg, DEWS-stress, or Bank Run Gauge collector, so a collector that could not read cannot publish CALM; the risk tape prints "Unavailable" rather than "No active peg breaks" when the active-depeg query failed; and an absent prior DEWS generation publishes `yesterdayBandCounts: null`, which the prompt renders as "vs yesterday: unavailable" instead of an all-zero band distribution. On the weekly side, `rollupDigestInputs()` publishes `null` for every cross-day total that does not have all seven daily editions behind it, and the weekly prompt prints `N/A (n of 7 daily editions)` rather than a partial sum presented as a week. A coin without a `circulatingPrevWeek` bucket leaves both sides of the 7d supply aggregate instead of having its absent baseline published as full-size growth.

Weekly cross-day totals also require observed coverage **per metric**, not just seven edition rows. Active-depeg query failures withhold active observations; either active or resolved query failure withholds reconstructed unique signals; blacklist and grade-query failures withhold their respective totals. The input carries `metricUnavailableReasons` and the prompt names these reasons rather than publishing zero. Legacy missing blacklist accounting is unavailable because older editions omitted sub-threshold freezes. Healthy zero-event days now retain explicit accounting, while any unpriced events qualify the weekly dollar sum as an **at-least known subtotal**, never an exact affected total.

The resolved-depeg collector's window and its published label agree: candidates are bounded to `nowSec - ONE_DAY` and tracked ids are constrained in SQL without a row cap. Closure classification and observed market-cap/peak thresholds then run before the top-five presentation slice, so ineligible large-peak rows cannot crowd out a qualifying tracked recovery. Blacklist events whose amount could not be read publish as unknown rather than `$0`, and are not suppressed as zero-dollar activity.

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

Public read endpoints do not all share the same cache profile: `GET /api/daily-digest` and `GET /api/digest-archive` use the standard 5-minute edge profile, while `GET /api/digest-snapshot` is treated as archive data and uses `s-maxage=86400, max-age=3600`. The bounded homepage promo is site-only and uses the standard profile. The manual trigger endpoint is admin-only. See [API Reference](./api-reference.md) for public response shapes and [Worker Infrastructure](./process/worker-infrastructure-appendix.md#digest-promo-transport) for the internal promo transport.

| Endpoint | Description |
|----------|-------------|
| `GET /api/daily-digest` | Latest digest only, with compact `riskSignal`, `riskTape`, change/outcome summaries, and structured next triggers when stored input data has them |
| `GET /api/digest-archive` | Bounded interactive archive (latest 365 rows); `?history=all` opts into complete-history cursor pages, including compact PSI/mcap/risk summaries plus stored `riskTape`, `nextTriggers`, and forward-look outcomes parsed from input data |
| `GET /api/digest-promo` *(site-only)* | Latest public daily title, edition number, generation/UTC slug and rendered excerpt, plus at most two preceding daily title/number/generation/slug records; no full archive bodies or intelligence |
| `GET /api/digest-snapshot?date=YYYY-MM-DD` | Input data + depeg/blacklist context for a daily digest date — used by SSG detail pages; cached as archive data (`s-maxage=86400, max-age=3600`) |
| `GET /api/digest-snapshot?date=YYYY-MM-DD-weekly` | Selects the weekly row, then returns its last daily input as `inputData` and first daily input as `prevInputData`; depeg/blacklist context still covers the slug's UTC day, not the full week |
| `POST /api/trigger-digest` *(admin)* | Mode/profile-only controls persist independently without queueing generation. A separate empty-body/`{}` request defaults to daily; `{"kind":"weekly"}` queues weekly only on Monday UTC. Both generation requests return `202` after persisting a bounded latest-intent-wins D1 intent, not after running Anthropic or delivery. The five-minute scheduled poll executes under the selected job's lease and scheduled-event budget; the ordinary HTTP request must not carry long-running work. See [Distribution status logging](#distribution-status-logging) for claims, retry, dead-letter and outcome semantics, and [API Reference](./api-reference.md) for exact bodies/authentication. Automatic weekly recovery starts at 08:25 Monday UTC, capped at three generations including the 08:10 slot; an explicit weekly request has its own three-attempt cap. A weekly intent expires at the end of its requested Monday UTC (including delayed Monday-slot delivery), retaining `weekly-edition-expired` dead-letter/poll evidence without another generation or last-trigger-result update. Expected enqueue-to-poll latency is ≤5 minutes. |

On dated article pages, `DigestSnapshot` mounts its immutable date-keyed query only when its reserved `LazySection` reaches the viewport. The article itself remains static/crawlable; captured evidence and unavailable states are unchanged once the snapshot is admitted.

Snapshot responses add optional nullable `comparison` with the actual captured `fromDate` and `toDate` plus `supplyComparable`. Daily comparisons use the previous available daily capture, even across missed dates; weekly comparisons retain the stored first-to-last daily endpoints. Missing or invalid endpoint dates withhold the interval. Market-cap deltas require complete, nonempty coverage at both endpoints, the same aggregate universe and observed count, and matching nonempty membership fingerprints; two numeric amounts or equal counts alone never establish comparability. Legacy counts-only captures therefore retain qualified amounts but no total-change claim. Visible deltas name both endpoint dates, never assume “yesterday.”

The snapshot's seven-day amount and percentage use the producer's matched cohort (`mcap7dDeltaCoverage`), not the whole-market total. Its prior cap is `coveredMcapUsd - mcap7dDelta`; missing coverage or an empty cohort withholds the change, and a nonpositive prior cap withholds the percentage. The producer's underlying delta is unchanged.

`DigestSnapshotResponse.blacklistSummary` (`shared/types/digest.ts`) is an optional full unsuppressed UTC-day aggregate, independent of the latest 50-row `blacklistEvents` display sample. It publishes `totalEvents`, `valuedEvents`, `unavailableAmountEvents`, and nullable `knownAmountUsd`. With partially valued events, the USD value is only the known subtotal; when a nonempty day has no valued events it is `null`, not `$0`. A successfully observed empty day retains zero counts and `$0`. Legacy snapshots may omit the summary: totals and valuation are then unavailable, never reconstructed from the capped event sample. The current handler returns 503 if the aggregate row is absent.

Force-run enqueue is latest-intent-wins, not a queue: a new request replaces the single pending intent. Poll claims, terminal updates, malformed dead-letter writes and cleanup compare-and-swap the exact value read/claimed. Replaced runs record their own outcome without mutating the newer request.

Archive edition numbers are assigned independently for daily and weekly digests over the full non-blocked history before the response limit or cursor boundary is applied, with generation time and unique row id breaking ties. Internal sentinel rows retain their place in that history, while blocked rows never receive an edition number; therefore an older row leaving the response window cannot renumber an edition already published to X, Telegram, or a digest detail page.

Complete-history mode returns at most 365 scanned rows per page and adds `pagination` (`horizon`, `total`, cumulative `scanned`, and nullable `nextCursor`). The first page captures an insertion-id upper horizon; continuation requests use `history=all&cursor=<nextCursor>` unchanged. Later inserts, including backdated publications, are excluded from that traversal and admitted on the next refresh. Edition numbering uses the full history within the same horizon on every page. Sentinels are hidden from `digests` but remain in scan progress, so even an empty public page can require continuation. Malformed cursors return 400; a changed row census or missing continuation page returns 409 and requires a fresh traversal. This is insertion-stable traversal, not a snapshot of in-place editorial mutations. Query-aware cache identity keeps default and cursor responses separate; authentication and the standard cache profile remain unchanged.

Archive traversal errors (400 invalid mode/cursor and 409 changed history) explicitly return `Cache-Control: no-store`, so a rejected traversal cannot be reused as an archive page.

The promo applies its three-row bound only after numbering the full non-blocked daily history and hiding internal rows. Its current suffix preserves `/api/daily-digest`'s full daily count (including internal sentinels); prior leaves preserve archive per-row numbers and exclude the current generation/edition. Weekly and blocked editions never appear. A successful empty read returns `latest: null` with no invented producer clock; a failed or invalid read returns uncached `503` with `reason: "digest-promo-unavailable"`, never a successful empty archive. The current excerpt uses compact short copy, or only the first nonempty extended paragraph when short copy is blank.

An idle `digestTriggerPoll` with no pending force-run intent or due Monday recovery is a neutral conditional poll, not an omitted daily or weekly execution. Stale-slot reconciliation therefore creates no synthetic digest failure when neither child has durable progress. If a digest did start and left durable progress before losing ownership, the sweeper still records the real abandoned attempt using its original progress timestamps.

---

The digest archive projects only the final generation attempt’s recorded `servedModel` through the public `llm.servedModel` field and the build-time snapshot. Requested model configuration never fills missing provenance; historical editions without a recorded model keep the “Model not recorded” credit.

## Distribution

The daily digest never blocks on Safety Score map publication. A current manifest or one carried forward by up to two whole UTC days enables the dated map attachment; otherwise the digest still generates and delivers without map attachment or map prose. Attached and persisted URLs always use `manifest.date`, never `latest.png`, and carried-forward captions and prompts identify the date the poster depicts. A complete capture is resolved before generation so the same immutable `safetyMap` object feeds the prompt, stored web snapshot, and channel copy. Carry-forward is the fallback, not the plan: between 06:20 and 08:00 UTC the budget-only `safety-map-producer-kick` on the five-minute trigger poll dispatches the map workflow whenever the manifest is not today's, so the 08:05 edition normally carries today's map ([Safety Score Map](./safety-score-map.md#pre-digest-producer-kick)).

After the digest is stored in D1, it is posted to configured Twitter/X and Telegram channels. Delivery never removes the D1 digest record. The manifest's optional `mapSummary` enables deterministic channel prose only when its complete typed shape is valid and the digest has an available canonical Safety Score context. An absent, partial, malformed, or capture-mismatched summary still permits the image attachment but emits no map prose. Twitter/X persists a same-day delivery ledger (see below).

Existing-edition recovery reads durable X marker/ledger and Telegram outbox state, never weekly `digest_meta` delivery shadows. Missing X evidence refuses automatic resend; legacy X markers still mean already sent. Existing Telegram editions belong exclusively to the drain: resume does not reread appendices or rebuild payloads when the map changes. Daily generation and missing-outbox daily resume share one envelope builder for appendices, map/standing sections and credential diagnostics; unlike weekly recovery, the reviewed daily resume path may enqueue when no outbox exists.

### Web archive and sitemap policy

`/digest/` remains the primary indexable archive hub and links to every generated daily or weekly detail page present in `data/digests.json`. Every detail page stays live as a durable archive/citation page. Indexing is split (owner ruling, 2026-10-11): weekly recaps are always indexable and sitemap-listed; a daily edition is indexable and sitemap-listed only while it is within 30 days (`DAILY_DIGEST_INDEX_WINDOW_SEC`) of the newest checked-in edition, after which it emits `noindex, follow` and leaves `src/app/sitemap.ts` and the public route inventory. `isDigestIndexable` in `src/lib/digest-registry.ts` is the single authority; the reference clock is the newest edition's `generatedAt` rather than the wall clock so a given snapshot builds deterministically. The release SEO gate's archive-continuity check accepts a digest URL that leaves the sitemap while its HTML is still exported.

The interactive archive may narrow the visible wire table with URL-addressable `view` (`all`, `daily`, or `weekly`), `month`, and `q` (title/body search) parameters. These controls do not alter the server-rendered crawlable link index or the sitemap's digest membership.

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

**Files:** `worker/src/telegram/delivery/telegram.ts`, `worker/src/telegram/outbox/digest-outbox.ts`

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

Before the Telegram channel post is sent, `worker/src/cron/daily-digest.ts` also asks `worker/src/telegram/digest/digest-appendices.ts` for any pending deploy-diff notices. When present, those notices are appended beneath the digest body as expandable blockquotes:

- `New Cemetery Entries` for newly added cemetery rows
- `Tracking Changes` for newly tracked coins, split into live tracked vs pre-launch

Active tracked additions are queued earlier by `worker/src/cron/sync-stablecoins.ts`, which diffs the just-built stablecoins payload against the previous `stablecoins` cache before the cache row is overwritten. That queue is then consumed by the next successful Telegram digest post, so tracked additions are not lost when the digest appendix snapshot key is missing or has to be reseeded.

Appendix preparation returns deferred `successActions` for storage with the immutable edition; it applies only safe baseline seeds immediately, never delivery-success writes. The outbox alone commits those actions atomically with `sent` after accepted media and every text chunk. Each cache write repeats the terminal transition's exact edition/state/owner/generation/media/cursor predicate. Losing that fence changes neither appendix nor edition state; SQL failure rolls back the full batch. Failed, partial or ambiguous delivery therefore does not consume pending additions.

`digest-appendices.ts` uses cache keys `telegram:cemetery-snapshot`, `telegram:cemetery-footer-index`, `telegram:tracked-stablecoins-snapshot`, and `telegram:tracked-stablecoins-pending` (sync-stablecoins queues newly active tracked IDs). Seed/reseed identity snapshots without consuming queued tracked additions; append those on next successful post. Snapshot advancement is edition-bound and commits only after all exact chunks are accepted; retry reuses chunks and ambiguity preserves notices for reconciliation. Cemetery identity is stable dead-coin `id`; legacy `llama:*` and `symbol|deathDate|name` entries compare equivalent but new snapshots rewrite stable IDs only. Tracked identity is canonical Pharos ID.

Immutable edition storage, safety-identity admission (including the safety-free degraded exception), delivery states and terminal reconciliation belong to the [Telegram outbox contract](./runbooks/telegram-digest-outbox.md#contract). The five-minute digest-trigger slot drains due pending editions without rerunning Anthropic or re-rendering copy.

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

Daily and weekly channel outcomes are returned in scheduled-run cron metadata. `POST /api/trigger-digest` does not run delivery inline. A scoped `styleGateMode` update changes only that kind's runtime mode and returns `202` with `{ ok, accepted, styleGateMode: { daily, weekly }, message }`, without a force-run `requestId` or queued generation. An explicit separate empty-body/`{}` trigger defaults to daily; `{"kind":"weekly"}` selects the current Monday's weekly edition. Either enqueues a retryable force-run intent and returns `202` with `{ ok, accepted, kind, requestId, styleGateMode: { daily, weekly }, message }`; the 5-minute digest-trigger poll then writes each eventual result, including kind, to cron history and the `digest:last-trigger-result` cache entry. Transient failures remain pending with bounded backoff for up to three attempts; permanent or exhausted failures remain as a retained `dead_letter` intent, while a successful run clears the intent.

The poll consumes an attempt durably under the selected `daily-digest` or `weekly-recap` lease before generation or delivery resume, using an exact cached-intent compare-and-swap. Legacy intents without kind remain daily. Claim persistence failure starts no paid work; lease contention consumes no attempt. A terminated isolate leaves a counted `running` intent reclaimable after 15 minutes; at three consumed attempts the poll dead-letters it without another start. Settled failures retain that count rather than incrementing twice, and terminal writes/cleanup are fenced to the same claimed request.

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
**Schedule:** Mondays only in the `daily-0810` slot (`"10 8 * * *"`), with missed-edition recovery from the five-minute digest poll starting at 08:25 Monday UTC, after the primary slot's full 15-minute invocation budget. Recovery eligibility uses the scheduled slot timestamp even when delivery is delayed, and remains capped at three weekly generations per edition day including the 08:10 run.
**Dedup guard:** derives Monday and the edition date from the scheduled slot timestamp, returns `skipped_neutral` outside Monday UTC or when that scheduled day already has a non-blocked weekly row with no retryable channel, and retries only duplicate-safe channel states. Quality-gate, `execution_unknown`, and `failed_permanent` outcomes require review rather than blind channel replay.
**Period semantics:** most metrics summarize trailing daily editions available at the Monday 08:10 UTC start, not a strict Monday-Sunday calendar week. `digest_meta.periodType` remains `"trailing-daily-editions"`. Organic grade transitions alone use explicit closed-week event periods derived from that scheduled Monday: current `[todayTs - 7d, todayTs)`, prior `[todayTs - 14d, todayTs - 7d)`, where `todayTs` is scheduled Monday 00:00 UTC. `gradeTransitionPeriods` persists those bounds; delayed execution or missing editions never moves them.

### Data collection

Reads the latest non-blocked, non-weekly edition per UTC date in two seven-day windows: current `[todayTs - 6d, scheduledAt]`, prior `[todayTs - 13d, todayTs - 6d)`, at most 14 rows. Future editions are excluded. Both windows share aggregation. Safety fields and authored copy enter the prompt only when comparable with the active weekly model/schema/methodology/policy/build.

| Metric | Derivation |
|--------|-----------|
| PSI range | Min, max, start, end scores + dominant band (most frequent) |
| Market cap range | Start, end, net change, percentage change only from explicitly complete core-universe supply observations; otherwise unavailable |
| Active depeg observations | Sum of `activeDepegCount` across all days; explicitly not described as unique events |
| Unique depeg signals | Deduplicated full `depegSignalKeys` active/resolved identities collected before display filtering; unavailable if any edition lacks authoritative identities or a source read failed |
| Top depeg signals | Active and resolved signals sorted by absolute market impact |
| Weekly risk leaderboard | Unified ranking across depegs, DEWS, mint/burn pressure, blacklist, grade, yield, liquidity, and supply contraction. Depegs use live deviation when stored; active events predating the window are `carriedOver`, receive half severity, and render under **STANDING CONDITIONS** (one line each, never the headline). Only unsuppressed critical depegs **new this week** hard-pin the lead and outrank other signals |
| Spike metrics | Worst PSI/gauge day and independent maximum absolute depeg bps/impact across all observations, before leaderboard deduplication |
| Supply signals | Biggest weekly movers and daily velocity reversals/acceleration/deceleration |
| DEWS signals | Top band changes for presentation; max full ALERT+ mcap only when every daily edition has a complete supply census, otherwise unavailable. Sum full daily band-change counts as observations (not unique assets), unavailable if any edition lacks a count |
| Blacklist total | Sum of complete observed `blacklistActivity.eventCount`, known `totalAmountUsd`, and `unpricedEventCount`, independent of daily editorial promotion; unpriced events label USD as an at-least known subtotal; failed or legacy missing accounting withholds the total |
| Grade transitions | Distinct identities from complete V2 organic accounting comparable with the active model/policy/build, filtered by `recordedAt` into the scheduled half-open event period before deduplication across overlapping daily 48h captures. Totals require all seven editions and capture-window coverage of the full period. Legacy/malformed/incomplete accounting or unavailable canonical Safety withholds counts with a named reason, never reconstructs totals from top-five details; observed complete quiet weeks retain zero. Top transitions use the same event bounds, so an adjacent-period boundary event cannot appear in both weeks |
| Gauge range | Min/max `mintBurnFlows.gaugeScore` (null if <3 data points) |
| Other anomalies | Top mint/burn pressure, yield anomalies, and liquidity shifts |
| Forward-look scoreboard | Sum of daily `forwardLookOutcomes` statuses, retaining `unavailable` for audit; statuses are `{hit, missed, pending, expired, unavailable}`, but `unavailable` evidence is excluded from hit/miss denominators and never treated as a miss. The prompt instructs the recap to publish the score and own the misses |
| Week-over-week deltas | Seven prior UTC edition dates; unavailable below five rows. PSI midpoint/band stay null without observations; delta requires both measurements and carries PSI-day coverage. Market-cap and other comparisons remain independent |

Before these aggregates are built, archived daily signals are checked against the shared quarantine registry using the signal ingestion timestamp. A quarantined liquidity row and its canonical editorial candidate, trigger context, and archived authored headline/summary are withheld from weekly input. The weekly input records `liquidity-shift-quarantined-signal:<stablecoinId>:<date>` in `degradedSources`, distinguishing an explicit retraction from a quiet week. As a second fail-closed layer, weekly validation raises the hard `quarantined-signal-claim` issue if generated copy repeats a registered collapse/drain claim; the normal single corrective retry applies, then unresolved copy is stored with `qualityGate = "blocked"` and is not distributed.

Requires >=5 current-week daily digests to proceed. Prior-week coverage below 5 is tolerated; `weekOverWeekDeltas` is then `null` and the prompt notes the gap instead.

### LLM call

- **Model:** weekly typed configuration defaults to `claude-opus-5-5` with adaptive thinking + `high` effort; validated runtime overrides resolve at the shared scheduled invocation seam and invalid values fall back to checked-in weekly defaults.
- **Timeout:** the same single 12-minute LLM deadline per edition as daily; the scheduled weekly wrapper has a 14-minute cron lease, preserving about two minutes for persistence and two-channel delivery
- **Generation profile:** `digest:llm-profile:weekly` selects `standard` or `heavy` independently of daily, with the same audit, revision, and fallback contract as the daily **Generation profile** entry.
- **max_tokens:** 16000 with the same 32000-token edition budget (64000 under the heavy profile), hard truncation, dropped-stream handling, refusal fallback, provenance, and per-attempt telemetry contract as daily generation
- **Editorial style:** Weekly prose uses the same authority through `buildEditorialPrompt("weekly")`; its register and policy findings follow the staged style gate above.
- **Structure:** 4-6 paragraphs, 250-400 words: top unsuppressed Weekly Risk Leaderboard item as the week's headline, dominant story, counter-narrative, supply/capital flows, optional structural observation
- **Artifact policy:** Same suppression principle as daily. Weekly recaps separate repeated active observations from unique signals so chronic conditions are not counted as fresh events.
- **Critical lead validation:** the first unsuppressed critical depeg that is not `carriedOver` supplies the hard `leadSignalId` requirement; a carried-over critical never hard-pins the headline.
- **Variety:** Recent weekly recap metadata is supplied to avoid repeating the same weekly frame. Meta is normalized on the same contract as daily (allowed leads + tones); `repeated-lead-family` applies to weekly output too.

### Storage

Stored in the same `daily_digest` table. The `digest_meta` column includes `"type": "weekly"`, `"periodType": "trailing-daily-editions"`, `weekStart` and `weekEnd` date strings, the authored safety context and copy metadata, but no new delivery booleans or timestamps. Historical delivery fields remain inert bytes. The `input_data` column stores the `WeeklyInputData` aggregation (not raw `DigestInputData`) with the exact active safety identity or an explicit unavailable state.

### Distribution

Posted to both Twitter/X and Telegram. Twitter/X uses the distinct replay-safe ledger key `weekly-recap:twitter-sent:YYYY-MM-DD`; both channels attach the current or bounded carried-forward dated Safety Score map when available and otherwise publish without map prose or media. Telegram's title is prefixed with "Weekly Recap:" and the link uses the weekly route slug `/digest/YYYY-MM-DD-weekly/`. Existing weekly recovery reads only that X ledger and the immutable Telegram outbox; missing durable evidence is unknown and refuses resend. Confirmed retryable Telegram failures are drained every five minutes without another LLM call or enqueue; ambiguous or permanent outcomes stop for operator reconciliation.

---

## Frontend

### Archive lead preview

`src/components/daily-digest.tsx` reads the latest API edition through `useDailyDigest`; registered hook policy owns polling. It previews a complete first extended paragraph (short `text` fallback), with API-ranked risk evidence, never a mid-sentence clamp. Full persisted editions render in the dated server route, not this preview.

Search-title trimming is word-boundary/70-character bounded including date and suffix; published headline, article heading and structured-data headline remain intact. `text` stays the short metadata/distribution summary.

### Archive page

`src/app/digest/page.tsx` and `src/components/digest-archive-client.tsx` separate the checked-in crawlable index from interactive API views. `view`, `month` and `q` filters are URL-addressable but never remove server-rendered links or change sitemap membership. Every checked-in edition is reachable without JavaScript/API through the monthly native-disclosure index (no link prefetch), with matching CollectionPage/ItemList JSON-LD. Dated detail pages remain canonical Articles.

Trigger history keeps hit, missed, expired, pending and unavailable separate. Displayed hit share is `hit / (hit + missed + expired)`; pending/unavailable are excluded. Group by archived metric or an explicit unclassified bucket. A single-edition result is not site-wide accuracy evidence.

### Detail pages

`src/app/digest/[date]/page.tsx` statically generates `data/digests.json` entries; `src/components/digest-snapshot.tsx` reads the matching snapshot. Daily and `YYYY-MM-DD-weekly` slugs select independent row types, so same-day editions cannot shadow one another.

Render every published editorial paragraph and only captured, admitted intelligence/context. The stored map uses immutable `imageUrl`/`manifest.date`, never latest, with a validated deterministic tally; missing/failed posters or unusable snapshot context show unavailable states, not invented figures or silent disappearance.

Active depeg counts/top rows are edition evidence; day-overlap API rows remain separately labelled historical context and cannot replace publication counts. Captured `currentBps` requires stored `severityBasis: "current"`; fallback/legacy captures label historical peak/current unavailable. Blacklist counts/valuation cover the unsuppressed full day independently of the latest 50 displayed events, with latest-N-of-M and known-subtotal qualifiers; legacy missing summaries remain unknown.

Worker OG cards follow the same evidence boundaries: open incidents rank by fresh observed prices against their event reference, with historical peaks labelled separately and stale/missing quotes marked current unavailable. Recoveries admit only `recovered`/`legacy_recovered` closure classifications. The “observed at peg” numerator and denominator share the fresh canonical live peg-observation cohort (active, non-frozen, supply-observed, non-NAV assets), independent of DEWS rows and retained event counts; an empty/unavailable cohort displays N/A rather than a clamped subtraction.

OG source labels carry the actual market/quote, PSI, DEWS and safety generation clocks and their canonical freshness budgets. Stale or absent PSI is unavailable, not a zero score or healthy band. A stablecoin “24h” price delta requires a fresh latest daily snapshot and an exactly one-day-earlier priced snapshot; stale, undated or nonadjacent pairs are omitted even when the safety publication is fresh. Render time never renews a source observation.

---

## Static Generation Pipeline

**Script:** `scripts/maintenance/sync-digests.ts`
**Command:** `npm run sync:digests`

Fetches every page of `GET /api/digest-archive?history=all` from an explicit API source, validates a consistent horizon, total, monotonic scan progress and terminal cursor, then transforms the complete traversal to the `data/digests.json` format (`date`, `digestType`, `editionNumber`, `title`, `text`, `extended`, `generatedAt`, `editorialStyleVersion`, `editorialStyleHash`). The stored snapshot schema and published-slug shrink guard run before a same-directory temporary file is atomically renamed over the artifact. Missing pagination (including an old API's bounded response), interrupted or inconsistent traversal never replaces the snapshot; `--allow-archive-shrink` cannot bypass traversal completeness and is only for explicitly reviewed slug removals after a complete read. `--dry-run` performs all reads and validation without writing. Each style field is copied only when upstream carries a real value. If upstream returns `pre-policy` for display or omits a field, sync leaves that field absent; it never writes the sentinel into `data/digests.json` or back-fills archived rows. Weekly entries use a `YYYY-MM-DD-weekly` date slug so they cannot shadow daily entries for the same UTC day. The script accepts `--api-url`, an optional `--output`, and forwards `DIGEST_API_KEY` when set; it resolves its source from `--api-url` first, then `DIGEST_API_URL`, `SMOKE_API_BASE`, and `API_BASE_URL`, and fails with an explicit error when none of them is set rather than defaulting to any URL.

Each incoming page is admitted through the shared archive response schema with explicit legacy defaults for omitted nullable copy/metric fields. The final normalized projection must pass `DigestStoredSnapshotSchema` before the archive-preservation check or any write. Invalid JSON, malformed edition fields, invalid stored projections and pagination corruption raise `SnapshotIntegrityError`: `--allow-existing-on-fetch-failure` does not turn these deterministic failures into successful refreshes, and the existing artifact remains unchanged.

For local/manual use, point it at the intended environment explicitly:

```bash
npx tsx scripts/maintenance/sync-digests.ts --api-url https://ops-api.example.com
```

The scheduled/manual Pages refresh runs digest sync inside `.github/workflows/pages-release.yml`:

1. Every `pages-release` job traverses `GET /api/digest-archive?history=all` to completion and atomically writes normalized `data/digests.json` before `next build`. Code releases via `deploy-cloudflare.yml` use the same unconditional refresh, so a merge does not regress digest detail pages, the sitemap, and the RSS feed to the committed snapshot's age until the next scheduled rebuild. Deploy the URL-aware, query-keyed Worker API first, then refresh the generated digest snapshot and deploy Pages; never use the bounded interactive response or a shrink override as the static source.
2. Refresh failures use producer-scoped fallbacks: digest sync failure or archive shrink retains committed `data/digests.json`; depeg sync failure retains committed index/yearly shards; public-dataset failure rolls back only `public/datasets`. Total producer failure or failed public-dataset rollback stops the release (`shouldFailReleaseRefresh`); otherwise the build continues with warnings and still enforces the scores-latest mirror's two-day age limit.
3. The refresh calls `https://stablecoin-dashboard.pages.dev/_site-data`, whose Pages Function authenticates upstream requests to `site-api.pharos.watch`; it does not depend on the custom-domain edge path used by public traffic.
4. The scheduled `Rebuild Pages` workflow runs once at 08:17 UTC after the 08:05 UTC daily digest slot and provides another refresh opportunity after a release used a scoped fallback.

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

## Generation Implementation Appendix

### DEX liquidity admission gate

Aggregate producer abort guards cannot establish per-coin completeness. A partial pool inventory may pass global TVL, top-ten and row-coverage checks, so digest evidence requires its own admission layers.

DEX liquidity is a **single-source signal**: score, TVL, pool count, and the DEWS liquidity input descend from the same ingestion. Partial ingestion can therefore look like a coherent story. The four layers below provide producer visibility, collector comparability, editorial suppression, and publication validation; producer visibility alone does not withhold a claim.

**1. Producer visibility.** `computeDexLiquidityDriftSummary()` (`worker/src/cron/dex-liquidity/orchestrator-drift.ts`) confirms `major-tvl-cliff:<id>` at `qualityDriftSeverity: "high"` after two runs below 60% of a pre-event TVL baseline ≥$5M. Baselines cover published coins beyond the previous top ten and retain pending cliffs after a coin drops out. The run still publishes — the primary dataset must record real crises — while confirmed cliffs reach cron metadata, the status drift line, and the `/api/dex-liquidity` `199` warning on runs 2–6.

**2. Collector admission — comparability only.** `admitLiquidityShift()` (`shared/lib/digest-liquidity-admission.ts`) decides whether a history pair is a comparable measurement of the same thing on two adjacent days. Every rule is decidable from the pair itself:

| Rejection | Rule |
|---|---|
| `non-adjacent-snapshots` | The rows are not exactly 86,400s apart |
| `methodology-basis-change` | `methodology_version` differs: a recompute is not a market move |
| `non-trendworthy-coverage` | Either row fails `isTrendworthyLiquiditySnapshot()` (fallback class or confidence <0.75), or carries a non-finite measurement |

A rejected pair produces **no signal at all**, recorded as `liquidity-shift-<rejection>` in `degradedSources` so a withheld story is distinguishable from a quiet day. Admitted shifts carry `coverageClass`, `coverageConfidence`, `tvlChangePct`, and `expectedScoreDeltaFromTvl`.

Magnitude is deliberately **not** an admission rule. A large drop is either a partial snapshot or a genuine crisis, and nothing in the pair distinguishes them; the collector has no access to prices, flows, or supply. Rejecting on magnitude here would discard real drains unread — exactly the events Pharos exists to report.

**3. Editorial corroboration.** A liquidity candidate is suppressed unless an **independent pipeline** agrees on the same coin: an active depeg (prices), mint/burn pressure (transfer flows), or supply evidence (a supply-velocity signal, or being the week's largest supply mover). DEWS is deliberately excluded — its liquidity signal reads the same `dex_liquidity` rows, so a band move can be the artifact agreeing with itself. Market cap sizes a story and never corroborates one; the system prompt said otherwise until this change.

Magnitude is judged here because corroborating evidence is available. An uncorroborated drop past `UNCORROBORATED_TVL_DROP_RATIO` (40%) is suppressed as an `unverified single-source DEX TVL collapse` at `artifactRisk: "high"`; its raw evidence is marked UNVERIFIED and may not be stated as fact in lead or body. An independently corroborated collapse is not suppressed.

Liquidity impact, DEWS band moves and ALERT+ breadth use a per-$1B market-cap basis consistent with depeg impact. Artifact-risk tiers outrank impact at any gap for every candidate kind, including liquidity/yield; their independent corroboration requirement is unchanged.

**4. Publication gate.** `validateDigestModelOutput()` raises hard `suppressed-lead` when `meta.leadSignalId` names a suppressed candidate: one corrective retry, then unresolved copy is blocked with no X or Telegram delivery.

**Retraction propagation.** New-edition admission cannot retroactively validate archived evidence. `shared/lib/digest-signal-quarantine.ts` owns confirmed contaminated signals keyed by stablecoin, family and inclusive ingestion window; weekly collection and validation apply that registry without rewriting published daily history. Scope is the contaminated ingestion, not an entire date or coincidentally matching number.

Coverage does not rescore liquidity. Composite score movement need not be proportional to TVL; prompt `tvl-implies` carries the expected contribution rather than implying a mismatch proves misconduct. Do not hold per-coin primary publication or impose a magnitude cap that rejects independently corroborated crises: these gates prevent an unverified editorial claim, never observation of a real crisis.

### Flow provenance details

New captures retain mint/burn `provenance`: the producer's exact `window` (`start`, `end`, `semantics: "closed-utc-hours"`), cache publication timestamp `publishedAt`, and independent body clock `updatedAt`. The producer has no unique flow-generation ID; equal-timestamp republications may replace a cache row, so its publication clock is not such an identity and no synthetic ID is inferred. The data-quality window is labelled **24 closed UTC hours** and uses the same source boundaries even for admitted stale publications or collection across an hour boundary. Absent or unreadable legacy window/clock provenance stays null and the prompt names the window unavailable; collection time never reconstructs it. Existing archived editions are not rewritten.

### LLM attempt telemetry

- **Attempt telemetry:** every original, corrective, and HTTP attempt records requested/served model, effort, ceiling, input/cache/output tokens, fallback handoffs, per-model `usage.iterations`, attempt identities, stop reason, refusal category, latency, HTTP status, and computed cost (summed across iterations at each model's rates) in cron progress/run metadata. Successful editions also store the full attempt list under `digest_meta.llm`. Soft quality codes, such as `missing-forward-look`, never fail a run; they are recorded per run in `cron_runs.metadata.quality.issues`.
