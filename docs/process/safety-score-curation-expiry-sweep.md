# Safety Score V9 Curation-Expiry Sweep

> **Agent navigation** — Grep the heading you need instead of reading wholesale: [1. Capture the current production input](#1-capture-the-current-production-input) · [2. Replay the capture at HEAD](#2-replay-the-capture-at-head) · [3. Generate the worklist](#3-generate-the-worklist) · [4. Add the 10-day pre-expiry queue](#4-add-the-10-day-pre-expiry-queue) · [4a. Generate and drain the typed missing-data registry](#4a-generate-and-drain-the-typed-missing-data-registry) · [4b. Renew before the boundary, then check and book the ledger sentinels](#4b-renew-before-the-boundary-then-check-and-book-the-ledger-sentinels) · [5. Check the live-withheld counterfactual](#5-check-the-live-withheld-counterfactual) · [6. Close the weekly sweep](#6-close-the-weekly-sweep) · Artifact hygiene · Related.

Run this sweep weekly to refresh the evidence-curation queue before reviewed reserve
evidence loses admission. With the default 10-day lookahead, the preventive queue
re-evaluates the applicable source-strength, freshness, and whole-asset denominator
gates in production's `resolveReviewedReserveAdmission()`; expiry is not one universal
composition-age threshold.

Run every command from the repository root. Use one fresh production capture for the
entire sweep; do not combine worklists or dates from different producer cycles.

The sweep is also automated: `.github/workflows/curation-expiry-sweep.yml` runs this
procedure every Tuesday at 05:45 UTC (and on manual dispatch) with the deploy
pipeline's Cloudflare credentials. It updates or creates the "Safety Score curation
expiry sweep" issue with registry counts, all eight generator statuses and the full
artifact link before the renewals, ledger-sentinel, live-withheld/expiry and
Dependencies/Backing excerpts. Its complete
body, including truncation marker and run footer, is capped at 60,000 UTF-8 bytes
without splitting characters. All reports, logs, capture and replay (including partial
outputs) are retained together in a 30-day run/attempt artifact. Replay and each of the
seven downstream reports have separate workflow steps and status outputs; the issue's
`Command status` and `Process status` lines name all eight. The sentinel check, the
14-day renewal view and the renewal calendar each have a 10-minute ceiling; the
live-withheld step has a 25-minute ceiling inside the unchanged 40-minute job budget,
leaving time for issue/artifact publication when that report times out. Missing status
outputs count as failures. Generator failures fail the run, but green
generation does not attest cache freshness.
Draining complete queues stays operator work — follow the steps below.

**Operator contract:** the sweep operator reviews and drains the `DEP`/`RESV`,
pre-expiry, and live-withheld rows weekly. Mark a high-supply counterfactual grade drop
as high priority in the sweep issue, record the next action or blocker before the next
producer cycle, and keep it open until the fallback path is reviewed.

## 1. Capture the current production input

Create `agents/v9-captures/`, then use the
[prepare-time base-only export in section (a)](./safety-score-equivalence-harness.md#prepare-time-base-only)
with `--exact-cache-export --normalized-only` on `report-cards:capture-fixed-input`.
This sweep uses HEAD curation, not an accepted/embedded-registry capture;
the normalized input retains top-level `clockSec`.

```bash
mkdir -p agents/v9-captures
# Export and normalize capture-<stamp>.json using harness section (a).
```

The scheduled workflow adds `--require-current`: unless `0 <= now - clockSec <=
SOURCE_FIXED_INPUT_MAX_AGE_SEC` it exits nonzero (`capture-stale`/`capture-future`) with no
output. Never generate a queue from a missing or old row; historical captures omit the flag.

## 2. Replay the capture at HEAD

Replace `<stamp>` with the capture filename's UTC stamp. Replay the capture through the
current checkout and pin publication time to the capture clock:

```bash
stamp="<stamp>"
capture="agents/v9-captures/capture-${stamp}.json"
replay="agents/v9-captures/replay-curation-${stamp}.json"
clock_sec="$(jq -r .clockSec "${capture}")"

npm run safety-score-v9:replay -- \
  --input "${capture}" \
  --output "${replay}" \
  --published-at "${clock_sec}" \
  --rederive-current-redemption
```

Do not substitute the operator's wall clock. The capture's `clockSec` is the production
publication clock and determines whether each review is admitted or expired.

Add `--allow-registry-mismatch` when HEAD curation postdates the captured registry
fingerprint, which is the sweep's normal condition; the replay otherwise hard-fails
on the fingerprint check. The automated workflow always passes it, because this sweep
reads worklist items rather than score equivalence.

This permanent operator workflow explicitly requests a current-redemption scenario.
Ordinary replay retains captured observations by default; scenario replay cannot use
accepted/embedded-registry captures or `--registry-ref`. The workflow tracks every
generator's status; generator failures fail the run. No scoring/publication authority
is implied.

## 3. Generate the worklist

```bash
worklist="agents/v9-captures/curation-worklist-${stamp}.md"
npm run safety-score-v9:curation-worklist -- \
  --replay "${replay}" \
  --output "${worklist}"
```

The generated streams put critical items first, then unavailable supply before known
supply within the same criticality, with deterministic asset-ID ties; known supplies
descend by priority/supply. Unknown is not observed zero or the smallest asset.
The report names the known-supply subtotal and unavailable census; a rated share of
known supply is not full-cohort supply coverage. Treat `DEP` and `RESV` as the
first-priority lanes and drain both before moving to another stream:

| Order | Stream | Operator rule |
| --- | --- | --- |
| 1 | `DEP` + `RESV` | Take the highest-supply remaining item across these lanes; resolve upstream availability and exact relationship mapping for `DEP`, and refresh only from current evidence for `RESV`. |
| 2 | Remaining streams | Continue only after the current `DEP` and `RESV` queues have been reviewed or explicitly blocked. |

An item is cleared only when its reason code disappears from a fresh replay-generated
worklist. Do not hand-edit generated rows, date-bump a review without re-verifying its
composition, or hide an unresolved evidence gap by changing confidence.

Two classes stay out of the default streams but never out of the registry. Rows whose
witnesses are all documentation-class gaps (policy `semantic.evidence.documentation`,
§4a) are counted in the stream table and listed only when `--include-documentation`
appends the non-scoring `DOC` band. Claim groups parked by the reviewed ledger's churn
rule are hidden from every band; the worklist reads the ledger from `--ledger` (default
`.github/artifacts/safety-score-missing-data-reviewed-ledger.json`). Neither exclusion
closes a fact: a documentation row re-enters the streams when its classification no
longer holds, and a parked group returns to them only after a ledger `unpark`.

A standing-structure composition — one with no dated composition report, whose structure
was re-verified from current primary sources — may be re-dated only when its rows carry
conservative (high) risk tiers, so re-dating cannot improve the score through favorable
tiers. Favorable-tier standing claims are not re-dated; they expire into the `RESV`
queue until dated evidence exists.

## 4. Add the 10-day pre-expiry queue

The worklist reports gaps that already affect the replay. It does not list every still
admitted composition approaching expiry. Run this extraction against the same replay;
it lists compositions admitted at the capture clock but inadmissible within the
requested lookahead, for assets with no live reserve rows in that capture.
Unknown supply sorts first (asset-ID ties), then known supplies descend. Null/missing
rows carry unavailable reasons; observed zero stays zero. The queue subtotal counts
only known supply and is not a complete supply denominator:

```bash
npm run safety-score-v9:expiry-queue -- --replay "${replay}"
```

The same report enrolls execution reviews, supply plans/partitions/row exclusions,
native single-route supply, mint/bridge scoped controls and questions, transfer
scopes, scoped reserve observations and bounded reserve facts. Their boundaries come
from original authored clocks plus canonical policy budgets (never a +N-day replay),
with inclusive/exclusive semantics; admission joins exported resolvers or the replay,
and a missing join is `unknown`. Wrapper-allocation and operational-resilience dates
are an inactive/history census, never renewals. A census error writes a **partial**
report, then exits nonzero.

The queue consumes the `projected` rows from production's `resolveReviewedReserveAdmission()`
in `extension-reserves.ts`: supervised named-report admission precedes the audited/curated
fallback lanes for configured producers, or standalone admission without a live producer.
The captured `liveToFallbackCoins` census is telemetry, not an independent disclosure gate.
It is re-evaluated at the capture clock plus the lookahead (`--days`, default 10).
`extension-reserves.ts` and the active policy's `evidenceExpiry` own the source-specific
freshness and whole-asset admission gates; do not copy age cutoffs into this workflow.
Only compositions that are admitted today and stop being admitted within the
lookahead are listed — currently-inadmissible compositions already surface in the
worklist's `RESV` and `DEP` streams and are deliberately excluded here.

The queue is about to become inadmissible, not merely about to change evidence strength.
Named independent reports use the policy's report-period bound, not a one-year audited
escape path; expired named reports cannot fall through to the generic curated lane.
Use the live-withheld report below to inspect the resulting fallback score and ceiling.

Reserve columns: asset ID, evaluated-set circulating USD (largest first), curated
`compositionAsOf`, age in days, collateral links, and adapter state (`none` or
`silent-this-cycle`). Queue these assets for reserve research even without a current
`RESV`/`DEP` row. A later live snapshot removes the asset; it does not make this
cycle's missing snapshot live. The by-UTC-week renewal views and the renewal SLA are in
[§4b](#4b-renew-before-the-boundary-then-check-and-book-the-ledger-sentinels).

## 4a. Generate and drain the typed missing-data registry

Generate the existing router from the same replay and the current V9 policy:

```bash
registry="agents/v9-captures/missing-data-registry-${stamp}.json"
npm run safety-score-v9:missing-data-registry -- \
  --replay "${replay}" \
  --policy shared/data/safety-score-v9/methodology-policy-candidate-v1.json \
  --output "${registry}"
```

The registry's `workType`, `resolutionMode`, `claimGroupId`, evidence action,
touchpoints, current context, and disappearance sentinels are the routing contract.
Do not build another classifier from the evidence queue's coarse `action` field.
Task rows, claim groups, and dispatch reachability are routing counts, not estimates of
closable facts. No registry row closes a fact mechanically.
The evidence queue uses the compiled fact schema's labelled status census, including nested factor, wrapper, access-graph and lender statuses. Shared gaps retain unresolved applicability if any referencing fact is unresolved; supply-evidence freshness is derived once per asset without changing queue keys, priority or cause accounting.

The census has three disjoint buckets from the replay's admitted completeness:
`rateableStablecoinCount` (`ratingStatus: "rated"`), `notRatedStablecoinCount`
(economic `"not-rated"`), and `pipelineGapStablecoinCount` (technical `"pipeline-gap"`).
Their sum reconciles to the full census and `ratingStatusCounts`. A pipeline gap's
null grade is neither a rating nor economic NR; do not infer rateability from `grade !== "NR"`.

Registry schema 3 keeps the schema-2 context dedupe: each distinct path-scoped
context is stored once per stablecoin in `currentFactContexts`. Resolve a task's
context with
`stablecoin.currentFactContexts[task.currentFactContextRef]`; an explicit `null`
still means no context was available. Different tasks of one work type may reference
different contexts. Task IDs, claim groups, routing, evidence and disappearance
sentinels are unchanged. Regenerate older registry artifacts rather than expecting
the removed per-task `currentFactContext` field. Do not re-inline whole-asset
surfaces into every task: that makes serialized size quadratic in task count and
can exceed V8's single-string limit. The reviewed ledger remains separate input
to human review, not embedded registry data. Schema 3 adds the documentation band,
per-root dust residuals, question keys, the issuer researched-terminal review state and
the deduplicated score-projection rows described next.

The Markdown worklist is a compatibility renderer over this typed routing contract;
it owns no reason-code classifier. The pre-expiry view likewise calls production's
exported `resolveReviewedReserveAdmission()` result instead of copying reserve-admission
rules. The packet carries the selected source references through evidence construction,
including expired named-report history; it is asset-local and never stored in `preparedById`.

**Documentation band.** A row whose witnesses cannot move a published score carries
`documentation: {class: "documentation", reason, policyRef, threshold}`; every other row
carries `null`. The classifier is `shared/lib/safety-score-v9/documentation.ts`, reading
policy `semantic.evidence.documentation`: six reasons in `reasonOrder` precedence
(`no-scoring-path`, `unknown-scores-as-no-credit`, `unscored-diagnostic`,
`coverage-label`, `immaterial-deployment`, `reserve-dust`), with the two bar reasons
taking their strict `<` percentage from `documentationImmaterialSharePct` and
`reserveDustBookSharePct`. The class is derived from facts the evaluator already reads,
and no scoring module may import it: it changes no `evidenceLevel`,
`limitedEvidenceCauses`, `limitingCauseGapIds`, reason treatment, cause, responsibility,
binding, cap, mixture weight or gap identity. An absent policy block, a non-open
obligation, an unresolvable owning control or exposure, a null share, a global or reserve
claim, a materiality-binding control, a route-scoped diagnostic on a route the evaluator
did not admit, or a datum that alone gates a pillar all classify as `null` (fail closed).

Each item also publishes `questionKey` (root-scoped; `null` for supplements and cause-D
rows) and `reviewState` (the issuer researched-terminal band: `{state, reviewedAtSec,
recheckAtSec}`, with `recheckAtSec = reviewedAt` plus the policy's
`reviewedResearchMaxAgeSec`, currently 365 days). The two bands partition the queue:
documentation wins, so a documentation row never joins the issuer band. A
researched-terminal row leaves the default drain for a dated recheck; its original
`reviewedAt` is preserved and never re-dated.

A root's 3f reserve-dust exposures keep their own `taskId`s and publish one visible
residual (`documentationResiduals[]` on the root card) with `questionKey`,
`rootAssetId`, `bucket`, `bookShare`/`bookSharePct`, `thresholdBookSharePct`,
`exposureKeys[]`, `datumGapIds[]`, `datumTaskIds[]` and `datumCount`. The merged residual
is documentation only while its total stays below
`reserveDustResidualMaxBookSharePct`; above that bar it is an open question. The residual
never subtracts work: the datum rows keep their band and their task IDs.

`summary` partitions without subtracting: `documentationItemCount`,
`documentationDatumCount` (compiled-fact rows only), `documentationQuestionCount`
(deduped root-scoped keys), `documentationReasonCounts` (all six reasons in vocabulary
order), `documentationResidualCount`, `documentationResidualDatumCount`,
`documentationOpenResidualCount` and `researchedTerminalItemCount`. `openItemCount`
keeps every datum, banded or not.

Drain documentation rows as documentation, never as score work. They close only when a
fresh replay stops classifying the datum — the threshold stops holding, the control
becomes binding, the route is admitted, or the composition becomes structured. Never
date-bump a custody question: with `retainExpiredScopedQuestions` on, a
`key-custody-independence` question older than 90 days
(`V9_SCOPED_QUESTION_MAX_AGE_SEC`) stays published as a `stale` `keyCustody` factor gap
carrying its authored `reviewedAt`, not the capture clock; its evidence is that
question's own review, and its cause, evidence level and score do not change. Retention
off restores the previous drop-at-90-days behavior. Custody is the only reason backed by
an expiring scoped question; every other reason is re-derived from its live predicate on
each capture.

The publication also annotates the derived-only case per card:
`openEvidence.byCard[].documentationOnlyLimited` lists `backing`/`control`/`exit`,
sorted. A pillar is listed only when it is `limited`, its `limitingCauseGapIds` is
non-empty, and every witness resolves locally or through `foreignCauseGaps` to a
documentation gap. A non-limited pillar, an empty witness list, one non-documentation or
unresolved witness, or a mix of documentation and unresolved ids keeps the pillar plain
"limited". The annotation creates no evidence level and no `displayEvidence` or
`scoringEvidenceLevel`: it is derived from the unchanged witnesses and cannot move a
score, grade, premium, cap, cause or binding.

**Score-projection dedupe.** Each `scoreProjectionGaps[]` row publishes the causal
obligations it resolves (`causalGapIds`), the obligations no compiled task covers
(`uncoveredCauseGapIds`), `coverageBasis` (`causal-gaps`, or the `work-type` fallback for
a row with no resolvable causal identity), `coveredByTaskIds` (compiled tasks of every
carried gap id, across work types, plus the supplement when one exists) and
`supplementalTaskId`/`requiresSupplementalTask`. The all-obligations rule is the
authority: a supplement is added only when at least one obligation has no compiled task,
or, for a row with no causal identity, when no compiled fact task of its exact work type
exists. Coverage by another work type removes a supplement; a mixed or uncovered
obligation set keeps it, so dedupe never hides independent work. `summary` publishes
`scoreProjectionCauseGapCount`, `scoreProjectionWorkTypeFallbackCount`,
`scoreProjectionSupplementRemovedCount` and
`scoreProjectionSupplementKeptForUncoveredCount`; read `uncoveredCauseGapIds` before
calling a removed supplement safe. The replay artifact must carry
`pipeline.evaluatedSet.assets[]` — pillar `reasons[]` (`code`, optional `cause`,
`causeGapIds`, `sourceGapId`) and Exit `routes[].scoringDisposition` — and the registry
fails closed when the evaluated set cannot supply the reasons it reads.

Mechanism overlays and component reviews use their actual evidence pin, never the capture clock. Date-only reviews wait until the next UTC midnight and temporarily re-attribute the same-day admission gap `method-unsupported`; exact UTC timestamps admit at that instant, not earlier. Both retain the 365-day expiry from the original review start (`worker/src/lib/safety-score-v9/extension-mechanism.ts`).

Work one whole `claimGroupId` (one asset and `workType`) at a time. Read the embedded
work-type definition and recommended skill, then verify all four boundaries:

1. **Identity:** local asset, chain, contract, wrapper/variant, and exact component or
   route identity; do not accept a symbol-only match where collisions are possible.
2. **Source:** primary dated evidence or pinned explorer/RPC observations, including
   the scope and date of a negative search.
3. **Safety/publication:** the fail-closed producer, admission, dependency, and
   publication gates, plus runtime readback where applicable. A source edit alone is
   not proof that production consumed it.
4. **Methodology:** the current method must permit the evidence or producer. Never
   weaken evidence standards or invent values to make a sentinel disappear.

Use the registry's embedded work-type definition for instructions, completion criteria,
recommended skill, cautions and touchpoints. Its source is `V9_MISSING_DATA_WORK_TYPES` in
`scripts/lib/safety-score-v9-missing-data-work-types.ts`; there is no second roster here.

Unsupported `mechanism-review:*` component gaps (`missing-pillar-evidence`) route to
the same `MECHANISM_REVIEW` work type as bounded mechanism gaps, including nested
constraints and newly registered archetype components; they need no per-key work type.

For a new work type, read its embedded definition and emitting code before deciding;
do not infer a resolution from its name. Resolution mode describes the work shape,
not the outcome: curation needs reviewed source evidence, runtime work needs a fresh
readback, mixed work needs both in that order, and methodology capability needs an
owner ruling.

Finish every reviewed claim group as exactly one of:

- **promote** — verified evidence or producer repair is ready. Record its source and
  change references and the relevant `doneWhenGapIdAbsent` or
  `doneWhenScoreReasonAbsent` sentinel. It becomes a closure only after a fresh
  production replay makes the sentinel disappear without an adverse replacement.
- **reject** — the candidate is wrong, unsafe, inadmissible, or a reviewed terminal
  external/structural blocker. Record evidence, rationale, and a concrete re-review
  trigger. Rejection normally leaves the public fact open.
- **defer** — a named prerequisite remains (for example issuer disclosure, owner
  ruling, reusable adapter, production observation, or source recovery). Record the
  blocker, owner, and a date or event trigger; never use an undated deferral. A
  deferral that has already landed an intermediate milestone may record it in the
  optional ledger field `deferState` — `structured-pending-production` (structuring
  merged; facts close only after a fresh production replay) or `shadow-collecting`
  (producer deployed in shadow; awaiting first production observation). The
  intermediate state never replaces the three-outcome decision itself.

Append the decision through the ledger CLI (`ledger-append`), the single append
path to `.github/artifacts/safety-score-missing-data-reviewed-ledger.json`:

```bash
npx tsx scripts/maintenance/ledger-append.ts --decisions <decisions.json> --write
```

Each entry uses the `decisionFields` roster declared in that file and links the stable
claim-group and task IDs to evidence, sentinels, review trigger, and `factsClosed`. The
CLI validates the roster and the current work-type/resolution-mode vocabulary, rejects
duplicates, requires at least one sentinel on a defer, and refuses a fourth identical
trailing outcome unless that group's recorded trigger demonstrably fired
(`--trigger-fired <claimGroupId>`) or its latest decision carries `unpark` evidence. It
previews unless `--write`; `--dry-run` is the explicit preview alias and conflicts with
`--write`. Never remove an old decision when a task disappears or returns; append another
decision. This ledger is authored review provenance and is not replaced when the
generated registry refreshes.

The full registry remains a credentialed maintenance artifact from the fresh
production capture. The sweep does not commit an aggregate snapshot or open a
snapshot PR; the issue and retained registry artifact are its outputs.

## 4b. Renew before the boundary, then check and book the ledger sentinels

The same replay also drives the renewal clock. Two by-UTC-week views call the production
resolvers of §4; both are optional flags on the existing CLI, and the default report
stays byte-identical:

```bash
npm run safety-score-v9:expiry-queue -- --replay "${replay}" --days 14 --by-week
npm run safety-score-v9:expiry-queue -- --replay "${replay}" \
  --horizon 2027-01-19 --by-week --output agents/sweep/expiry-queue-calendar.md
```

`--horizon D` means expiring **before** D's UTC midnight (`[clock, D)`); the named date
is excluded. It must be a real UTC date after the capture clock, and it conflicts with
`--days` (exit 2). `--by-week` groups upcoming rows by UTC Monday; these are calendar
weeks, not design action weeks, so 01-01…01-03 land in the 2026-12-28 week. `Renew by`
is the effective boundary date minus the documented 14-day lead time
(`RENEWAL_LEAD_TIME_DAYS`); only execution reviews, scoped control questions and the
supply-attribution families (plan, partition, row exclusion, native single route) carry
a lead-time class today, and every other family renders `—` until an owner assigns one.
Curated reserve compositions are not week-bucketed: their boundary stays owned by
`resolveReviewedReserveAdmission()` and they remain in the reserve queue under the same
window. Keep the horizon calendar a 30-day artifact, never the issue body.

**Renewal SLA.** Every score-eligible record whose boundary falls before 2027-01-19 is
renewed from current primary sources, or listed as an issuer wait with a date or event
trigger, within 48 hours of the sweep. A renewal re-verifies its evidence and writes its
own `reviewedAt`; an unchanged fact still needs a new dated source, and a composition
renewal re-verifies the composition. No date-bumps. Missing issuer evidence lapses
fail-closed and is listed, never softened or hidden by confidence changes. The
`DEP`/`RESV` drain and the live-withheld review stay the priority lanes.

**Incident reviews renew by stable identity.** Provider and issuer-surface negative
incident reviews renew on the policy's `reviewedResearchMaxAgeSec` budget (365 days):
the runtime currentness check (`negativeIncidentReviewIsCurrent()` in
`worker/src/lib/safety-score-v9/extension-incidents.ts`) admits a review only while the
clock is at or past both `reviewedAt` and `windowEndSec` and no further than that budget
from either, and the review's research evidence carries the same `maxAgeSec`. A renewal
row is keyed by the review's stable identity — `reviewId`, or the colon-form
`stableReviewId` from the incident-review key migration — never by a legacy control
digest: a metadata control change rotates the digest, so the review is re-authored under
its authored `(assetId, routeId, controlId|controlIds)` identity, and a `retired` row
renews nothing and never returns. Review windows follow the standing evidence contract:
the window starts at the lane's first activity, `windowEndSec` is one pinned instant no
later than `reviewedAt`, and an in-window operational incident is enumerated in the
finding rather than written as a negative. The v10.38 train ships this identity and its migration only;
certificate admission and provider/issuer lane closure (IR-1c) are v10.39, so the v10.38
sweep must not demand a certificate closure or read its absence as a failed renewal. Once
certificate admission lands, certificates roll with each screening cycle and exemptions
are point-in-time and bound to the disclosed exposure: neither is a renewal row.

**Ledger sentinels.** Check the reviewed ledger against the regenerated registry from the
same capture:

```bash
NODE_OPTIONS=--max-old-space-size=12288 npx --no-install tsx \
  worker/scripts/check-safety-score-v9-ledger-sentinels.ts \
  --registry "${registry}" \
  --ledger .github/artifacts/safety-score-missing-data-reviewed-ledger.json \
  --replay "${replay}" \
  --output agents/sweep/sentinel-resolutions.json \
  --markdown agents/sweep/sentinel-resolutions.md
```

The checker is report-only. It emits one row per claim group's latest appended decision
(greatest `reviewedAt`; ties to the later row) with `verdict`
(`closed`/`still-open`/`replaced-adversely`/`unverifiable`), a machine `reason`, a
separate `admission` axis (`verified`/`failed`/`not-applicable`/`unverifiable`),
`asOfSec`, `openItemCount` and the ledger decision index. `closed` requires every
machine-checkable sentinel absent, no adverse or successor match and no decisive block; a
narrative-only decision, an absent or unrated/quarantined asset, an unavailable registry
binding, or a capture that predates the decision is `unverifiable`, never closed.
`--replay` is the evidence gate: the artifact records `closureEvidence:
replay-verified`, the registry identity fingerprint and the registry bytes' `sha256`, and
the run fails when the binding does not match. Exit 0 means "report produced"; verdicts
are findings, not bookings, and the workflow appends nothing to the ledger. A `closed`
group with residual open items is legitimate (the decision is scope-limited); its row
carries `taskIds.closed` and the registry-derived `factsClosed`.

Booking is an operator PR with the sentinel-closure applier (`apply-sentinel-closures`). It
verifies the artifact's `registrySha256`, `closureEvidence: replay-verified`, identity
fingerprint, per-row `ledgerDecisionIndex` and the live ledger decision count, then
re-derives every sentinel and `factsClosed` from the registry itself. It previews by
default and appends only with `--write`:

```bash
npx tsx scripts/maintenance/apply-sentinel-closures.ts \
  --resolutions agents/sweep/sentinel-resolutions.json \
  --registry agents/sweep/missing-data-registry.json --write
```

| Checker row | Applier action |
| --- | --- |
| `closed` + `admission: verified` (structured-pending-production) | promote; every sentinel absent |
| `closed` + `admission: not-applicable` | promote; every sentinel absent |
| `still-open` + reason `sentinels-partially-absent` + `not-applicable` | partial promote; carries the open sentinels |
| `still-open` + `admission: failed` | skip `spp-admission-failed` (wait state; **no reject**) |
| `still-open` (other reasons), `replaced-adversely`, `unverifiable` | skip `verdict-not-bookable` |
| admission axis inconsistent with the ledger's `deferState` | skip `spp-state-mismatch` |

The applier refuses an artifact without replay evidence
(`closure-evidence-insufficient`), a stale decision index or count (`stale-ledger-basis`),
and any sentinel it can still find. Its reason rule is deliberately stricter than the
checker's successor rule, so a `closed` row may still skip as `sentinel-still-open`:
fail-closed, never a wrong booking, and the preview books fewer groups than the `closed`
headline. Approve the PR only after the preview names every skipped row. Never copy the
reviewer's `factsClosed`; the applier derives it.

All ledger writes go through the same `ledger-append.ts` rules: append-only history,
duplicate rejection, atomic write, optimistic SHA concurrency and the churn park rule.
The latest decision per group is the greatest `reviewedAt`, ties to the later append (the
checker uses the same selection). A fourth identical trailing outcome is rejected without
`unpark`, and `unpark` is not part of the decision-field roster. Parked groups leave the
default worklist streams but stay in the registry and in the sentinel check; list them
with the ledger's park state instead of deleting or re-opening them.

## 5. Check the live-withheld counterfactual

The expiry queue only answers whether a reviewed composition is about to stop being
admitted. Run the deterministic counterfactual report separately to answer what each
currently live-backed asset would publish if its producer went silent:

```bash
withheld="agents/v9-captures/live-withheld-${stamp}.md"
npm run safety-score-v9:live-withheld -- \
  --replay "${replay}" \
  --output "${withheld}"
```

The report replays one isolated transform per live-backed asset: it removes that
asset's live rows and provenance, adds the asset to `liveToFallbackCoins`, reseals
`baseInputGenerationId`, and runs the normal V9 compiler/evaluator. Isolation keeps
dependency scores from changing because an unrelated producer was withheld. Rows
are sorted with unknown supply first (asset-ID tie breaks), then known circulating
USD descending. Missing/null supply remains unavailable with a reason,
distinct from observed zero. Rows include live/fallback scores/grades, fallback
tier, evidence ceiling and binding-cap kind. Only eligible strict downgrades appear.
The report owns its clock, assessed count and no-live/already-fallback/baseline-gap/
fallback-gap/unchanged-or-upgrade census. An empty report means no assessed eligible
strict downgrades, not healthy feeds or no possible changes among excluded assets.

For replay artifacts containing access claim graphs, every graph must belong to the
full counterfactual input generation, including graphs on assets whose reserve rows
were not withheld. The report preserves captured access overlays and their evidence:
it validates each original graph against the source capture clock/generation, then
re-admits the complete graph through its schema at the unchanged frozen clock and
new full input generation. The normal fact-set compiler still validates all
evidence/status and clock/generation bindings. Invalid graphs fail the report;
they are never silently dropped. Reserve-dependent graph joins are evaluated against
the counterfactual facts, not copied supply weights. Graph-free captured overlays
retain the existing isolated target-rebuild behavior.

Graph-bearing counterfactuals build only the selected extension asset while retaining
the **full** active set and dependency-cycle context. The operator-only compiler
context admits the captured extension and compiles the current-code baseline once.
Each isolated withheld input still receives its own canonical identity validation.
Untouched compiled assets are reused only after checking that every other input and
overlay stayed unchanged; their cohort research evidence hashes and graph generation
IDs are rebound before full fact-set admission. The target, quarantined assets, and
assets affected by changed parent deployment identities use ordinary compilation.
The full dependency plan, common-mode membership, evaluation, public projection, and
quarantine/retry behavior still run for every scenario. Production does not enable
this reuse path. Withholding all producers together would change dependency semantics.

The workflow runs three isolated shard subprocesses (`--workers 3`), each with a
2 GiB V8 heap ceiling, while captures and full reports stay local.
Shards partition the sorted active asset IDs, never the scoring cohort.
`--shard i/n` emits a JSON shard;
repeat `--merge <shard.json>` to validate and merge a complete shard set. Missing,
duplicate or mixed-capture shards fail. Merged Markdown is byte-identical to the
unsharded report. Each asset logs start/completion/failure and elapsed milliseconds;
the CLI summary also logs total duration and peak RSS.

An unrecoverable `V9AssetEvaluationError` is isolated by this report only: it records
the withheld asset, `counterfactual-evaluation-failed`, error class and message, then
continues. The top-level report status becomes **partial**, with the failed-asset
table before the grade-drop rows so the sweep issue's bounded excerpt includes it.
Mixed outcomes exit zero (the status collector therefore records generator status
zero); this means a usable, explicitly partial queue, not complete assessment.
All attempted counterfactuals failing, malformed baseline input, or another generator
error still exits nonzero. A shard's all-failed result is judged only after merging,
so one empty/unassessable partition cannot discard successful sibling partitions.
Production evaluator and quarantine semantics are unchanged. Keep failed assets open
for an owner investigation; never interpret their absence from grade drops as feed
health. Do not raise the unchanged 25-minute step ceiling to mask a regression.
Acceptance requires one completed post-merge scheduled sweep with all eight generator
statuses successful, plus the issue and registry artifact.
A local replay or manual dispatch alone does not close scheduled-run acceptance.


Assets already present in `liveToFallbackCoins` are excluded: their producer
silence is already realized in this capture and is owned by the worklist/expiry
lanes. The report intentionally does not estimate live-feed headroom. Replay is
structurally blind to the upstream feed bound: `liveToFallbackCoins` was computed
at capture time, while `maxSourceAgeSec` is consumed by cron sync. The fixed
capture retains only live provenance `{ source, fetchedAt }`; upstream
`sourceTimestamp` is available in D1 `reserve_composition.metadata` and needs a
future operations lane to warn before demotion.

## 6. Close the weekly sweep

Record blockers outside the generated worklist; regenerate rather than checking off or
deleting its rows manually. Once reviewed changes are present in production, take a new
production capture and repeat the replay, worklist, pre-expiry extraction, and
counterfactual report.

| Check | Done when |
| --- | --- |
| `DEP` / `RESV` drain | Each supply-prioritized item disappeared or has a current, evidence-backed blocker. |
| Pre-expiry review | Every listed composition was refreshed, received a live snapshot, or has a documented blocker before its applicable production admission bound closes. |
| Live-withheld review | Each high-supply grade-drop row has a reviewed fallback path, a current producer action, or a documented blocker/escalation in the sweep issue. |
| Missing-data registry | Every reviewed claim group has a promote/reject/defer ledger entry; promoted facts count only after their exact sentinel disappears on a fresh production replay. |
| Renewal calendar | Every boundary before 2027-01-19 has a renewed record, a live snapshot, or a dated issuer wait; no record moved by a date-bump. |
| Ledger sentinels | Every `closed` group is booked through the applier PR or carries a recorded blocker; no `spp-admission-failed` row was booked as a reject. |
| Measurement | The closing worklist, pre-expiry list, and counterfactual report come from one fresh capture replayed with its own `clockSec`. |


## Artifact hygiene

For manual runs, keep captures, replays, worklists, the full missing-data registry, and
queue output under `agents/v9-captures/`; automation uses ephemeral `agents/sweep/`.
Both are gitignored scratch. Never commit these multi-megabyte, point-in-time artifacts
or move them into `docs/`; re-export production input on every weekly sweep. The
append-only reviewed ledger preserves operator decisions. Follow the equivalence harness's
[artifact-hygiene contract](./safety-score-equivalence-harness.md#artifact-hygiene).

## Related

- [Safety Score V9 equivalence harness](./safety-score-equivalence-harness.md) — production capture and deterministic replay procedure.
- [Script inventory](../scripts.md) — capture, replay, diff, summary, curation-worklist, expiry-queue, and live-withheld CLI contracts.
