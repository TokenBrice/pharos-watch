# Meridian Consumer-Ledger Handoff

Date: 2026-07-15
Scope: Safety Score V9 consumer-ledger T1 through T4.
Release state: V8 remains the only active public model. No push was performed.

## Implementation Record

| Item | Status | Commit / files | Coordinator review |
| --- | --- | --- | --- |
| C01 | packet | `meridian-decision-packet-2026-07-15.md` | Choose an active V9 wire contract; V8 endpoint remains compatible. |
| C02 | packet | `meridian-decision-packet-2026-07-15.md` | Choose native V9 renderer and review visual/content output. |
| C03 | packet | `meridian-decision-packet-2026-07-15.md` | Approve V9 grade/risk buckets and dimension disposition. |
| C04 | not touched | Out of assigned T1/T2 scope | Remains OPEN for V9 dependency-edge projection. |
| C05 | not touched | Out of assigned T1/T2 scope | Remains OPEN for V9 access/evidence projection. |
| C06 | packet | `meridian-decision-packet-2026-07-15.md` | Approve selector adapter and thresholds before implementation. |
| C07 | not touched | Out of assigned T1/T2 scope | Remains OPEN for V9 portfolio semantics. |
| C08 | not touched | Out of assigned T1/T2 scope | Remains OPEN for V9 stress-state evaluator. |
| C09 | packet | `meridian-decision-packet-2026-07-15.md` | Approve V9 radar/cohort policy before implementation. |
| C10 | packet | `meridian-decision-packet-2026-07-15.md` | Review A- membership diff before enabling a V9 roster floor. |
| C11 | hardened/tested | `daf5a08f8`, `c12019dd6`; yield producer, API hydration, audit provenance | Live hydration accepts ordinary publication-generation changes only when the V8 model/schema/methodology/build identity still matches; a changed build or model fails closed. Approve V9 numeric formula diff before activation. |
| C12 | hardened/tested | `5216908b5`; `worker/src/api/__tests__/chains.test.ts` pending regression coverage | Complete current V8 identity is exposed; raw/enveloped V9 cache input is rejected. Future V9 bands remain a decision. |
| C13 | not touched | Existing alert projection already fails closed for non-V8 | Remains OPEN for model-neutral alert envelopes and V9 explanations. |
| C14 | hardened/tested | `c12019dd6`; Telegram command/context/status files | Canonical V8 reads replace recomputation and legacy status history; V9 remains explicit unavailable until C01/C02. |
| C15 | groundwork/tested | `3eda22f52`; V2 history types, writer, API, migration `0204` | Generic V9 row/boundary writer requires an explicit previous identity for organic rows; V8 compatibility reads remain restricted to V8 rows. Active V9 source/cutover operation remains pending. |
| C16 | hardened/tested | `3eda22f52`; pending `shared/types/tape-event.ts`, `worker/src/lib/tape-event-helpers.ts`, `worker/src/api/__tests__/events.test.ts`, `worker/src/lib/tape-projectors/__tests__/score.test.ts`, `worker/src/cron/__tests__/project-tape.test.ts` | Organic events carry complete identity; identity-less V9 rows are skipped. The public tape schema now rejects malformed score provenance and V2 legacy-unidentified rows fail closed. |
| C17 | hardened/tested | `c12019dd6`; digest collectors/input/types | Canonical V8 read and V2 organic history replace recompute/legacy reads; V9 editorial facts remain pending. |
| C18 | hardened/tested | `5216908b5`; pending `worker/src/api/__tests__/og.test.tsx` foreign-V8/raw-V9 regression coverage | Incomplete/mismatched identity produces explicit degraded output and no aggregate re-grade. |
| C19 | hardened/tested | `5216908b5`, `3eda22f52`; pending `worker/src/cron/__tests__/snapshot-public-dataset.test.ts` V9 identity regression coverage | Complete current V8 identity is persisted/exposed; future V9 immutable contract awaits C01. |
| C20 | packet | `meridian-decision-packet-2026-07-15.md` | Remove/review V9 resolver anchors before implementation. |
| C21 | hardened plus packet | `c12019dd6`; pending `worker/src/api/mint-burn-flows.ts`, `worker/src/api/__tests__/mint-burn-flows.test.ts`, `worker/src/cron/daily-digest/prompt.ts`, `worker/src/cron/daily-digest/digest-risk-tape.ts`, `worker/src/cron/__tests__/daily-digest.test.ts` | Fresh and cached aggregate responses reconcile against the live complete current V8 cache; cache-read, completeness, or identity failure disables FTQ and adds an explicit warning. Fresh cache-read failure now also returns zero FTQ flows rather than a 500, and digest facts render the classification as unavailable with its reason. V9 FTQ classes are intentionally deferred. |
| C22 | hardened/tested | `daf5a08f8`; yield coverage audit | Audit uses only complete identified compact cache and defers otherwise. |
| C23 | hardened/tested | `5216908b5`, `c12019dd6`; pending `worker/src/lib/status/derived-data.ts`, `worker/src/lib/status/__tests__/derived-data.test.ts`, `worker/src/lib/__tests__/canary-checks.test.ts`, `worker/src/lib/__tests__/publication-contract.test.ts` | A generic surface-publication row is accepted only when it exactly matches the live complete current V8 report-card cache; otherwise the surface degrades. A report-card cache read failure now degrades `datasetFreshness.safetyGrades` to `null` instead of failing the whole status response. V9 active-model expectation awaits C01. |

