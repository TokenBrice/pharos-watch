# Safety Score Implementation Audit

Date: 2026-04-15

## Scope

Audited the Safety Score path from methodology docs through shared scoring code, worker snapshot assembly, API exposure, history snapshots, and primary frontend consumers.

Primary files reviewed:

- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `shared/lib/report-card-*.ts`
- `shared/lib/report-cards.ts`
- `shared/lib/reserve-templates.ts`
- `shared/lib/redemption-backstop-scoring.ts`
- `shared/types/report-cards.ts`
- `worker/src/lib/report-cards-snapshot*.ts`
- `worker/src/lib/safety-scores.ts`
- `worker/src/api/report-cards.ts`
- `worker/src/cron/snapshot-safety-grade-history.ts`
- `worker/src/api/safety-score-history.ts`
- `src/hooks/use-stress-test.ts`
- `src/components/methodology/safety-score-calculator.tsx`
- report-card consumers in Chains, Yield, portfolio/stress, stablecoin detail, and daily digest paths

## Assumptions

- This is an audit only. No production scoring logic was changed.
- Suggested cleanup should preserve scores unless explicitly listed under score-changing concerns.
- Current methodology v6.96 is the reference contract.
- The checked-in data corpus and live production snapshots are useful for impact estimates, but impact can change as prices, depegs, and dependencies change.

## Short Answer

The implementation is generally well-structured and much healthier than a single monolithic scorer: the public export shell is thin, the main scoring families are split, API and grade-history share the same snapshot builder, and the current core test coverage catches many score-critical paths.

It is not yet as clean or robust as this product area deserves. The main weaknesses are not broad code quality problems; they are a few policy ambiguities and scattered contracts that can silently affect scores:

- active-depeg policy is split between peg scoring, report-card caps, and redemption availability
- dependency-risk behavior for partially unavailable upstream scores is under-specified
- redemption freshness is not treated as explicitly as DEX freshness inside report-card liquidity
- stress-test recomputation is direct-dependent only despite product copy promising cascading effects
- report-card freshness and dependency metadata are too thin for a score this sensitive

## Score-Changing Concerns

These should not be changed casually. Each one needs an explicit methodology decision, impact diff, and changelog/version bump if fixed.

### 1. Legacy active-depeg peg cap still mutates the peg score before the multiplier

Code:

- `shared/lib/report-card-peg-liquidity.ts:16-21` caps `peg.pegScore` at 65 whenever `peg.activeDepeg` is true.
- `shared/lib/report-card-overall.ts:46-49` then uses that capped peg dimension as the multiplier input.

Methodology conflict:

- `docs/report-cards.md:37` says Peg Stability is a direct passthrough of `computePegScore()`.
- `docs/report-cards.md:10-11` and `docs/report-cards.md:31-33` describe a peg multiplier plus separate active-depeg final caps.

Why this matters:

- `computePegScore()` already applies an active-depeg penalty from the open event's peak severity.
- The extra report-card cap is an additional legacy penalty.
- The detail text says "capped at C", but score 65 maps to `B-` under current thresholds.

Live impact estimate from production on 2026-04-15:

- Removing only this legacy cap would increase `USDA` from 58 to about 61.
- Removing only this legacy cap would increase `meUSD` from 58 to about 59.
- Other currently active depeg rows I checked were unchanged because their peg score was already <= 65 or their final score was already 0.

Recommendation:

- Treat this as a likely methodology/code drift, not a cleanup.
- Before changing it, run a full before/after report-card diff over all active and cemetery cards and decide whether v6.97 should remove the cap or whether the docs should explicitly restore it as intended behavior.

### 2. `activeDepegBps` uses current deviation, while redemption impairment uses open-event peak deviation

Code:

- `worker/src/lib/report-cards-snapshot-card.ts:105-107` sets `activeDepegBps` from `peg.currentDeviationBps`.
- `shared/lib/report-card-overall.ts:57-64` applies final D/F caps from that value.
- `worker/src/lib/redemption-backstop-availability.ts:34-44` uses `depeg_events.peak_deviation_bps` for severe active-depeg redemption impairment.

Why this matters:

- A still-open depeg can have a severe peak but a currently milder deviation.
- Report-card final caps and redemption impairment can disagree for the same open event.

Live impact estimate from production on 2026-04-15:

- `EURS` has an open event peak of 1232 bps, but report cards expose `activeDepegBps = 319`; if final caps used active event peak, its current score would be capped from 52 to 49.
- `UUSD` has an open event peak of 1517 bps and `activeDepegBps = 640`, but current overall is already 0, so the cap source does not change the live score right now.

Recommendation:

- Pick one explicit source of active-depeg severity for Safety Score: current deviation or open-event peak.
- If the answer is peak, derive `activeDepegBps` from `depeg_events` or carry active-event peak through `PegSummaryCoin`.
- If the answer is current deviation, update docs and ensure redemption impairment intentionally differs.

