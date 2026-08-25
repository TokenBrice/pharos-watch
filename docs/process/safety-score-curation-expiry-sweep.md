# Safety Score V9 Curation-Expiry Sweep

Run this sweep weekly to refresh the Safety Score V9 evidence-curation queue before
reviewed curated reserve compositions cross their 31-day freshness window plus the
fixed 7-day reporting grace. With the default 10-day lookahead, the pre-expiry queue
starts surfacing admitted compositions as they approach the 38-day effective bound,
normally around age 28 days.

Run every command from the repository root. Use one fresh production capture for the
entire sweep; do not combine worklists or dates from different producer cycles.

The sweep is also automated: `.github/workflows/curation-expiry-sweep.yml` runs this
procedure every Tuesday (and on manual dispatch) with the deploy pipeline's Cloudflare
credentials, then publishes the live-withheld counterfactual report, expiry queue, and
the worklist's Dependencies/Backing streams into the pinned "Safety Score curation
expiry sweep" issue. The workflow run fails when any generator breaks, so a green run
means the queues are trustworthy. Draining the queues stays operator work — follow the
steps below.

**Operator contract:** the sweep operator reviews and drains the `DEP`/`RESV`,
pre-expiry, and live-withheld rows weekly. Mark a high-supply counterfactual grade drop
as high priority in the pinned issue, record the next action or blocker before the next
producer cycle, and keep it open until the fallback path is reviewed.

## 1. Capture the current production input

Create `agents/v9-captures/`, then follow
[section (a) of the equivalence harness](./safety-score-equivalence-harness.md#a-export-a-production-capture)
exactly. Keep the normalized capture produced by
`report-cards:capture-fixed-input`; it contains the capture's authoritative `clockSec`.

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
  --published-at "${clock_sec}"
```

Do not substitute the operator's wall clock. The capture's `clockSec` is the production
publication clock and determines whether each review is admitted or expired.

Add `--allow-registry-mismatch` when HEAD curation postdates the captured registry
fingerprint, which is the sweep's normal condition; the replay otherwise hard-fails
on the fingerprint check. The automated workflow always passes it, because this sweep
reads worklist items rather than score equivalence.

## 3. Generate the worklist

```bash
worklist="agents/v9-captures/curation-worklist-${stamp}.md"
node scripts/maintenance/generate-safety-score-v9-curation-worklist.mjs \
  --replay "${replay}" \
  --output "${worklist}"
```

The generated streams are already ordered by descending circulating USD within each
stream. Treat `DEP` and `RESV` as the first-priority lanes and drain both before moving
to another stream:

| Order | Stream | Operator rule |
| --- | --- | --- |
| 1 | `DEP` + `RESV` | Take the highest-supply remaining item across these lanes; resolve upstream availability and exact relationship mapping for `DEP`, and refresh only from current evidence for `RESV`. |
| 2 | Remaining streams | Continue only after the current `DEP` and `RESV` queues have been reviewed or explicitly blocked. |

An item is cleared only when its reason code disappears from a fresh replay-generated
worklist. Do not hand-edit generated rows, date-bump a review without re-verifying its
composition, or hide an unresolved evidence gap by changing confidence.

## 4. Add the 10-day pre-expiry queue

The worklist reports gaps that already affect the replay. It does not list every still
admitted composition approaching expiry. Run this extraction against the same replay;
it lists compositions that remain admitted at the capture clock but will cross the
31-day composition window plus 7-day reporting grace within the requested lookahead,
for assets with no live reserve snapshot in that capture, sorted by descending supply:

```bash
npm run safety-score-v9:expiry-queue -- --replay "${replay}"
```

The queue is derived with the same admission gates production scoring uses, in
production order: `buildSafetyScoreV9ReviewedStaticReserveRows`, then (only when
the asset is in `fixedInput.liveToFallbackCoins`)
`buildSafetyScoreV9ReviewedAuditedFallbackReserveRows` and
`buildSafetyScoreV9ReviewedCuratedFallbackReserveRows`, or
`buildSafetyScoreV9ReviewedStandaloneReserveRows` when there is no live producer.
It is re-evaluated at the capture clock plus the lookahead (`--days`, default 10),
so it cannot drift from the 31-day window, the 7-day reporting grace, the
one-year audited admission path, or the D6 prudential path.
Only compositions that are admitted today and stop being admitted within the
lookahead are listed — currently-inadmissible compositions already surface in the
worklist's `RESV` and `DEP` streams and are deliberately excluded here.

The queue is about to become inadmissible, not about to lose evidence strength. An
audited fallback crossing its 38-day evidence bound remains admitted for the
one-year audited path; its strength/ceiling transition belongs to the
live-withheld counterfactual report below.

The columns are asset ID, evaluated-set circulating USD (drain priority, largest
first), curated `compositionAsOf`, age in days, whether the composition carries
dependency-creating collateral links, and the adapter state (`none` or
`silent-this-cycle`). Add these assets to the week's reserve-research queue even when
they have no current `RESV` or `DEP` row. A fresh live snapshot in a later cycle
removes the asset from this preventive queue; it does not retroactively make this
cycle's missing snapshot live.
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
are sorted by evaluated-set circulating USD and include live/fallback scores and
grades, the admitting fallback tier (`none` when no fallback is admitted), that
tier's evidence ceiling, and the counterfactual binding-cap kind. Only assets
whose counterfactual grade is strictly worse than their live grade are listed; an
asset that holds its grade under producer silence is omitted, so an empty report
means no live-backed asset would change grade.

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
| Pre-expiry review | Every listed composition was refreshed, received a live snapshot, or has a documented blocker before the 31-day window plus 7-day reporting grace closes. |
| Live-withheld review | Each high-supply grade-drop row has a reviewed fallback path, a current producer action, or a documented blocker/escalation in the pinned issue. |
| Measurement | The closing worklist, pre-expiry list, and counterfactual report come from one fresh capture replayed with its own `clockSec`. |


## Artifact hygiene

Keep captures, replays, generated worklists, and temporary queue output under
`agents/v9-captures/`. The entire `agents/` tree is gitignored scratch space. Never
commit these multi-megabyte, point-in-time artifacts or move them into `docs/`; re-export
production input on every weekly sweep. Follow the equivalence harness's
[artifact-hygiene contract](./safety-score-equivalence-harness.md#artifact-hygiene).

## Related

- [Safety Score V9 equivalence harness](./safety-score-equivalence-harness.md) — production capture and deterministic replay procedure.
- [Script inventory](../scripts.md) — capture, replay, diff, summary, curation-worklist, expiry-queue, and live-withheld CLI contracts.