## History Safety Review

The adversarial pass found and corrected a history-writer regression before
handoff. Exact provenance includes base-input and publication-generation IDs,
but those change during ordinary refreshed V8 publications. The daily writer
now uses a separate semantic comparability check for organic history: model,
schema, methodology, evaluation build, and, for V9, policy ID/digest. A changed
base input or publication generation is retained on the new row but does not
create a false cutover. A model, schema, methodology, build, or policy mismatch
remains suppressed pending an explicit boundary baseline.

The V2 writer also rejects an organic cross-model or cross-policy comparison
unless the caller establishes an explicit boundary baseline. Legacy-compatible
history projection only includes persisted V8 rows, so organically written V8
V2 rows stay visible without allowing V9 rows into the V8 contract.

## Public Contract Follow-Up

`/api/safety-score-history-v2` is routed and typed, but it was intentionally
not added to `public/openapi.json` or generated documentation in this pass.
The requested scope prohibited documentation changes other than the migration
manifest and agent output. Keep this as a C15 activation/documentation follow-up
before treating the endpoint as a broadly advertised public contract.

## Final Hardening Follow-Up

The final regression pass added narrowly scoped working-tree changes for C12,
C16, C18, C19, C21, and C23. They cover raw/enveloped V9 rejection, malformed
score-event provenance, fresh and legacy FTQ cache failure, unavailable digest
presentation, and report-card cache failure in the status freshness path.

These changes are intentionally not committed yet. The required worker-wide
TypeScript command is blocked only by the unrelated untracked file
`worker/src/lib/__tests__/safety-score-v9-veritas-bounded-gap-repro.test.ts`
at line 38, where a union member does not guarantee `componentKey`. No scoped
source error remains, and no unrelated data or Veritas file was edited.

## Verification

- `npx tsc --noEmit` passed.
- `cd worker && npx tsc --noEmit` is blocked only by the unrelated untracked
  Veritas test named above; all scoped Worker source type errors are clear.
- `npm run check:migrations` (133 migrations; 132 active, 1 retired)
- Worker consumer-path suite: 30 files and 461 tests passed, including
  history/API/FTQ, tape, Telegram, daily digest, yield, snapshot, publication,
  and status behavior.
- Root consumer/UI suite: 24 files and 192 tests passed.
- `npm run check:worker-boundary` and `npm run check:shared-cycles` passed.
- `npm run check:openapi` completed with the existing generated artifacts;
  see the public-contract follow-up above for the deliberately deferred V2
  endpoint listing.
- `git diff --check` passed.

## Ranked Handoff

1. Approve C01 first. It defines the active V9 source and determines when
   current V8-only fail-closed consumers can safely receive V9 data.
