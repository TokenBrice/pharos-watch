# Safety Score V9 Rollout

> **Current state:** Safety Score v8.17 remains the public model. V9 continues
> to publish a daily shadow row and an owner-approved, unlisted read-only
> preview. The versioned public V9 endpoint remains dark until the owner writes
> the identity-bound activation key.

This document is the durable rollout contract for Safety Score V9. Candidate
correctness, calibration results, and identity records live in
[Safety Score V9 Readiness](./safety-score-v9-readiness.md).

## Owner Ruling

Owner ruling, 2026-07-23: V9 goes public when the owner says it is ready. The
owner's write of the D1 cache key `safety-score-v9:public-activation` is the sole
runtime activation switch. The key must contain the exact approved policy ID,
policy digest, evaluation-build digest, and methodology version; a missing,
malformed, or mismatched value keeps the versioned endpoint dark.

The former formal release machinery is retired:

- no identity-freeze declaration;
- no qualifying-day window or streak as an activation gate;
- no sealed `v9-rc-N` release-cohort row;
- no consumer-ledger completion gate; and
- no offline shadow-gate script whose pass authorizes release.

Daily qualification and streak fields may remain visible in the admin surface
as historical diagnostics. They do not accrue release credit, restart after an
identity rotation, or constrain the owner decision.

The rationale is an agile middle ground: the owner is the accountability
holder. The retired apparatus served a multi-party trust model this product
does not have. Exact identity records and observable shadow behavior remain
useful without turning them into a release state machine.

## Kept Operational Surfaces

The following remain load-bearing:

- the identity-bound activation key and fail-closed public V9 endpoint;
- the every-other-day shock-coverage refresh, without which LUSD and BOLD fall
  back to legacy liquidation-capacity evidence after 72 hours;
- the rated-count regression alarm;
- one compact daily shadow row;
- the unlisted, read-only V9 preview; and
- the movement-review queue.

The daily row, preview, movement queue, coverage reports, and consumer ledger
are observation surfaces. They inform calibration and the owner decision but do
not authorize or veto activation.

## Calibration Loop

Until activation, the owner reviews daily rows and sends discontents in the
Ike-list format. Each session separates data problems from scoring-logic
problems, ships the smallest supported correction, and rotates policy or
evaluation-build identity when required. Rotations carry no procedural release
cost and do not restart a clock.

The surviving constraints are:

- fact-side curation may proceed without an identity freeze;
- USDT crosses into A- only on evidence, never through compensating parameter
  changes;
- the U, EURS, and MIM pins and the TUSD watch keep their existing semantics;
  and
- adversarial review remains required for each identity rotation.

Policy, compiler, evaluation-build, fact-set, producer-capability, and result
digests remain recorded. Removing the release gate does not weaken identity
binding or deterministic replay.

## Shadow Architecture

After a valid V8 publication commits, the Worker runs the V9 candidate in a
separate caught failure domain. A V9 load, compile, evaluation, serialization,
or persistence failure cannot suppress or replace V8 publication.

The private latest entries are:

- `report-cards:v9-shadow`: the latest strict candidate envelope; and
- `report-cards:v9-shadow:diff`: the latest V8/V9 movement report.

The Worker also retains one compact `safety_score_v9_shadow_daily` row per UTC
day. The row records candidate identity, result counts, coverage observations,
movement state, producer generations, and errors for operator review. Routine
attempt telemetry stays in `cron_runs`. Human movement dispositions remain
append-only evidence and never control the active model.

The unlisted preview is read-only, unlinked, and `noindex`. It serves the strict
public projection with `lifecycle: "shadow"` and neither reads nor writes the
activation key.

## Pre-Flip Sanity Check

On the day the owner declares the candidate ready, prepare one fresh packet
against the exact deployed identity:

1. capture the exact publication input;
2. replay it at deployed `HEAD`;
3. byte-check the U, EURS, and MIM pins and review TUSD against its watch
   semantics;
