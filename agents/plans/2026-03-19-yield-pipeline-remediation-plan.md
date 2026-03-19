# Yield Pipeline Remediation Plan

Date: 2026-03-19
Scope: Remediate all issues found in the yield pipeline audit, while prioritizing correctness, deploy safety, and coverage expansion.

## Objectives

1. Eliminate correctness bugs that can corrupt, hide, or mislabel yield data.
2. Make degraded upstream inputs non-destructive.
3. Expand coverage for missing yield-bearing assets without weakening source quality.
4. Make deploy and post-deploy validation yield-aware instead of generic.

## Delivery Tracks

### Track A: Correctness Hardening

Status:
- Partially implemented in this changeset.

Completed:
- Preserve wrapper-relevant DeFiLlama pools through ingestion filters.
- Separate deterministic on-chain rows from curated rows via `onchain:<id>` source keys.
- Restrict previous-rate lookup to rows with non-null `exchange_rate`.
- Keep rankings rows alive during incomplete live safety hydration.
- Tolerate malformed `warning_signals` JSON in `yield-history`.
- Label `defillama-auto` rows with protocol-derived source/type fields.
- Preserve retained benchmark fallback state.

Remaining:
- Preserve deterministic history continuity across the `onchain:<id>` source-key change.
  - Add a deploy-safe compatibility path or backfill so old on-chain history continues to power 7d/30d metrics, previous-best source tracking, and source-switch detection until legacy rows age out.
  - Add a regression test where newer curated rows coexist with older deterministic history.
- Gate stale-row deletion on input health.
  - Track successful evaluation at row identity level (`stablecoin_id`, `source_key`), not just source-family level.
  - Only purge rows that were positively reevaluated as absent in a healthy run.
  - If inputs are degraded or a row was not reevaluated, retain the prior row behind bounded TTL and degraded provenance instead of deleting.
- Couple yield freshness to successful rankings-cache publication.
  - Add an explicit health bit or ops freshness check for `yield-rankings` cache age vs latest worker run.
- Correct price-derived annualization and freshness rules.
  - Annualize from actual elapsed days, not an assumed 30-day window.
  - Require freshness/window checks on both price endpoints.
  - Then expose whether price-derived used a full window, thinner history, or degraded freshness in provenance.
- Add a hard benchmark freshness ceiling for all benchmark-dependent calculations, not only retained-fallback states.
- Use one canonical peer benchmark for `yield-divergence` warnings and public benchmark context so stored warnings and surfaced metrics cannot disagree.
- Any change in yield resolution, warning logic, benchmark semantics, or scoring must also bump:
  - `shared/lib/yield-methodology-version.ts`
  - `docs/yield-intelligence-timeline.md`
  - the matching methodology copy in `src/app/methodology/methodology-sections.tsx`

Validation:
- Extend `sync-yield-data` integration coverage around degraded-input retention.
- Add ops/API smoke that asserts rankings freshness and representative row presence.

### Track B: Coverage Expansion

Status:
- Audit complete; implementation deferred except for wrapper-filter recovery.

Targets:
- Recover missing live coverage for:
  - `usyc-hashnote`
  - `cetes-etherfuse`
  - `pusd-polaris`
  - `usg-tangent`
- Review unmapped yield-bearing backlog:
  - `usdb-blast`
  - `thbill-theo`

Approach:
- Re-audit DeFiLlama native pools, wrappers, and possible deterministic on-chain sources.
- Prefer native or deterministic sources over discovered lending substitutes.
- Only add static overrides when upstream matching cannot be made reliable by existing logic.
- Update `/about` only if a truly new external data source is introduced.

Validation:
- Add regression coverage for every new pool map, variant map, on-chain config, or rate-derived config.
- Verify live ranking presence after deploy.

### Track C: API and Frontend Contract Alignment

Status:
- Partially implemented in this changeset.

Remaining:
- Align the shared `YieldHistoryResponse` contract with the actual worker response.
- Make source-aware history mode first-class in the frontend:
  - `mode=best` must mean the historical-best series with source-switch markers.
  - Default chart behavior for a selected ranking row must fetch that row's exact `sourceKey`.
  - Alt-source UI must be able to switch the chart to the chosen alt `sourceKey`.
  - Keep warning-signal rendering intact for alternate sources.
- Replace metadata-only yield detail gating with a stable eligibility contract.
  - Render whenever a ranking row exists.
  - Otherwise show degraded or empty state for assets in an explicit yield-eligible registry.
  - Do not use `yieldBearing` alone as the hide/show gate.
- Add missing protocol source-link overrides where discovered protocols are already in use.
- Update the verified docs in the same phase as contract and frontend changes:
  - `docs/api-reference.md`
  - `docs/yield-intelligence.md`
  - `src/app/methodology/methodology-sections.tsx`