2. Decide C03, C06, C09, C10, C20, and C21 from the packet using their required
   consumer-specific diff artifacts.
3. Define the bounded C15 activation, rollback, and restoration operation that
   calls the generic boundary writer with the approved active V9 identity.
4. Implement V9 renderers/projections for C02/C04/C05/C07/C08/C13 after the
   active wire contract and decisions are approved.
5. Re-run consumer-specific V8/V9 diff review and record it in the ledger.

## Ledger State

No ledger row can flip from `OPEN` yet. The ledger requires both an implemented
V9 disposition and reviewed material V8/V9 diff evidence; all relevant rows
still have `Diff: pending`, and the decision-dependent items above deliberately
have no implementation. C11/C12/C14/C15/C16/C17/C18/C19/C21/C22/C23 have
compatibility hardening and focused tests ready for the next activation wave,
but remain OPEN until those gates are met.

---

## Meridian II Implementation Append

Date: 2026-07-15
Release state: implementation complete in dark/shadow form. V8 remains active.
No activation, rollback, restoration, deployment, push, or live score change was
performed.

### Commits

- `ddc83c24c0007e1a5d600591589cc17cc968cf18` - strict V9 report contract,
  cache projection, public route, OpenAPI generator coverage, and bounded C15
  history operation.
- `a5ae35739be458f7e49b005b6da4d28e93485a92` - dark V9 renderer, three-pillar
  radar, consumer projections, and identity-bound selector snapshot.
- `c5401b8fe4f0e7012632c0ac60fcbc2844c64579` - model-aware C13 alerts, C20
  depeg resolver provenance, and C21 flight-to-quality classification.
- `1398a376f897f7a3d2a88ace4283f887f7bc00c8` - deterministic cache-purge
  retry-boundary regression.

### Item Status

| Item | Meridian II disposition | Remaining coordinator evidence |
| --- | --- | --- |
| C01 | Implemented: `/api/report-cards/v9` has a strict standalone public schema, canonical V9-only cache source, full identity, 503 unavailable behavior, and no V8 fallback. `/api/report-cards` remains V8. | External compatibility review and activation approval. |
| C02 | Implemented dark: native V9 renderer shows score, grade, three pillars, caps, reasons, evidence, access, and dependencies without V8 dimensions. | Visual/content diff review. |
| C03 | Adopted dark: V9 score/grade/three-pillar rows; B- and above safe, C+/C/C- neutral, D/F risky; temporary score/grade only. | Membership and rank diff review. |
| C04 | Implemented dark: native dependency graph projection with explicit unavailable/mismatch states. | Dependency graph diff review. |
| C05 | Implemented dark: V9 access, evidence, and freeze projection; registry fallback is labeled and does not count as V9 evidence. | Coverage and evidence diff review. |
| C06 | Implemented dark: native V9 selector rows, omitted unmappable V8 dimensions, full identity in the immutable hash/snapshot, recommendations deferred. | Grade/rank diff and 88/threshold review. |
| C07 | Implemented dark: identity-coherent weighted portfolio score and three pillars, dependency exposure, and fail-closed missing/NR behavior. | Portfolio output diff review. |
| C08 | Implemented dark: explicit `v9-stress-mapping-unapproved` unavailable result; no V8 scenario reuse. | Scenario mapping decision and diff review. |
| C09 | Implemented dark: three-pillar radar with exact model/policy/publication cohort matching; mixed V8/V9 cohorts are rejected. | Radar/cohort visual diff review. |
| C10 | Implemented dark: explicit `v9-bluechip-floor-unreviewed` unavailable result; no inherited V8 floor. | Reviewed roster membership diff. |
| C13 | Implemented opt-in: model-neutral alert identity, V9 evidence/cap/weakest-pillar explanations, and reseed across semantic identity boundaries. Active dispatcher remains V8. | Alert sample and transition diff review. |
| C15 | Implemented but not routed: bounded `activate-v9`, `rollback-v8`, and `restore-v9` history boundary operations require an exact full identity and canonical model source. | Dry run, transition review, and explicit execution approval. |
| C20 | Implemented: DDR safety provenance must be complete current V8 before numeric 85/70 anchors are enabled; V9, stale, missing, or mismatched identity suppresses them. | Resolver outcome diff review. |
| C21 | Implemented opt-in: V9 B-+ safe, C band neutral, D/F risky with full identity/completeness checks. Active API and digest remain explicitly V8. | Flow and digest diff review. |

