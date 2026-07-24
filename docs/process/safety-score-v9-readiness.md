# Safety Score V9 Readiness

This document describes the current Safety Score V9 candidate, the evidence
needed to evaluate it, and the boundary between production shadow observation
and public activation. It does not define an active methodology. Safety Score
V8.17 remains active and public.

Release and activation mechanics are governed by the
[V9 rollout contract](./safety-score-v9-rollout.md). The
[consumer ledger](./safety-score-v9-consumer-ledger.md) records downstream
implementation and review status. Neither document authorizes activation.

## Current State

The current release scope is limited to production shadow observation, subject
to the normal release checks. That scope does not establish scoring readiness:

- V9 remains a candidate with no public release version.
- A valid V8 publication is still the prerequisite for each V9 shadow attempt.
- A V9 compile, evaluation, or persistence failure cannot suppress or replace
  V8 publication.
- `safety-score-v9:public-activation` remains the only runtime activation
  switch and must not be written as part of a shadow release.
- `/api/report-cards` remains the V8 contract.
- `/api/report-cards/v9` remains dark while the activation key is absent.
- No V9 public methodology section or structured activation changelog entry is
  part of the shadow release.

The latest calibration changes do not yet have post-change production shadow
evidence in the verified documentation corpus. Earlier local captures,
histograms, and named-asset scores were produced by older candidate identities
and must not be quoted as current results. Fresh production generations are
required before assessing the effective distribution or individual ratings.

There is also no tracked, real holdout package containing a candidate seal,
content-addressed point-in-time source archive, and two-reviewer blind review.
The holdout protocol is implemented, but holdout success has not been
established. No current readiness or activation claim follows from the
implementation or its synthetic tests.

## Sources Of Truth

Do not copy candidate digests or score distributions into durable prose. They
rotate when policy, evaluation code, fact schema, or producer capability
changes. Use these sources:

- `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` owns the
  candidate policy and grade thresholds.
- `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` owns the
  generated evaluation-build identity.
- `shared/lib/safety-score-v9/` owns the runtime-neutral evaluator, trace,
  coverage, and production-validation semantics.
- `worker/src/lib/safety-score-v9-fact-set.ts` owns production fact
  compilation.
- `worker/src/lib/safety-score-v9-extension.ts` and its focused modules own
  reviewed evidence adaptation.
- `worker/src/lib/safety-score-v9-candidate.ts` computes the exact policy,
  evaluation-build, compiler-schema, producer-capability, and candidate
  identity.
- `worker/src/lib/safety-score-v9-shadow-runner.ts` owns the caught shadow
  execution and 30-minute refresh bound.
- `worker/src/lib/safety-score-active-source.ts` owns active-model selection and
  the activation-key contract.
- `worker/src/lib/safety-score-v9-production-verifier.ts` and
  `shared/lib/safety-score-v9/production-validation.ts` own strict production
  evidence evaluation.

The tracked `readiness-baseline-v1.json` and `exit-route-calibration-v1.json`
files are historical inputs and drift records. They do not describe the current
candidate and cannot authorize publication.

## Framework Workstreams

The calibration revision implements eight general framework changes. They are
not per-asset exceptions.

### 1. Evidence Responsibility

Every material gap is classified by who or what caused the uncertainty:
measured adverse evidence, issuer non-disclosure, missing integration, producer
failure, or unsupported methodology. The reason registry remains authoritative:
a bounded reason retains a provisional score under its configured ceiling,
while an unbounded required fact remains `NR`. A naturally computed D can
represent multiple bounded material weaknesses, but F requires causal
measured-adverse attribution. Missing plumbing stays visible as evidence debt
instead of being presented as observed economic failure or danger.
Every rated D carries either measured-adverse attribution or a separate causal
bounded-uncertainty trace. A bounded fact is causal only when its reason belongs
to a low score-bearing pillar or its configured ceiling binds. Binding serial
parents propagate the same distinction only when the parent is itself in the
low-grade range; wrapper-local reviewed discounts and fallback gaps carry their
own attribution. An arbitrary low composite with neither trace remains `NR`.

Access posture is categorical unless a reviewed fact establishes an economic
loss path. A missing categorical access review remains visible as
review-required evidence debt, but it is diagnostic rather than an unbounded
score claim.

Impact: assets are not pushed into the lowest grades merely because Pharos has
not integrated a source, while genuinely bad measured outcomes remain
score-bearing and explainable. The separate limited-backing gate still
withholds assets whose minimum evidence contract is not met.

### 2. Multi-Horizon Exit Capacity

Exit scoring separates immediate, near-term, and queued capacity. Routes retain
their settlement horizon, cost, evidence kind, output identity, failure domain,
and observation lineage. Diversification credit requires genuinely independent
routes.

