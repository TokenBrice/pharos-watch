# Safety Score V9 Rollout

> **Current state:** pre-release shadow preparation. Safety Score v8.17 remains
> the only public model. The current V9 candidate is not activation-ready, and
> the unavailable ratified release-coverage proof is an explicit hard blocker.

This document is the durable rollout contract for Safety Score V9. It replaces
the dual-live-publication mechanics that were explored during implementation;
it does not weaken the V9 methodology, evidence, calibration, coverage, or
independent-validation gates documented in
[Safety Score V9 Readiness](./safety-score-v9-readiness.md).

## Decision

Pharos will privately shadow V9 before release and operate one public Safety
Score model after release. The deployed Worker build selects the active model.
Rollback restores the retained V8-compatible Worker and Pages deployments; it
does not depend on continuously recomputing and publishing V8 beside V9.

The rollout deliberately has no:

- runtime active-model selector;
- publication epoch or model-family pointer;
- continuously warm V8 cache family after V9 activation;
- public `?model=v8` rollback switch;
- parallel live V8/V9 yield, chain, selector, alert, or dataset families; or
- online release-authorization state machine.

The existing `/api/report-cards` contract has sustained external-client
traffic. It remains the V8 contract during migration. V9 will use a genuinely
versioned endpoint, with any compatibility overlap owned as a dated API product
decision rather than rollback machinery. The unversioned route must never
silently change to a V9 payload; its post-activation V8 freshness or deprecation
must be decided and tested before activation.

## Architecture

Before cutover, the quarter-hourly report-card job performs these steps:

1. build and validate one exact fixed input;
2. compute and atomically publish canonical V8 full, compact, fixed-input, and
   alert projections;
3. only after that transaction succeeds, run the private V9 candidate in a
   separate caught failure domain; and
4. retain the latest candidate/diff plus one compact daily shadow row.

A V9 load, compile, evaluation, serialization, or persistence failure is
observable but cannot roll back, suppress, delay, or mark the V8 publication
failed.

After activation, the same canonical keys contain only V9 projections. The
Worker does not compute V8. Every canonical payload carries strict model,
schema, methodology, evaluation-build, base-input, and publication-generation
identity so a restored V8 Worker rejects V9 cache data instead of interpreting
it as V8.

## Shadow Storage

The private latest entries are:

- `report-cards:v9-shadow`: latest strict candidate envelope;
- `report-cards:v9-shadow:diff`: latest V8/V9 movement report.

Both rows use checksum-verified gzip/base64 storage envelopes with strict
stored, compressed, and uncompressed byte bounds. Readers validate the outer
V9 identity before returning the unchanged semantic candidate or diff and
remain compatible with legacy plain canonical rows during a rolling deploy.
Selected replay artifacts are capped at 12 MiB uncompressed and 1,900,000
base64 payload bytes so later verification remains within the Worker memory
budget.

`safety_score_v9_shadow_daily` stores one compact row per UTC day. A row records
successful and failed attempt counts, the selected run identity, exact-set and
coverage evidence, movement/review counts, qualification, selected artifact
keys, and a bounded latest error. A failed run does not prevent a later retry
from becoming that day's selected success.

Normal successful runs do not retain a full replay bundle. Content-addressed
exact input, fact set, policy, evaluation-build manifest, and result artifacts
are retained only for bounded selected evidence:

- the first qualifying day of a frozen-identity streak;
- the first day that completes the qualifying window, exactly once for that
  uninterrupted frozen-identity streak; and
- an explicitly selected non-qualifying anomaly used in the release decision.

Routine non-qualifying runs do not build replay blobs. This keeps the scheduled
shadow path bounded. The quarter-hourly caller does not request anomaly
retention; that capability is reserved for a separately coordinated evidence
invocation and is not an online admin selector.

The slowest score-bearing producer cadence is four hours. The gate proves
elapsed producer coverage and source-generation diversity from the compact
daily rows: it does not archive a five-artifact replay bundle every four hours.

Routine attempt-level operations remain in cron telemetry. Human movement
reviews remain append-only evidence; they do not control the active model.

## Pre-Activation Gates

Activation is prohibited until all V9 correctness gates and the prospective
shadow gate pass for one frozen candidate identity. The shadow window must
include at least 14 consecutive UTC days and at least two elapsed cycles of the
slowest score-bearing producer. That producer cadence is four hours.

Every counted day requires:

- at least one successful selected candidate;
- the same candidate, policy, evaluation-build, compiler/fact-schema, producer
  capability, release-coverage policy, and consumer-threshold registry identity
  throughout the window;
- exact active-ID bijection with no duplicates, missing IDs, or unexpected
  IDs;
- no compiler exceptions or accepted future-dated facts;
- all ratified V9 coverage floors passing;
- no unresolved release blocker, critical movement, candidate defect, or
  consumer-threshold review;
- at least two distinct observed and archived generations for both
  `liveReserves` and `redemption`;
- replayable archived evidence for the selected first and final days, plus any
  anomaly explicitly admitted to the release evidence set;
  and
- no V9 regression that blocks or corrupts V8 publication.

A policy, compiler, scorer, fact-schema, or score-bearing producer-capability
change restarts the window. Ordinary point-in-time market or evidence changes
do not restart it, but must satisfy the same daily gates.

The read-only gate replays the selected content-addressed artifacts itself:

```bash
npm run safety-score-v9:shadow-gate -- \
  --summaries <shadow-daily-export.json> \
  --artifacts <shadow-artifact-export.json>
```

The implementation lives at
`worker/scripts/check-safety-score-v9-shadow-gate.ts`. The CLI does not accept
caller-asserted replay status. Its result supports an operator release decision;
it cannot authorize or switch production at runtime.