Validation:
- Shared runtime schema for yield history used by both worker tests and frontend consumers.
- API tests for malformed `warning_signals`, invalid `mode`, missing `sourceKey`, and unrated-row fallback semantics.
- Frontend tests around history mode and section visibility.

### Track D: Deploy and Operations Hardening

Status:
- Audit complete; implementation deferred.

Work:
- Add an executable rollout split for yield-affecting releases.
  - Worker/API changes ship first through a worker-only path.
  - Pages/frontend changes ship only after worker output and cache freshness are verified.
  - For any public response-shape change, require one of:
    - backward-compatible worker output,
    - a shadow/canary API route,
    - or a feature-flagged cutover that keeps the current frontend insulated until Pages catches up.
  - This split is mandatory for yield changes that affect worker output, cache semantics, or public response shape.
- Add a yield-specific blocking smoke stage after worker deploy and after pages deploy.
  - Assert `yield-rankings` returns data.
  - Assert representative coins cover deterministic, curated, discovered, and rate-derived paths.
  - Assert benchmark provenance and safety hydration fields are present.
- Improve operator freshness checks so a fresh worker run cannot mask a stale `yield-rankings` cache.
- Add degraded-yield-run alerting to the ops surface.
- Update runbooks and verified docs in the same phase:
  - `docs/deployment-process.md`
  - `docs/testing.md`
  - any operator/status doc that defines yield freshness review
- For manual prod rollout, require:
  1. worker deploy,
  2. blocking worker/API smoke passes on fixed canaries,
  3. first affected cron run observed with go/no-go checks on `status`, `fallbackMode`, `validationFailures`, `cacheWriteSkipped`, `rowsWritten`, and public cache freshness,
  4. pages deploy verified by blocking post-pages smoke,
  5. next two affected cron runs reviewed against the same checklist.

Validation:
- CI smoke scripts with explicit ownership and blocking placement before and after Pages deploy.
- Manual production runbook with explicit stop conditions for `degraded`, stale cache, missing canaries, or skipped cache publication.

## Sequencing

### Phase 1

- Finish correctness hardening, deterministic-history compatibility, and the minimum deploy/ops protections required to ship yield safely.
- Land explicit docs and methodology updates for any contract or deploy-flow change in the same phase.
- Phase 1 production deploys are limited to backward-compatible correctness hardening only.
- No broader yield expansion or public-contract rollout proceeds until row-level non-destructive retention and rankings-cache freshness coupling are complete.
- Ship only after full local verification passes.

### Phase 2

- Implement row-level non-destructive degraded-input retention and rankings-cache freshness coupling.
- Expand yield-specific smoke coverage and alerting beyond the minimum Phase 1 gate.

### Phase 3

- Close the remaining yield-bearing coverage gaps with targeted config or resolver work.
- Align frontend and shared contracts with source-aware history.

### Phase 4

- Add operator alerts and additional UX transparency improvements.

## Risks

- Coverage expansion can increase false positives if symbol fallback is widened carelessly.
- Non-destructive retention must not let truly removed sources linger forever; retention needs a bounded policy and clear degraded provenance.
- Yield-aware smoke checks should stay representative and cheap, otherwise they will be bypassed operationally.

## Refinement Log

### Revision 1

Issues closed:
- Split the plan into correctness, coverage, API/frontend, and ops tracks so operational hardening does not get lost behind source-map work.
- Promoted destructive stale-row deletion to the top unresolved risk.
- Added explicit validation requirements per track instead of a generic “test everything” instruction.

Open issues after revision 1:
- Need external critique on whether sequencing and deploy controls are specific enough for the current production workflow.

### Revision 2

Issues closed:
- Added deploy-safe deterministic-history continuity work to avoid cold-starting on-chain metrics after the `onchain:<id>` key change.
- Tightened stale-row retention from source-family logic to row-identity logic.
- Reframed price-derived remediation as a correctness fix, not just provenance decoration.
- Made benchmark freshness, warning benchmark consistency, frontend history semantics, and detail-section eligibility explicit.
- Moved minimum yield-specific deploy/ops protections into Phase 1 and defined worker-first rollout, blocking smokes, canaries, and stop conditions.
- Added mandatory docs/runbook deliverables to Tracks C and D.

Open issues after revision 2:
- Re-run critique to confirm no medium-or-higher gaps remain.

### Revision 3

Issues closed:
- Clarified that Phase 1 deploys are restricted to backward-compatible correctness hardening.
- Made row-level retention and rankings-cache freshness coupling explicit gates before any broader yield rollout.
- Added worker-first rollout compatibility requirements for public response-shape changes.
- Added explicit yield-methodology version and timeline update requirements for any methodology-impacting change.

Open issues after revision 3:
- None above low severity after final critique pass.
