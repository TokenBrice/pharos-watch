# Safety Score V9 Curation-Expiry Sweep

Run this sweep weekly to refresh the evidence-curation queue before reviewed reserve
evidence loses admission. With the default 10-day lookahead, the preventive queue
re-evaluates the applicable source-strength, freshness, and whole-asset denominator
gates in production's `resolveReviewedReserveRows()`; expiry is not one universal
composition-age threshold.

Run every command from the repository root. Use one fresh production capture for the
entire sweep; do not combine worklists or dates from different producer cycles.

The sweep is also automated: `.github/workflows/curation-expiry-sweep.yml` runs this
procedure every Tuesday at 05:45 UTC (and on manual dispatch) with the deploy
pipeline's Cloudflare credentials. It updates or creates the "Safety Score curation
expiry sweep" issue with bounded live-withheld/expiry/Dependencies/Backing excerpts
and registry counts. Only the full missing-data registry is retained as a 30-day
artifact; full queue/report files are not uploaded. Generator/projection failures
fail the run, but green generation does not attest cache freshness.
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

The cache row must be fresh enough to represent the current producer cycle. If the row
is missing or unexpectedly old, stop and resolve the production-input problem instead
of generating a curation queue from stale evidence.

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
accepted/embedded-registry captures or `--registry-ref`. The workflow tracks summary
`jq` projection status along with every generator; failed projection fails the run
and prevents the summary PR. No scoring/publication authority is implied.

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

The queue is derived with the same admission gates production scoring uses, in
production order: `buildSafetyScoreV9ReviewedStaticReserveRows`, then (only when
the asset is in `fixedInput.liveToFallbackCoins`)
`buildSafetyScoreV9ReviewedAuditedFallbackReserveRows` and
`buildSafetyScoreV9ReviewedCuratedFallbackReserveRows`, or
`buildSafetyScoreV9ReviewedStandaloneReserveRows` when there is no live producer.
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

The columns are asset ID, evaluated-set circulating USD (drain priority, largest
first), curated `compositionAsOf`, age in days, whether the composition carries
dependency-creating collateral links, and the adapter state (`none` or
`silent-this-cycle`). Add these assets to the week's reserve-research queue even when
they have no current `RESV` or `DEP` row. A fresh live snapshot in a later cycle
removes the asset from this preventive queue; it does not retroactively make this
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

The Markdown worklist is a compatibility renderer over this typed routing contract;
it owns no reason-code classifier. The pre-expiry view likewise calls production's
exported `resolveReviewedReserveRows()` branch instead of copying reserve-admission
rules.

Date-only mechanism reviews are admitted only after their UTC day has elapsed (the elapsed-UTC-day guard in `worker/src/lib/safety-score-v9/extension-mechanism.ts`), so curate with the evidence date, never the capture date: a same-day promotion starts with the next capture and temporarily re-attributes the component `method-unsupported`.

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

Triage by the registry's typed `workType`:

| Work types | Required drain checks |
| --- | --- |
| `MECHANISM_REVIEW`, `ARCHETYPE_CLASSIFICATION` | Archetype, exact component proposition, issuer disclosure scope, review date, and strict evidence eligibility. |
| `RESERVE_COMPOSITION`, `RESERVE_SLICE`, `DEPENDENCY_REVIEW` | Latest primary report, composition date, slice materiality, custody, and dependency identity; never date-bump without re-review. |
| `EXIT_DEX_COVERAGE`, `EXIT_RUNTIME_ROUTE`, `EXIT_OUTPUT`, `EXIT_SETTLEMENT_BOUND` | Venue/token identity, callable route, notional/output semantics, supported method family, and runtime readback; batch reusable adapters/censuses. |
| `BRIDGE_ROUTE_REVIEW`, `BRIDGE_MATERIALITY` | Canonical deployment/bridge identity, chain support, materiality, controls, and producer refresh after curation. |
| `ACCESS_REVIEW`, `DEPLOYMENT_CONTROLS`, `MINT_AUTHORITY` | Exact contract/proxy and role scope, current authority, upgrade path, and dated primary/explorer evidence. |
| `ORACLE_BRANCH`, `ORACLE_PROFILE`, `PEG_INPUT` | Configured branch, source freshness, runtime availability, and fail-closed behavior. |
| `PARENT_RATEABILITY` | Canonical parent/dependency identity and proof that the score projection consumes it. |
| `CHAIN_SUPPLY` | Provider identity, price path, contracts and chain coverage for a current score-eligible circulating-USD observation; use `getCirculatingRawOrNull()`, preserve unavailable observations as null, and never add manual/on-chain/CMC/DEX supply overrides. |
| `OPERATIONAL_RESILIENCE` | Exact-asset overlay in `operational-resilience-overlays-v1.json`, review window, typed source confidence; live history is eligibility-only and unestablished performance stays null/not-reviewed. |
| `WRAPPER_ALLOCATION`, `WRAPPER_CONTROL_FACTS`, `WRAPPER_EXIT_FACTS` | Wrapper contract identity, then the factor's upstream surface: whole-allocation proof or custody profile, wrapper mint/upgrade/oracle/control review, or redemption terms and fresh exact unwind capacity. |
| `ASSET_COMPILATION` | Find the `safety_score_v9_asset_quarantined` replay warning and its `metadata.message`; repair the producer/adapter or curated data identity defect at its source, never curate around the quarantine, and confirm a fresh exact replay compiles the asset. |
| `IMPLEMENTATION_DATE` | Launch date of the currently scored mechanism boundary; conservative range end for fuzzy dates, cited source, and no predecessor launch when the mechanism was materially replaced. |

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
`.github/workflows/artifacts/safety-score-missing-data-reviewed-ledger.json`. Each
entry uses the field roster declared in that file and links the stable claim-group and
task IDs to evidence, sentinels, review trigger, and `factsClosed`. Never remove an old
decision when a task disappears or returns; append another decision. This ledger is
authored review provenance and is not replaced when the generated registry refreshes.

The workflow commits only the compact projection at
`.github/artifacts/safety-score-missing-data-registry-summary.json` through
the existing automated-refresh PR helper. It lives outside `.github/workflows/`
because the automation token has no `workflow` scope, and GitHub rejects token
pushes that touch that directory. The full multi-megabyte registry stays in
the workflow artifact. The compact snapshot is intentionally not `autoStage`: its
input is a fresh production capture that a pre-commit hook cannot reproduce.

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

The October 6, 2026 sweep's `Access graph must match the admitted clock and input
generation` failure is reproducible offline: replacing only the target asset in a
captured extension left other graphs at the original generation; native-input
narrowing additionally stamped the target with a one-asset generation. This was a
counterfactual transform defect, not evidence that the production capture itself was
incoherent. Graph-bearing native replays now rebuild the target using the full input,
which costs more than the graph-free one-asset rebuild; no admission gate is relaxed.

The executable sweep contract in
`worker/scripts/__tests__/curation-expiry-sweep-cli.test.ts` reads the workflow's capture
and generation commands and executes their actual entrypoints against a one-asset
frozen cache export. It covers normalization, replay, all four reports, shared
clock/fact-set identity, and the summary output/diff/PR permission boundary. The
worklist routing test derives completeness from the producer's `V9_REASON_CODES`;
the live-withheld tests cover native/legacy multi-asset graphs, fresh-build
equivalence, invalid graph rejection, and capture-time overlay preservation.

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
or move them into `docs/`; re-export production input on every weekly sweep. The only
committed point-in-time projection is the compact registry summary named above, while
the append-only reviewed ledger preserves operator decisions. Follow the equivalence harness's
[artifact-hygiene contract](./safety-score-equivalence-harness.md#artifact-hygiene).

## Related

- [Safety Score V9 equivalence harness](./safety-score-equivalence-harness.md) — production capture and deterministic replay procedure.
- [Script inventory](../scripts.md) — capture, replay, diff, summary, curation-worklist, expiry-queue, and live-withheld CLI contracts.