4. confirm the anchor table is green;
5. reproduce the composite A+ case three times;
6. compare the distribution with the last live shadow row and explain every
   grade-band movement; and
7. confirm the score-bearing producers are green in `cron_runs`.

The packet is a one-shot sanity check, not the start of a window. The rated-count
regression alarm must be quiet when the owner writes the activation key. A
later calibration change requires a fresh packet because the approved identity
changed, not because a release clock restarted.

## Consumer Contract

The existing unversioned `/api/report-cards` contract remains V8 during
migration and must not silently change to a V9 payload. V9 uses the versioned
endpoint. The activation key has this identity-binding shape:

```json
{
  "policyId": "<approved-policy-id>",
  "policyDigest": "<approved-policy-digest>",
  "evaluationBuildDigest": "<approved-evaluation-build-digest>",
  "methodologyVersion": "<approved-methodology-version>"
}
```

Every score consumer must still avoid mixing V9 scores with V8 labels or
thresholds. The
[Safety Score V9 Consumer Ledger](./safety-score-v9-consumer-ledger.md) remains
the review inventory for those mappings, model-mismatch behavior, refresh
cadence, and tests. `OPEN` rows are advisory findings, not activation blockers.

History and alerts must preserve model identity. A model boundary starts a new,
non-comparable history baseline and must not emit an organic upgrade/downgrade
fan-out. Incoherent consumers remain fail-closed or explicitly degraded until
their normal producer refreshes.

`executeSafetyScoreHistoryBoundaryOperation()` remains the prepared cutover
path for V2 history. It is not routed or scheduled, requires the exact approved
publication identity and timestamps, writes null-previous non-comparable
baselines, and fails conflicting replays.

## Activation

Activation is an owner operation:

1. review the one-shot sanity packet and confirm the rated-count alarm is quiet;
2. retain the healthy V8-compatible Worker and Pages deployment IDs for
   rollback;
3. coordinate the public methodology changelog entry, `/methodology` update,
   and HERALD activation content with the flip;
4. write `safety-score-v9:public-activation` with the approved identity; and
5. verify the versioned endpoint, public Pages content, history boundary,
   alerts, and score consumers.

The key write is the authorization. A shadow streak, release-cohort row,
consumer-ledger status, or advisory report cannot substitute for or override
it. The public-facing methodology and activation-content obligations are
unchanged and ship with the key flip, not during shadow calibration.

Migrations remain additive and backward-compatible with the retained V8
Worker. Activation does not drop or repurpose V8-readable schema.

## Rollback

Rollback is warranted for a material scoring defect, unexplained score or `NR`
movement, rated-count regression, persistent publication failure, canonical
identity disagreement, unsafe consumer mismatch, false boundary-alert fan-out,
or a core frontend/API failure.

The operator records the incident and deployment identities, removes the
public-activation key so the versioned endpoint fails closed, and restores the
retained V8-compatible Worker or Pages deployment where necessary. Verify V8
publication, append the non-comparable V8 history boundary, reseed safety-alert
state, and keep incoherent derived surfaces degraded until they refresh.

D1 migrations are not reversed during rollback. Cloudflare deployment history
is the immediate code target; Git remains the durable source record.

## After Activation

Observe the first relevant production runs, the rated-count alarm, movements,
alerts, history, and consumer refreshes before claiming runtime health. Any
later compatibility cleanup is a separate owner decision. Preserve V8
methodology/history and the exact V9 activation identity and sanity packet.

## Activation Checklist

- [ ] Fresh exact capture replays at deployed `HEAD`.
- [ ] Pins/watch, anchor table, composite A+ x3, and distribution review pass.
- [ ] Score-bearing producers are green in `cron_runs`.
- [ ] Rated-count regression alarm is quiet.
- [ ] Activation-key identity matches the canonical V9 snapshot.
- [ ] V8 rollback targets and public methodology/content changes are ready.
- [ ] Owner writes the key and production smokes pass.
