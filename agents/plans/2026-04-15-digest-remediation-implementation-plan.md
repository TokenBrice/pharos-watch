# Daily And Weekly Digest Remediation Implementation Plan

Date: 2026-04-15

Status: plan reviewed, zero known plan issues, ready for execution.

## Goal

Remediate the daily and weekly digest issues identified in `agents/audits/2026-04-15-daily-weekly-digest-audit.md` so digest generation is more selective, artifact-resistant, structurally informative, entertaining without forced drama, and safer to publish.

## Success Criteria

- Daily prompt lead selection is driven by pre-ranked editorial candidates, not raw section order.
- Opus receives explicit artifact, chronic-condition, freshness, degraded-source, and reader-value instructions.
- Active/resolved depeg ranking uses absolute market impact.
- Regime classification is impact-weighted and less count-sensitive.
- Weekly recap receives structured weekly signal leaderboards, not only daily headlines and summaries.
- Weekly recap period semantics are explicit as a trailing digest-edition window.
- Weekly Telegram links point to weekly digest slugs.
- Digest snapshot API distinguishes daily and weekly rows for the same date.
- Model output is validated before distribution, with one corrective retry.
- Daily variety uses normalized metadata and excludes weekly rows from the daily variety window.
- Docs and tests cover the changed contracts.

## Implementation Scope

### Shared Types

- Extend `DigestInputData` in `shared/types/digest.ts` with:
  - `dataQuality`
  - `editorialCandidates`
  - richer `topDepegs`, `dewsStress.bandChanges`, and `resolvedDepegs` fields.
- Add reusable candidate types for `kind`, `novelty`, `confidence`, and `artifactRisk`.

### Daily Data And Prompt

- Add `worker/src/cron/daily-digest/editorial-candidates.ts`.
- Generate candidates from depegs, PSI, supply velocity, mint/burn, DEWS, grade transitions, yield anomalies, liquidity shifts, blacklist activity, and supply/mcap context.
- Include suppressed/noisy candidates so Opus knows what not to lead with.
- Add `dataQuality` and window labels to the prompt.
- Move editorial candidates above raw evidence sections.
- Replace forced ominous calm language with a "selection first, style second" rule.
- Add artifact/chronic-condition rules.
- Exclude weekly digests from daily recent-meta variety context.

### Daily Collector Fixes

- Rank active depegs by `ABS(peak_deviation_bps) * mcap`.
- Include active depeg `startedAt`, `ageHours`, `direction`, `impactScore`, and `suppressReason`.
- Rank resolved depegs by absolute deviation before limiting.
- Add separate supply acceleration and deceleration rules.
- Change blacklist activity to a rolling last-24h window, matching prompt language.
- Add mcap to DEWS band changes so regime/candidate scoring can use affected size.

### Regime Classification

- Change `classifyRegime()` to use impact-weighted active depeg pressure and ALERT+ mcap, not only raw counts.
- Exclude suppressed/chronic active depegs from regime escalation unless impact is high.

### Model Response Quality Gate

- Make digest response schema require non-empty `title`, `text`, and `extended`.
- Normalize model-authored `meta` values.
- Strip title prefixes from `text` during parse.
- Add validation profiles for daily and weekly output:
  - title word count
  - extended paragraph count
  - extended word count
  - combined title + text length
  - JSON parse/raw fallback status
  - code-fence absence
  - title/lead/primary-coin repetition against recent meta
- Add one corrective retry inside the Anthropic request path.
- If quality issues remain after retry, store a degraded row but skip social posting.

### Weekly Recap

- Expand weekly input aggregation:
  - active depeg observations versus unique depeg signals
  - top depeg signals by absolute impact
  - top supply velocity and weekly supply movers
  - top DEWS changes/elevated mcap
  - blacklist totals and top events
  - gauge range and pressure extremes
  - grade transitions, yield anomalies, liquidity shifts
- Update weekly prompt to use these weekly signals and artifact policy.
- Make period language "trailing daily editions" explicit.
- Add recent weekly metadata to discourage repeated weekly framing.
- Pass `YYYY-MM-DD-weekly` to Telegram link generation.

### Snapshot/API/Delivery Fixes

- Update `handleDigestSnapshot()` to filter target rows by requested digest type:
  - `YYYY-MM-DD` => non-weekly only
  - `YYYY-MM-DD-weekly` => weekly only