### 3. Dependency risk silently ignores partially unavailable upstream scores

Code:

- `shared/lib/report-card-dependency.ts:39-50` filters dependencies to only those present in `overallScores`.
- `shared/lib/report-card-dependency.ts:52-54` falls back to 70 only when all dependencies are unavailable.
- `shared/lib/report-card-dependency.ts:56-65` then treats the missing dependency weight as self-backed because `rawTotal` is computed from resolved dependencies only.

Methodology:

- `docs/report-cards.md:263-265` says dependency score uses declared upstream weights and falls back to 70 if dependency scores are unavailable.

Current impact:

- Checked live `/report-cards`: there are 148 dependency graph edges and 0 edges from an unresolved upstream score.
- Checked the local stablecoin corpus: no missing dependency ids, no dependency cycles, and no dependency-weight totals above 1.

Potential impact:

- If a future upstream dependency becomes `NR`, downstream scores can be inflated because that upstream's declared weight becomes self-backed rather than conservative/unavailable.

Recommendation:

- Add a policy decision and tests for partial upstream unavailability.
- Conservative score-changing option: weight missing dependencies at 70 or make the whole dependency dimension 70 when material upstream weight is unavailable.
- Score-preserving preparation: expose `missingDependencyWeight` in detail/raw diagnostics without changing formula yet.

### 4. Redemption freshness is not gated inside report-card liquidity

Code:

- `worker/src/lib/report-cards-snapshot-inputs.ts:75-89` suppresses DEX liquidity when the snapshot is unavailable or older than 3600 seconds.
- `worker/src/lib/report-cards-snapshot-inputs.ts:59-66` hard-fails only if redemption map loading rejects.
- `worker/src/lib/redemption-backstops-store.ts:390-411` loads all current redemption rows without max-age filtering.

Why this matters:

- The standalone redemption endpoint has freshness handling, but report-card liquidity can continue using stale redemption rows if the redemption cron stops updating but the table remains readable.
- Adding a stale cutoff would lower scores for coins whose Liquidity / Exit dimension currently receives redemption-only value or redemption uplift during a stale redemption snapshot.

Recommendation:

- Do not change the scoring behavior without an incident-policy decision.
- Score-preserving first step: include redemption snapshot age/status in report-card response metadata and status surfaces.
- Score-changing option: suppress stale redemption inputs the same way stale DEX inputs are suppressed, with a changelog entry.

### 5. Stress-test recomputation is not transitive

Code:

- `shared/lib/report-card-overall.ts:87-94` marks only cards directly depending on overridden ids as affected.
- `shared/lib/report-card-overall.ts:96-130` maps once over the cards and never propagates newly recomputed downstream scores into further downstream dependencies.

Docs:

- `docs/report-cards.md:363` says users can "watch cascading grade changes."

Current behavior:

- Existing tests explicitly assert direct-only behavior.
- This does not affect live Safety Scores, but it can understate simulated contagion.

Recommendation:

- If the product promise is cascading contagion, recompute affected nodes in topological order over the dependency graph until no downstream score changes.
- This will change simulated stress results only, not live report-card scores.

## Score-Preserving Maintainability Work

These are good cleanup targets that should not change scores when implemented carefully.

### A. Introduce explicit score snapshots / golden fixtures

Add a small locked fixture set that exercises:

- no-dep centralized / decentralized / centralized-dependent
- NAV token with neutral peg
- NAV wrapper with inherited peg
- active depeg around 999, 1000, 2499, 2500 bps
- DEX-only liquidity
- redemption-only liquidity
- DEX + redemption blend
- low-confidence and impaired redemption exclusion
- dependency wrapper / mechanism / collateral ceilings
- partial dependency availability once policy is decided

Use these as "score contract" tests around `computeOverallGrade`, `scoreLiquidity`, `scoreDependencyRisk`, and `buildReportCardsSnapshot`.

### B. Centralize active-depeg policy

Currently related rules live in:

- `shared/lib/report-card-core.ts` for D/F final caps
- `shared/lib/report-card-peg-liquidity.ts` for severe redemption uplift exclusion
- `worker/src/lib/redemption-backstop-availability.ts` for route impairment
- `shared/lib/peg-score.ts` for active-depeg penalty inside pegScore

Add a small shared policy module that names:

- active-depeg severity source
- D/F cap thresholds and scores
- severe-redemption impairment threshold
- whether the legacy peg-dimension cap exists

This can be done score-preserving by moving constants and tests only.

### C. Make dependency scoring diagnostics explicit

Without changing score math, have `scoreDependencyRisk()` detail include:

- declared dependency count and declared weight
- resolved dependency count and resolved weight
- missing dependency ids/weight
- whether any wrapper/mechanism ceiling applied