The current candidate remains a hard no-go because it rates no active assets,
has unresolved critical evidence gaps, lacks a wired and passing
`ratified-release-coverage` proof, and has not accumulated the prospective
window. Shipping shadow infrastructure does not advertise methodology `9.0`.

## Compatibility Release

Before activation, production must run a V8-compatible release that provides:

- strict V8 model and schema identity on canonical full, compact, fixed-input,
  and alert projections;
- a frontend parser and renderer for complete V8 and V9 contracts;
- model-aware history and alert boundary behavior;
- a versioned V9 API contract without changing the existing V8 endpoint; and
- explicit model provenance and mismatch behavior for every materialized score
  consumer.

History writes organic changes only within one model identity. Activation and
rollback append non-comparable boundary baselines with null previous values;
legacy history and tape responses exclude those boundary rows rather than
implying a continuous score series.

Safety alert source and prior-snapshot identities must agree. A model or
methodology change seeds a new baseline without emitting an organic
upgrade/downgrade fan-out. Safety alerts fail closed while canonical safety
identities disagree; unrelated alert families continue.

## Consumer Contract

Every first-party consumer of score, grade, V8 dimensions, or report-card
caches must record:

- its V8 fields and policy assumptions;
- its V9 pillar, cap, evidence, access, score, or explicit-removal mapping;
- its schema or methodology impact;
- reviewed material diffs;
- fail-closed or explicit degraded behavior on model mismatch;
- its maximum natural refresh delay; and
- focused contract and regression tests.

The tracked inventory and activation blockers live in the
[Safety Score V9 Consumer Ledger](./safety-score-v9-consumer-ledger.md). Every
`OPEN` row in that ledger blocks activation.

No derived cache may silently combine V9 scores with V8 thresholds or labels.
During shadowing, V9 consumer diffs are offline/admin evidence only. Parallel
live V9 derived-product families are not published.

Derived surfaces must converge after activation or rollback within one
documented producer interval and remain explicitly degraded in the meantime.
A surface that cannot meet that target may gain one bounded authenticated
republish operation; it does not justify a general dual-model controller.

## Activation

V9 activation is an ordinary versioned deployment after all gates pass:

1. freeze and archive the exact release input, output, policy, evaluation
   build, validation, shadow report, and reviewed movement/consumer evidence;
2. identify, tag, and retain the healthy V8-compatible Worker and Pages
   deployments;
3. pass a non-production rollback drill;
4. promote the candidate policy to `9.0` without changing its semantic digest;
5. deploy the Worker in which V9 is the sole scorer and canonical publisher;
6. verify canonical full, compact, fixed-input, and alert publication within
   15 minutes;
7. publish V9-aware Pages content after the Worker promotion gate; and
8. verify each derived surface as its normal producer refreshes.

Migrations remain additive and backward-compatible with the retained V8
Worker. The activation release never drops or repurposes V8-readable schema.
D1 migrations are not reversed during rollback.

## Rollback

Rollback is required for a material scoring defect, unexplained score/`NR`
movement, active-set failure, persistent publication failure, canonical
identity disagreement, unsafe consumer mismatch, false boundary-alert fan-out,
or a core frontend/API contract failure.

The operator sequence is:

1. record incident time, source commit, Worker/Pages deployment IDs, candidate
   identities, and the latest canonical publication;
2. leave incoherent score-derived alert or consumer surfaces fail-closed;
3. restore the retained V8-compatible Worker deployment;
4. verify that it rejects V9 canonical caches and serves supported V8
   compute-on-read responses;
5. wait for or invoke the bounded V8 report-card republish and verify all four
   canonical projections within 15 minutes;
6. restore the retained V8-compatible Pages deployment when current copy or UI
   is V9-only;
7. append a V8 rollback boundary to history and reseed safety alert state;
8. verify every derived surface is coherent or explicitly degraded until its
   next producer run; and
9. revert the activation commit on `main` through the normal release path while
   preserving the failed exact input and result for replay.

After the first compressed private V9 cache row exists, the retained rollback
Worker must include the V9 gzip/base64 reader even while V8 remains the sole
public scorer. An older build may still serve V8 but is not a complete rollback
target because its admin candidate reader cannot decode the persisted row.

Cloudflare deployment history is the immediate code rollback target. Git is
the durable source record. Neither substitutes for cache identity validation,
additive schema, alert reseeding, history boundaries, or consumer recovery.

## Observation And Retirement

After activation, observe V9 for at least 14 calendar days and two complete
cycles of every score-bearing and score-consuming producer. Keep the retained
V8 deployment IDs and Git commit, dual frontend parser, additive V9 tables,
V8-readable schema, and frozen release evidence. Do not recompute V8.

Only after that window passes may a separate cleanup release remove the V8
renderer, shadow invocation, candidate admin workspace, and obsolete candidate
orchestration. Preserve V8 methodology/history and V9 release evidence
permanently. Leave unused additive tables in place until an independently
coordinated destructive migration is safe.

## Release Checklist

- [ ] V9 methodology, calibration, coverage, and independent-validation gates
      pass.
- [ ] Prospective shadow gate passes for the exact frozen candidate.
- [ ] All material movements and consumer diffs are reviewed.
- [ ] V8-compatible API/frontend/history/alert release is live and retained.
- [ ] Every derived consumer has model provenance, mismatch behavior, cadence,
      and tests.
- [ ] Rollback drill restores coherent V8 output without reversing migrations.
- [ ] Activation release publishes only V9 and completes production smokes.
- [ ] Post-activation observation window passes before compatibility cleanup.