- Query previous daily row separately for daily snapshots.
- Order snapshot depeg events by absolute deviation.
- Treat Telegram digest date parameter as a route slug and document weekly slug behavior.

### Documentation

- Update `docs/digest-pipeline.md` for:
  - editorial candidates
  - data quality notes
  - response validation and corrective retry
  - rolling blacklist window
  - weekly trailing-edition semantics
  - weekly Telegram slug behavior
  - expanded snapshot card/data source notes if needed.

### Tests

- Update/add tests in:
  - `worker/src/cron/__tests__/daily-digest.test.ts`
  - `worker/src/cron/__tests__/weekly-recap.test.ts`
  - `worker/src/api/__tests__/digest-snapshot.test.ts`
  - `worker/src/lib/__tests__/telegram.test.ts`
  - `worker/src/lib/__tests__/twitter.test.ts` if output length behavior is touched.
- Test fixtures:
  - active below-peg event outranks smaller above-peg event
  - chronic/small depeg is marked suppressed and not regime-driving
  - prompt includes data-quality notes and editorial candidates
  - supply deceleration is emitted
  - malformed/underfilled model response causes corrective retry
  - unresolved quality issues skip social posting
  - weekly aggregation labels active observations separately from unique signals
  - weekly Telegram link uses `-weekly`
  - snapshot API returns daily vs weekly rows correctly on same date.

## Execution Order

1. Implement shared type and daily collector changes.
2. Implement editorial candidate builder and prompt restructuring.
3. Implement response validation/retry and social skip semantics.
4. Implement weekly aggregation/prompt/delivery changes.
5. Implement snapshot API filter/order changes.
6. Update docs.
7. Update tests.
8. Run targeted tests:
   - `npm test -- worker/src/cron/__tests__/daily-digest.test.ts worker/src/cron/__tests__/weekly-recap.test.ts worker/src/api/__tests__/digest-snapshot.test.ts worker/src/lib/__tests__/telegram.test.ts worker/src/lib/__tests__/twitter.test.ts`
   - `cd worker && npx tsc --noEmit`
9. If targeted verification passes and time allows, run `npm run lint`.

## Plan Review Loop

### Review 1 Findings

1. **Issue: response validation could be too strict for existing test fixtures and production model variance.**
   - Fix: use validation profiles with one corrective retry and store-but-skip-social fallback only after retry. Update fixtures to valid editorial-length copy.

2. **Issue: weekly "unique depeg events" cannot be perfectly reconstructed from older stored daily rows.**
   - Fix: label the reconstructed metric as "unique depeg signals" and keep "active observations" separate. Use `startedAt` where present, fall back to symbol/direction/bps for older rows.

3. **Issue: editorial candidates could duplicate raw evidence and bloat the prompt.**
   - Fix: cap prompt candidates to top non-suppressed entries plus a short suppressed/noise list. Keep raw sections as support.

4. **Issue: daily recent-meta query currently includes weekly rows.**
   - Fix: change query to use `NON_WEEKLY_DIGEST_SQL_FILTER`.

5. **Issue: strict social skip could hide a useful digest from readers because of a minor word-count issue.**
   - Fix: classify validation issues as hard and soft. Corrective retry handles both, but final social skip triggers only for hard issues or severe structure failures.

### Review 1 Corrections Applied To Plan

- Added hard/soft validation semantics to the response quality gate.
- Added legacy-safe "unique depeg signals" wording.
- Added candidate caps.
- Added explicit daily variety filter.
- Added store-but-skip-social only for unresolved hard/severe quality issues.

### Review 2 Findings

1. **Issue: no plan item covered docs for the changed weekly period semantics.**
   - Fix: documentation scope now includes trailing-edition semantics.

2. **Issue: no plan item covered snapshot API depeg ordering.**
   - Fix: snapshot/API scope now includes absolute depeg ordering.

3. **Issue: no plan item covered tests for prompt data-quality notes.**
   - Fix: daily test fixtures now include prompt assertions for data-quality notes and editorial candidates.

### Review 2 Corrections Applied To Plan

- Added docs item for trailing weekly period.
- Added snapshot depeg ordering item.
- Added daily prompt test fixture item.

### Final Review

Known critical issues: 0

Known high issues: 0

Known minor issues: 0

The plan is ready for implementation.

