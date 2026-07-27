# Safety Score V9 Rollout

> **Current state:** The owner authorized V9 activation on 2026-07-27 under
> methodology `9.0`. The identity-bound activation key remains
> the sole runtime switch: a missing, malformed, or mismatched key keeps the
> versioned endpoint dark. V8 compatibility publication remains scheduled only
> through the 24-hour activation observation window.

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

Daily qualification and streak fields remain historical diagnostics in retained
shadow rows. They do not accrue release credit, restart after an identity
rotation, or constrain the owner decision. The former access-protected Safety
V9 admin workspace and its admin diff/review API were retired after activation;
live V9 still uses the identity-bound public endpoint and the canonical
shadow-named publication caches described below.

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
- existing movement-review records retained for diff annotation.

The daily row, preview, retained movement-review evidence, coverage reports,
and consumer ledger are observation surfaces. They inform calibration and the
owner decision but do not authorize or veto activation.

## Calibration Loop

Until activation, the owner reviews shadow rows and sends specific scoring
discontents. Each session separates data problems from scoring-logic problems,
ships the smallest supported correction, and rotates policy or
evaluation-build identity when required. Rotations carry no procedural release
cost and do not restart a clock.

The surviving constraints are:

- fact-side curation may proceed without an identity freeze;
- named asset concerns move only through attributable evidence or general
  framework changes, never through asset-specific score overrides;
- the U, EURS, and MIM pins and the TUSD watch keep their existing semantics;
  and
- adversarial review remains required for each identity rotation.

Policy, compiler, evaluation-build, fact-set, producer-capability, and result
digests remain recorded. Removing the release gate does not weaken identity
binding or deterministic replay.

## Shadow Architecture

The V8 publisher atomically commits its public projections, exact replay input,
and compact publication-exact V9 peg-provenance seed before DDR runs. Dedicated
`+8` supply-attribution and `+14` shadow triggers then run V9 in separate caught
failure domains. Each requires the matching completed core slot and immutable
Worker version ID, acquires the shared V9 memory lane, and has an absolute
pre-quarter deadline, so a V9 load, compile,
evaluation, serialization, persistence failure, or delayed trigger cannot
suppress or replace V8 publication or strand DDR.

The private latest entries are:

- `report-cards:v9-peg-provenance-seed:exact`: the compact
  publication-exact peg event provenance bound to the atomic V8 generation;
- `report-cards:v9-fixed-input:exact`: the normalized V8 base generation plus
  any bounded V9-only evidence used by the latest accepted shadow refresh;
- `report-cards:v9-shadow`: the latest strict candidate envelope; and
- `report-cards:v9-shadow:diff`: the latest V8/V9 movement report; and
- `report-cards:v9-shadow:publication-health`: the bounded current/held state,
  accepted identity and time, latest attempt time, and hold reasons.

Immediately before canonical persistence, the runner evaluates publication
input health and compares newly binding producer-failed deterioration with the
last accepted V9 snapshot only when both snapshots carry the same policy,
methodology, and evaluation-build identity. An intentional scoring-identity
transition establishes a new comparison baseline instead of comparing failure
attribution across unlike evaluators. Stale or unavailable applicable DEX,
redemption, or live-reserve inputs, failed coverage floors, newly binding
same-identity producer-failed downgrades or NR transitions, and assessment
failures hold the candidate. Healthy measured-adverse movements still publish.

A held attempt records the publication-gate failure in the daily row and
updates only publication health. It does not replace the canonical envelope or
diff, advance the accepted score timestamp, or replace the accepted exact
input. An accepted attempt writes the envelope, diff, exact input, daily row,
and current health in one D1 batch ordered by the V9 publication clock.

Evidence capture must export the V9 exact-input key, not the atomic V8
`report-cards:fixed-input:exact` key, and verify that its base and source
generation identities match the selected shadow row.

The Worker also retains one compact `safety_score_v9_shadow_daily` row per UTC
day. The row records candidate identity, result counts, coverage observations,
movement state, producer generations, and errors for operator review. Routine
attempt telemetry stays in `cron_runs`. Human movement dispositions remain
append-only evidence and never control the active model.