Impact: fast DEX liquidity, issuer redemption, and delayed protocol exits no
longer collapse into one interchangeable number. A large but slow route cannot
fully compensate for weak immediate exit capacity.

### 3. Scoped Holder-Slice Loss

Deployment, bridge, reserve, and dependency losses apply to the holder slice
that is actually exposed. Conserved supply shares and explicit failure-domain
attribution determine the affected slice.

Impact: a small reviewed peripheral deployment can impose a bounded adjustment
without automatically capping the whole asset, while material or unattributed
exposure remains fail-closed.

### 4. Smooth Bounded Aggregation

The formula uses smooth bounded headroom above the weakest material pillar
instead of an abrupt weakest-pillar-plus-fixed-step rule. Structural ceilings,
peg effects, evidence bounds, and adverse paths still apply after aggregation.

Impact: nearby fact patterns produce nearby scores, but a strong unrelated
pillar still cannot erase a weak material path.

### 5. Role-Aware Dependencies

Dependencies carry an economic role: serial claim, basket exposure, exit
dependency, control operator, or NAV oracle. The evaluator propagates only the
dimensions that the role can transmit. Reviewed dependency identity is matched
structurally while the current live exposure weight remains authoritative.

Impact: wrappers and reserve-backed assets inherit the relevant upstream risk
without duplicating or spreading that risk into unrelated pillars. Ordinary
weight drift no longer discards an otherwise valid reviewed role.

For a rateable basket exposure, the upstream backing score is applied at the
live exposure weight. An upstream evidence ceiling remains attributable to that
slice and cannot cap the whole downstream asset after the uncertainty has
already been priced through the weighted score. Serial claims retain their
whole-parent ceiling because every unit of the child depends on that parent.

### 6. Wrapper-Local Risk

Wrapper scoring separates parent exposure from local strategy, custody,
leverage, rehypothecation, accounting, and unwrap behavior. Positive local
facts are derived only from explicit wrapper form or reviewed evidence; unknown
facts are not inferred safe from a strong parent.

Impact: a USDC wrapper does not automatically outrank an independent
stablecoin solely because USDC is strong. Pure pass-through wrappers can still
receive credit for an evidenced simple design.

### 7. Bounded Operational Resilience

Reviewed operating history can include redemption throughput, stress episodes,
reserve reconciliation, assurance history, and incident handling. Credit
requires current, attributable evidence. Visibility-only diagnostics do not
erase otherwise valid resilience evidence, while issuer-undisclosed material
facts still block credit.

Canonical implementation history can satisfy only the maturity gate for
producer-measured market depth. The depth credit itself remains cohort-wide,
requires repeated successful score-eligible execution observations at the
policy notional, and does not depend on an asset-specific editorial overlay.

Impact: long-lived assets with demonstrated stress performance can receive
bounded recognition without turning age, size, or reputation into an
unconditional safety override.

### 8. Mechanism Profiles

Fiat, commodity, CDP, savings, wrapper, and other designs use
mechanism-appropriate facts rather than one universal checklist.
Not-applicable fields require an explicit structural basis; unavailable or
failed measurements remain visible.

Impact: materially different stablecoin designs are judged on the failure
paths they actually have, while common evidence and integrity rules remain
consistent across the cohort.

## Producer And Fact Fidelity

Several supporting corrections are required for those workstreams to behave as
designed:

- Measured execution retains bounded last-known-good observations across
  operational producer failures, preserves quote lineage, and requires repeated
  successful observations before earning high confidence.
- Reviewed redemption with an undisclosed numeric fee can preserve bounded
  executable capacity under the opaque-fee ceiling; it does not become a
  permissionless or fee-free route.
- A score-bearing DEX route with measured zero or immaterial capacity carries
  typed pillar attribution. This prevents a real adverse observation from being
  converted to `NR` merely because the attribution previously existed only in
  the route trace.
- Reviewed reserve links project exact tracked-asset identity into compiled
  exposures while retaining the live weight.
- Wrapper custody, leverage, and rehypothecation remain unavailable unless
  explicitly evidenced. A wrapper fallback discount is attributed to those
  bounded local gaps only when it exceeds the reviewed local-risk discount;
  otherwise the applied discount is attributed to the reviewed adjustments
  that caused it.
- Wrapper measured-unwind facts share the Exit pillar's documented-redemption
  admission result. This recognizes reliable reviewed redemption without
  changing raw route score eligibility; undisclosed-fee routes remain excluded
  because their later danger gate is unavailable during fact compilation.