This makes future data/source regressions visible before they become score debates.

### D. Split scoring output from display copy

`scorePegStability()`, `scoreLiquidity()`, `scoreResilience()`, and `scoreDependencyRisk()` currently compute scores and build prose detail strings in the same functions.

Recommended path:

- Keep current scorer return shape for compatibility.
- Internally return structured facts first, then format `detail`.
- Start with peg/liquidity because those carry the most policy branching.

This should be score-preserving if tests assert identical scores and, where needed, compatible details.

### E. Add dependency freshness metadata to report-card snapshots

`buildReportCardsSnapshot()` uses `stablecoinsCached.updatedAt` as snapshot `updatedAt`, while the score also depends on depeg events, DEX liquidity, redemption backstops, and live reserves.

Score-preserving improvement:

- Add `dependencies` metadata with source ages/status:
  - stablecoins cache
  - depeg/peg analytics source time
  - dex liquidity latest
  - redemption latest
  - live reserves scoring-eligible count/fallback count
- Keep `updatedAt` behavior unchanged until consumers are ready.

### F. Own `report_card_cache` from the report-card/safety pipeline

The cache used by `/api/chains` is written by `sync-yield-data`:

- `worker/src/cron/yield-sync/state-loading.ts:289-299` computes the safety snapshot.
- `worker/src/cron/sync-yield-data.ts:96-104` writes `report_card_cache`.
- `worker/src/api/chains.ts:125-131` consumes `report_card_cache`.

This couples Chain Health quality freshness to the yield cron. A score-preserving structural improvement is to publish the same cache from `snapshot-safety-grade-history` or a dedicated report-card cache task, with yield continuing to read/refresh live scores as needed.

### G. Align internal snapshot types with public schema

`worker/src/lib/report-cards-snapshot.ts:34-35` types dependency graph edges as `{ from; to }`, while the public schema requires `{ from; to; weight; type }` in `shared/types/report-cards.ts:151-160`, and the envelope builds weighted typed edges at `worker/src/lib/report-cards-snapshot-finalize.ts:100`.

This is harmless at runtime but weakens TypeScript help in worker consumers. Import and use `DependencyGraphEdge` or the shared response type.

### H. Broaden doc-sync checks for policy details

Current doc sync verifies version, weights, peg exponent, no-liquidity penalty, and grade thresholds in `scripts/lib/doc-sync/checks.ts:66-121`.

Add checks for:

- active-depeg cap thresholds and cap scores
- "direct passthrough" vs active peg cap policy
- redemption severe-depeg threshold
- no-liquidity penalty ordering

This would have caught some of the active-depeg ambiguity earlier.

### I. Tighten methodology calculator copy or controls

`src/components/methodology/safety-score-calculator.tsx:52-56` says it uses the same production formula. It does use `computeOverallGrade()`, but it does not model NAV neutrality, missing liquidity penalty cases, active-depeg caps, or upstream dependency derivation.

Score-preserving fix:

- Change copy to "same overall combiner" or add toggles for NAV, no-liquidity, and active-depeg cap.

## What Looks Solid

- The core scorer is now split into focused modules instead of living in one hotspot.
- API and grade-history use the same `buildReportCardsSnapshot()` path, reducing drift.
- DEX liquidity stale/unavailable handling is explicit and score-safe.
- Live reserve passthrough has conservative gating: independent evidence, `ok` sync state, freshness, and scoring-eligible freshness mode.
- Blacklist inheritance now uses fixed-point resolution rather than a single traversal pass.
- Local stablecoin data validation passes, and my dependency scan found no cycles, missing dependency ids, or overweight dependency totals.
- Public schema validation exists for report-card API responses.

## Verification Performed

Commands run:

```bash
npm test -- shared/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts worker/src/lib/__tests__/safety-scores.test.ts worker/src/api/__tests__/report-cards.test.ts
npm run check:doc-sync
npm run check:stablecoin-data
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "SELECT stablecoin_id, symbol, peak_deviation_bps, started_at FROM depeg_events WHERE ended_at IS NULL ORDER BY ABS(peak_deviation_bps) DESC LIMIT 20"
```

Results:

- 5 focused test files passed, 90 tests passed.
- Doc sync passed.
- Stablecoin data validation passed.
- Production active depeg rows were inspected to estimate active-depeg policy impact.
- Live `/report-cards` and `/peg-summary` site-data responses were inspected to estimate score impact of active-depeg policy differences.

## Suggested Order Of Work

1. Decide active-depeg policy first. It is the most visible score-changing ambiguity.
2. Add golden score fixtures before changing any score behavior.
3. Add score-preserving diagnostics/freshness metadata for dependencies and redemption.
4. Move active-depeg constants/policy into one shared module.
5. Fix the stress test if "cascading" is the intended product promise.
6. Move `report_card_cache` ownership out of yield sync.