The unlisted preview is read-only, unlinked, and `noindex`. It serves the strict
public projection with `lifecycle: "shadow"` and neither reads nor writes the
activation key.

## Shadow-Only Production Release

Deploying candidate scorer, producer, validation, or consumer-fencing code to
production is permitted for shadow observation. That deployment must preserve
all of these boundaries:

- `shared/lib/methodology-versions/safety-score.ts` continues to identify V8.17
  as the active public methodology;
- `safety-score-v9:public-activation` is not created, changed, or inferred;
- `/api/report-cards` continues to serve the V8 contract and
  `/api/report-cards/v9` continues to return `404`;
- no V9 public methodology section or structured activation changelog entry is
  created; and
- V9 failures remain caught after V8 publication and cannot fail the V8 write.

The purpose of this release is to obtain exact post-change production evidence:
producer generations, fact-set and result identities, distributions, named
anchor movements, and failure diagnostics. A successful deployment proves only
that the shadow code is running. It does not prove rating quality, holdout
success, readiness, or activation.

## Pre-Activation Evidence Check

On the day the owner declares the candidate ready, prepare one fresh packet
against the exact deployed identity:

1. capture the exact publication input;
2. replay it at deployed `HEAD`;
3. review the named resilient and adverse anchors against their documented
   semantics;
4. compare the distribution with the latest live shadow row and explain every
   grade-band movement;
5. confirm the score-bearing producers are green in `cron_runs`; and
6. run the strict production verifier with the exact captures, continuity
   ledger, and real holdout artifacts that are actually available.

The verifier is advisory and fail-closed: missing holdout or continuity evidence
must remain visible as a no-go result and must not be replaced by local fixtures
or reviewer-authored pass booleans. The packet is a one-shot sanity check, not
the start of a window. The rated-count regression alarm must be quiet when the
owner writes the activation key. A later calibration change requires a fresh
packet because the approved identity changed, not because a release clock
restarted.

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

When active V9 is held, the versioned API serves the last accepted ratings with
`X-Safety-Score-Status: held`, accepted-timestamp freshness headers, and
`Cache-Control: no-store`. Current-data consumers treat the safety source as
unavailable and never fall back to V8. Safety alerts and the daily history
writer emit no organic score movement from a held attempt; independent depeg
and incident families continue on their own sources.

`executeSafetyScoreHistoryBoundaryOperation()` remains the prepared cutover
path for V2 history. It is not routed or scheduled, requires the exact approved
publication identity and timestamps, writes null-previous non-comparable
baselines, and fails conflicting replays. After that baseline exists, the daily
history writer records identified V9 organic rows only from current accepted
publications; the legacy compatibility table remains V8-only.

## Activation

Activation is an owner operation:

1. review the one-shot evidence packet, including any explicit no-go findings,
   and confirm the rated-count alarm is quiet;
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
state, and keep incoherent derived surfaces degraded until they refresh. A
restored Worker must complete its first quarter-hourly V8 report-card
publication before evaluation-build-bound compact caches and consumers are
considered converged; request-time V8 report cards may use their identified
compute fallback during that bounded interval.

D1 migrations are not reversed during rollback. Cloudflare deployment history
is the immediate code target; Git remains the durable source record.

## After Activation

Observe the first relevant production runs, the rated-count alarm, movements,
alerts, history, and consumer refreshes before claiming runtime health. Any
later compatibility cleanup is a separate owner decision. Preserve V8
methodology/history and the exact V9 activation identity and sanity packet.

## Activation Checklist

- [ ] Fresh exact capture replays at deployed `HEAD`.
- [ ] Named resilient/adverse anchors and distribution movements are reviewed.
- [ ] Holdout and continuity status is generated from real supplied artifacts;
      missing evidence remains explicit.
- [ ] Score-bearing producers are green in `cron_runs`.
- [ ] Rated-count regression alarm is quiet.
- [ ] Activation-key identity matches the canonical V9 snapshot.
- [ ] V8 rollback targets and public methodology/content changes are ready.
- [ ] Owner writes the key and production smokes pass.