All listed rows remain `OPEN` in the consumer ledger because implementation is
only one gate. The required consumer-specific V8/V9 diff reviews and activation
approval have not occurred.

### C15 Activation Runbook

The operation below is a reviewed execution plan, not an executed record.

1. Freeze and record the exact V8 and proposed V9 source/output/policy/build
   artifacts, full publication identities, Worker and Pages deploy IDs, and
   reviewed consumer diffs. Confirm no required ledger row remains `OPEN`.
2. Retain a known-healthy V8 Worker and Pages deployment. Complete a non-live
   rollback drill using the same exact-identity inputs.
3. Deploy the approved activation-capable Worker. Before selecting V9 anywhere,
   verify the canonical V9 cache variants and strict `/api/report-cards/v9`
   response converge on the recorded full identity within the bounded window.
4. Invoke the bounded `activate-v9` history operation once with the verified V9
   identity and explicit boundary timestamps. Verify the expected inserted row
   count, non-comparable boundary semantics, and null previous identity. Reseed
   alert comparison state at the same semantic boundary.
5. Deploy the approved V9-aware Pages artifact. Verify each consumer against its
   reviewed diff, full identity, unavailable behavior, and refresh boundary.
6. Observe the agreed stabilization window. Do not delete V8 artifacts or the
   retained deployments during that window.

Rollback order:

1. Record the incident, current full identities, and deploy IDs. Keep incoherent
   consumers fail-closed.
2. Restore the retained V8 Worker, verify canonical V8 compute/read behavior and
   V9 rejection on V8-only paths, then republish the bounded V8 artifacts.
3. Invoke `rollback-v8` exactly once with that verified V8 identity. Verify the
   boundary row and reseed alert comparison state.
4. Restore the retained V8 Pages deployment and verify all derived surfaces.
   Preserve the failed V9 artifacts and evidence; do not destructively clean up.

Restoration order:

1. Produce and review a new canonical V9 publication with a new exact identity.
2. Deploy and verify the corrected V9 Worker while V8 remains selected.
3. Invoke `restore-v9` exactly once with the new verified identity and reseed
   comparisons at the restoration boundary.
4. Deploy/select the reviewed V9 Pages artifact only after all dark projections
   match the new identity and required diffs.

### Verification Addendum

- Strict V9 route/cache/history suites: 5 files, 23 tests passed.
- Dark renderer/radar/consumer suites: 4 files, 13 tests passed; selector and
  descriptor focused suites also passed.
- Model-aware alert/DDR/FTQ suites: 9 Worker files, 180 tests passed; shared DDR
  suite: 39 tests passed.
- Root and Worker TypeScript checks passed.
- Worker-boundary and shared-cycle checks passed.
- OpenAPI, Postman, and API-reference generated-artifact checks passed.
- Isolated C15 route coverage reached 100% lines; the boundary operation reached
  92.85% lines. The deterministic purge-cache suite passed all 8 tests.
- The aggregate critical-coverage run reached the enrolled suites but remains
  blocked by an unrelated concurrent V9 candidate expectation (expected 81/A-,
  observed 69/B-). No candidate engine, score, policy, or live grade was changed
  by Meridian II.

## Coordinator amendment — activation gate (2026-07-15)

The versioned endpoint shipped reachable pre-activation (review flag on
ddc83c24c). The coordinator added an owner-gated D1 activation marker:
`/api/report-cards/v9` returns 404 until the cache key
`safety-score-v9:public-activation` exists. ACTIVATION RUNBOOK ADDITION:
writing that key (any value) is now step 0 of activation; rollback deletes
it. The C21 FTQ grade-set predicate and C20 DDR source swap in c5401b8fe are
implementations of the owner-adopted packet decisions and ship live with the
next release (expected FTQ classification shifts).