- Every evidence owner, including a missing Pharos integration, receives the
  reason registry's configured ceiling when that reason is score-bearing.
- Where a provider publishes only aggregate lock-mint supply, a V9-only
  attribution may partition the existing aggregate liability from canonical
  total supply and observed lockbox balances. It must conserve the aggregate,
  count locked backing once, preserve unknown destination allocation, and fail
  closed when the onchain read is unavailable.

These are evidence and attribution corrections. They do not change V8 inputs
or public V8 scoring.

Current candidate cards use score-trace schema v2 and response schema v3 for
bounded-D attribution. Strict readers retain response-v2/trace-v1 compatibility
for already persisted shadow artifacts, while new output must satisfy the v3
causal and score-grade reconciliation rules. The separate public report
projection uses report-response schema v2 with the same trace-v2 cards. Its
live producer and consumers are current-only; report-v1/trace-v1 is available
only through the explicitly named historical compatibility reader.

## Compiler Boundary

The production compiler consumes one exact fixed input plus one reviewed V9
extension. It rejects duplicate, missing, unexpected, future-dated, stale-as-
current, or identity-drifted evidence. Exact USD-denominated chain supply is
consumed directly and is never multiplied by price.

The evaluator must not accept:

- desired V9 grades or scores;
- asset-specific score overrides;
- scenario-supplied production caps;
- post-outcome evidence in historical fixtures; or
- a reviewer-authored pass boolean in place of machine-derived evidence.

Candidate policy constants remain provisional semantics. Parent evaluation is
deterministic and parent-first; missing parents, cycles, and unresolved economic
roles remain explicit. A result must retain policy, evaluation-build,
compiler-schema, producer-capability, base-input, fact-set, result, and source
generation identity.

## Production Shadow Evidence

After a valid V8 publication, the Worker may refresh the private V9 latest
candidate at most once every 30 minutes. It retains:

- `report-cards:v9-fixed-input:exact`, the exact attempted V9 input paired by
  base and source generation identity;
- `report-cards:v9-shadow`, the strict candidate envelope;
- `report-cards:v9-shadow:diff`, the V8/V9 movement report;
- one compact `safety_score_v9_shadow_daily` row per UTC day; and
- attempt health in `cron_runs`.

The first post-release observations should answer factual questions, not target
a preferred histogram:

1. Did the exact candidate compile for the complete active registry?
2. Which assets are rated and which are reason-coded `NR`?
3. Which D results reflect measured weakness versus bounded uncertainty, and
   which F results carry the required measured-adverse attribution?
4. Did the eight workstreams reduce unexplained C/D concentration without
   removing real structural caps?
5. How did USDT, DAI-family assets, USDG, XAUT, Frax-family assets, wrappers,
   and the other named review anchors move, and which facts caused each move?
6. Did producer freshness, route coverage, supply attribution, reserve links,
   and wrapper-local facts populate as expected?
7. Are movements stable across distinct exact production generations?

Local registry projections and rekeyed captures are useful debugging evidence,
but they cannot answer producer freshness or deployed-input questions. Do not
promote their figures into this document as current production results.

## Validation And Holdout

`npm run safety-score-v9:production-validation` rebuilds supplied candidate
generations from paired exact-cache exports and checks identity, continuity,
asset sets, producer evidence, score movements, and the supplied holdout
evidence. It writes a structured no-go report before exiting nonzero when
required evidence is absent or inconsistent. That report is advisory and never
writes the activation key.

`npm run safety-score-v9:holdout-status` validates preparation for a real
holdout. A valid package requires:

- a release-candidate seal bound to the current identities;
- at least 24 point-in-time cases with content-addressed source and exact
  production-input artifacts;
- selection before V8 and V9 outputs are revealed;
- at least two independent blind reviewers; and
- machine-verifiable artifact digests and adjudication records.

The legacy historical fixture corpus is retrospective and unarchived. Synthetic
tests prove validator behavior only. Neither is a substitute for that package,
and the current verified corpus does not contain one.

Strict production acceptance also treats a D-to-`NR` movement as non-credit:
removing a defensible low rating by withholding attribution is not an
improvement. Missing exact captures, a broken capture ledger, identity drift, or
unchecked holdout outcomes remain explicit no-go evidence.

## Owner Boundary

Production shadow deployment, green tests, valid candidate publication, and
stable fresh generations still do not activate V9. The owner alone decides
whether the candidate is ready and performs the identity-bound activation-key
write described in the rollout contract.

Until that decision:

- V8.17 remains the public methodology;
- the V9 public endpoint remains dark;
- public methodology and changelog content remain unchanged; and
- readiness, holdout, consumer review, and named-asset findings are reported
  honestly without being converted into an activation claim.
