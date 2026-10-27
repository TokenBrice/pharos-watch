# Safety Score V9 Curation-Expiry Sweep

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
expiry sweep" issue with bounded live-withheld/expiry/Dependencies/Backing excerpts
and registry counts. The full missing-data registry and expiry queue (even when
partial) are retained as 30-day artifacts; other reports are not uploaded. Replay and each of the four
reports have separate timed workflow steps and status outputs. The live-withheld
step has a 15-minute ceiling inside the unchanged 25-minute job budget, leaving
time for issue/artifact publication when that report times out. Missing status
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
cycle's missing snapshot live.

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

Registry schema 2 stores each distinct path-scoped context once per stablecoin in
`currentFactContexts`. Resolve a task's context with
`stablecoin.currentFactContexts[task.currentFactContextRef]`; an explicit `null`
still means no context was available. Different tasks of one work type may reference
different contexts. Task IDs, claim groups, routing, evidence and disappearance
sentinels are unchanged. Regenerate older registry artifacts rather than expecting
the removed per-task `currentFactContext` field. Do not re-inline whole-asset
surfaces into every task: that makes serialized size quadratic in task count and
can exceed V8's single-string limit. The reviewed ledger remains separate input
to human review, not embedded registry data.

The Markdown worklist is a compatibility renderer over this typed routing contract;
it owns no reason-code classifier. The pre-expiry view likewise calls production's
exported `resolveReviewedReserveAdmission()` result instead of copying reserve-admission
rules. The packet carries the selected source references through evidence construction,
including expired named-report history; it is asset-local and never stored in `preparedById`.

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

Append the decision to
`.github/artifacts/safety-score-missing-data-reviewed-ledger.json`. Each
entry uses the field roster declared in that file and links the stable claim-group and
task IDs to evidence, sentinels, review trigger, and `factsClosed`. Never remove an old
decision when a task disappears or returns; append another decision. This ledger is
authored review provenance and is not replaced when the generated registry refreshes.

The full registry remains a credentialed maintenance artifact from the fresh
production capture. The sweep does not commit an aggregate snapshot or open a
snapshot PR; the issue and retained registry artifact are its outputs.

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
health. Do not raise the unchanged 15-minute step ceiling to mask a regression.
Acceptance requires one completed post-merge scheduled sweep with all five generator
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
