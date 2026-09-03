# Safety Score V9 Equivalence Harness

Operational procedure for proving that a code change either leaves published Safety Score V9 output unchanged or moves only a reviewed, declared set of grades.

The harness freezes one production compiler input, replays it through the V9 pipeline at two commits, and diffs the two replay artifacts. A refactor that is genuinely score-neutral produces an empty diff; anything else names the asset and the field that moved.

Every later task that says "verified against the harness runbook" means the procedure on this page.

## When to use it

| Situation                                                     | Gate                                      | Expected result                                  |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Score-neutral refactor, dedup, or extraction                   | `--assert-empty`                          | `EMPTY DIFF — bit-identical`                      |
| Intentional score change that must not change a grade          | `--assert-grade-stable`                   | Reported drift entries, zero grade flips          |
| Intentional release with reviewed grade changes                | `safety-score-v9:movers --assert-declared` | Every grade flip is declared with the observed direction |
| Before activating a score-neutral candidate stack in production | Pre-activation sweep                    | Both captures empty at both commits               |
| Immediately after a score-neutral cutover deploy               | Post-deploy check                         | Replay at the pre-cutover commit matches the live publication |

## Why the replay is a fair test

`prepare-safety-score-v9-input` writes the publication-exact compiler input to the private D1 cache row `report-cards:fixed-input:exact` in the logical `16,46` slot (a 30-minute producer cycle). `compute-safety-score-v9` reads that row at `22,52` and publishes `report-cards:v9`.

Two properties make the replay equal to production:

- The producer compiles the publication with `publishedAtSec = fixedInput.clockSec` in `worker/src/lib/safety-score-v9/publication-runner.ts`, which `worker/src/cron/compute-safety-score-v9.ts` invokes. Replaying with `--published-at <capture clockSec>` therefore reproduces the exact publication clock, not an approximation; use the symbol rather than a brittle source line as the maintenance anchor.
- `worker/scripts/replay-safety-score-v9.ts` compiles that input through the same pipeline with no network, D1, or wall-clock reads. The artifact is a pure function of (capture, `--published-at`, code) — two replays of one capture at one commit are byte-identical.

`worker/scripts/diff-safety-score-v9-replays.ts` drops two separately-owned key families at every depth — `VOLATILE_KEYS` (per-run publication identity and capture timing) and `VERSION_ACTIVATION_KEYS` (pinned-build and methodology-identity digests plus `policyVersion`, which move only on a deliberate version activation) — and matches per-asset cards by `id`, so a reordered or resized card array reports real drift instead of an index shift.

> **Any redemption row-shape change is a payload identity event and needs a baseline re-cut.**
> The redemption payload fingerprint hashes the *whole* stored row, not a V9-relevant projection of it.
> Adding, renaming, removing, or reordering a field on a redemption row therefore rotates the
> fingerprint even when no value the evaluator reads has changed — and an existing capture stops
> matching. Treat it like a registry edit: cut a fresh baseline capture on the new shape and diff
> against that, rather than reading the resulting drift as a scoring result or reaching for
> `--allow-registry-mismatch`. A declared-but-inert passthrough field is not exempt: inertness is a
> property of the evaluator, and the fingerprint is taken before the evaluator runs.

## Prerequisites

- A Wrangler session authorized for the production Cloudflare account with D1 read on `stablecoin-db`: interactive `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` in the environment. An expired session fails the export with:

  ```
  ✘ [ERROR] Not logged in. Your auth token has expired and could not be refreshed, and the
  environment is non-interactive. Run `wrangler login` in an interactive terminal or set a
  CLOUDFLARE_API_TOKEN.
  ```

  Do not improvise a credential. Re-authenticate in an interactive terminal, or stop and report the export as blocked.

- `jq`.
- `PHAROS_API_KEY` (ignored root `.env.local`) for the post-deploy step; `GET /api/report-cards/v9` requires `X-API-Key`.
- A working directory: `mkdir -p agents/v9-captures`. `agents/` is gitignored — see [Artifact hygiene](#artifact-hygiene).

## (a) Export a production capture

Run from `worker/` so Wrangler resolves `wrangler.toml`. First confirm the row exists and note its age, so you know which producer cycle you are about to freeze:

```sh
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --json \
  --command "SELECT key, updated_at, length(value) AS value_bytes
             FROM cache WHERE key = 'report-cards:fixed-input:exact'"
cd ..
```

Then export the row itself, stamping the file with the UTC time of the capture:

```sh
date_stamp="$(date -u +%Y%m%d-%H%M)"
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --json \
  --command "SELECT value FROM cache WHERE key = 'report-cards:fixed-input:exact'" \
  > "../agents/v9-captures/capture-${date_stamp}.raw.json"
cd ..
```

`--json` suppresses the Wrangler banner and emits a parseable array of result sets. The row is a compressed `gzip-base64` envelope that the producer refuses to store above 1,900,000 bytes, so this is a large but single-row read.

Strip the SQL wrapper. Either form is a valid replay input:

```sh
# Preferred: verify the envelope checksum, generation, capture kind, and schema,
# then write the normalized fixed input.
npm run report-cards:capture-fixed-input -- \
  --exact-cache-export "agents/v9-captures/capture-${date_stamp}.raw.json" \
  --output "agents/v9-captures/capture-${date_stamp}.json"

# Alternative: keep the compressed envelope verbatim. The replay CLI re-verifies
# it through the same production parser.
jq -r '(if type == "array" then .[0] else . end).results[0].value' \
  "agents/v9-captures/capture-${date_stamp}.raw.json" \
  > "agents/v9-captures/capture-${date_stamp}.envelope.json"
```

Read the capture's scoring clock — every replay of this capture uses it verbatim:

```sh
# From the normalized capture
jq -r .clockSec "agents/v9-captures/capture-${date_stamp}.json"

# From the compressed envelope
jq -r .payload "agents/v9-captures/capture-${date_stamp}.envelope.json" \
  | base64 -d | gunzip | jq -r .clockSec
```

Also record the capture's identity — `sourceGeneration` is present on both the envelope and the normalized capture, and the normalized capture additionally carries the content-derived `baseInputGenerationId`:

```sh
jq -r '{sourceGeneration, baseInputGenerationId, clockSec}' \
  "agents/v9-captures/capture-${date_stamp}.json"
```

Two captures sharing a `sourceGeneration` are the same producer cycle and do not count as two samples.

## (b) Replay a capture at a given commit

Check out the commit you want to measure, then:

```sh
clock_sec="$(jq -r .clockSec agents/v9-captures/capture-20260807-1500.json)"
commit="$(git rev-parse --short HEAD)"
npm run safety-score-v9:replay -- \
  --input agents/v9-captures/capture-20260807-1500.json \
  --output "agents/v9-captures/replay-${commit}-20260807-1500.json" \
  --published-at "${clock_sec}"
```

Name every artifact `replay-<commit>-<capture stamp>.json`. The commit is what the diff attributes drift to; a replay whose provenance is unclear is not evidence.

The replay writes canonical byte-stable JSON. The published response lives at `pipeline.candidate`; its `cards` array carries one card per asset.

### `--allow-registry-mismatch`

A capture records the registry fingerprint of the tree it was taken from, and the replay refuses to score it against a different registry. That refusal is what makes an ordinary replay a clean code-only measurement, so it must stay on by default. A frozen capture stops replaying after any change to the fully merged stablecoin registries—including base files, domain sidecars, lifecycle/listing inputs, or the dead registry—that rotates the fingerprint. `--allow-registry-mismatch` is the operator's explicit acceptance of that mismatch: the replay proceeds against the local registry rows and adopts the capture's registry identity so the pipeline's internal identity checks stay coherent. The resulting diff no longer isolates the code change — it measures **code and curation together**, and it must be partitioned by attribution (which drift entries belong to a methodology change, which to each curation commit, which to neither) before any of it is read as an equivalence result. An entry that lands in no attribution class is a finding, not noise. The flag is replay-only; the production publication path never sets it and its fingerprint check is unchanged.

## (c) Diff a baseline replay against a candidate replay

```sh
npm run safety-score-v9:diff -- \
  --baseline agents/v9-captures/replay-<baseline-commit>-<stamp>.json \
  --candidate agents/v9-captures/replay-<candidate-commit>-<stamp>.json \
  --assert-empty
```

| Mode                    | Passes when                                    | Stdout                                        | Exit |
| ----------------------- | ---------------------------------------------- | --------------------------------------------- | ---- |
| `--assert-empty`        | Every field matches after volatile-key removal | `EMPTY DIFF — bit-identical`                   | 0    |
| `--assert-empty`        | Anything moved                                 | `DIFF: N entries` plus up to 50 entries (stderr) | 1  |
| `--assert-grade-stable` | No card changes grade                          | `drift entries: N; grade flips: 0`             | 0    |
| `--assert-grade-stable` | A card changed grade, disappeared, or appeared | the same counts, plus one `FLIP <id>` line per card (stderr) | 1 |
| neither flag            | always                                         | the full JSON diff                             | 0 / 1 |

The two diff assertion flags are mutually exclusive. Use `--assert-empty` for score-neutral work and `--assert-grade-stable` when score drift is intentional but grade flips are not.

### Expected-movers gate for an intentional multi-grade release

When a reviewed release intentionally changes grades, neither diff assertion is the right contract. Run the same baseline and candidate replays, then compare their card sets with the mover gate:

```sh
npm run safety-score-v9:movers -- \
  --before agents/v9-captures/replay-<baseline-commit>-<stamp>.json \
  --after agents/v9-captures/replay-<candidate-commit>-<stamp>.json \
  --manifest agents/v9-captures/expected-movers-<stamp>.json \
  --json agents/v9-captures/movers-<stamp>.json \
  --markdown \
  --assert-declared
```

The manifest declares grade transitions, not score targets:

```json
{
  "movers": [
    {
      "id": "<asset-id>",
      "from": "<baseline-grade>",
      "to": "<candidate-grade>",
      "reason": "<reviewed causal reason>",
      "workstream": "<release workstream>"
    }
  ]
}
```

`--assert-declared` fails when an observed grade flip has no manifest row or when its observed `from`/`to` direction differs from the declaration. The report also shows same-grade score moves, pillar deltas, binding-cap changes, assets present on only one side, and manifest rows that did not flip. Those remain review findings, but the gate itself is deliberately limited to undeclared or misdirected grade flips; a declared-but-absent transition does not fail automatically and must be resolved before release.

Use this mode only after the expected set is derived from reviewed behavior and before looking at the candidate output. Do not turn an unexpected flip into a declaration merely to make the gate green. Multi-grade releases keep the same capture identity, fixed-clock replay, two-capture sampling, and artifact-hygiene rules as the equivalence harness; replace the empty-diff assertion with the declared-movers gate for each capture.

## (d) Pre-activation sweep

One capture proves the candidate stack reproduces one market state. It does not prove the change is neutral across the input variation the producer actually sees, so activation requires **two captures taken a few production cycles apart**.

1. Export capture **A** (step a).
2. Wait at least three producer cycles — the input job runs at `16,46`, so **≥ 90 minutes** — and export capture **B**. Confirm `sourceGeneration` differs between the two captures.
3. Replay each capture at baseline `main` and at the candidate stack head (four replays, each with its own capture's `clockSec`):

   ```sh
   git checkout main
   # replay A -> replay-<main>-A.json ; replay B -> replay-<main>-B.json
   git checkout <candidate-head>
   # replay A -> replay-<cand>-A.json ; replay B -> replay-<cand>-B.json
   ```

4. Run both diffs. Both must be empty:

   ```sh
   npm run safety-score-v9:diff -- --baseline agents/v9-captures/replay-<main>-A.json \
     --candidate agents/v9-captures/replay-<cand>-A.json --assert-empty
   npm run safety-score-v9:diff -- --baseline agents/v9-captures/replay-<main>-B.json \
     --candidate agents/v9-captures/replay-<cand>-B.json --assert-empty
   ```

A single empty diff is not authorization to activate. Two empty diffs across two independent production cycles are the sweep; anything less is an untested cutover.

## (e) Post-deploy first-cycle check

A green deploy proves Worker activation, not that the newly-live code republishes the same numbers. Close that gap on the **first** post-cutover publication.

1. Wait for the first complete producer pair after the cutover Worker version is live: `prepare-safety-score-v9-input` (`16,46`) followed by `compute-safety-score-v9` (`22,52`).
2. Export a post-cutover capture (step a) and fetch the publication that came from it:

   ```sh
   # Subshell so the sourced credentials do not outlive the fetch.
   ( set -a; . ./.env.local; set +a
     curl -sf "https://api.pharos.watch/api/report-cards/v9" \
       -H "X-API-Key: ${PHAROS_API_KEY}" \
       -o agents/v9-captures/live-v9-<stamp>.json )
   ```

   Confirm you are comparing the matching generation: the publication's `safetyScoreIdentity.baseInputGenerationId` must equal the capture's `baseInputGenerationId`. If the producer has already moved on, take a fresh pair rather than diffing across generations.

3. Replay the post-cutover capture at the **pre-cutover** commit (step b).
4. The served publication is an envelope around the same card objects, so project both sides to the card array the diff CLI keys on:

   ```sh
   jq '{pipeline:{candidate:{cards:.cards}}}' \
     agents/v9-captures/live-v9-<stamp>.json > agents/v9-captures/live-cards-<stamp>.json
   jq '{pipeline:{candidate:{cards:.pipeline.candidate.cards}}}' \
     agents/v9-captures/replay-<pre-cutover-commit>-<stamp>.json \
     > agents/v9-captures/replay-cards-<stamp>.json

   npm run safety-score-v9:diff -- \
     --baseline agents/v9-captures/replay-cards-<stamp>.json \
     --candidate agents/v9-captures/live-cards-<stamp>.json \
     --assert-empty
   ```

Expect bit-identical numbers. An empty diff means the code now live republished exactly what the pre-cutover code would have produced from the same input. A non-empty diff is a production regression, not a harness artifact: treat it as a rollback decision, not a triage backlog item.

## Triaging a non-empty diff

Work in this order:

1. **Is it real drift?** Every entry names an `assetId` (or `null` for aggregates and the dependency graph) plus the exact field path. A handful of entries on one pillar is a scoring change; hundreds across every asset is usually an input or identity problem.
2. **Is the diff pinned to one capture?** Re-run the same capture at the baseline commit twice. Two replays of one capture at one commit are byte-identical by construction — if they are not, the change introduced nondeterminism (a wall-clock read, an unstable sort, or map-iteration order), which is itself the bug.
3. **Is a volatile field leaking?** If the entries are publication identity or capture timing rather than scores, the field belongs in `VOLATILE_KEYS` (per-run) or `VERSION_ACTIVATION_KEYS` (version activation) — whichever matches why it moved — in `worker/scripts/diff-safety-score-v9-replays.ts`. Add the key there and to the exported-key list in `worker/scripts/__tests__/diff-safety-score-v9-replays.test.ts`, then re-run. Add keys only for values that legitimately differ between two replays of the same scored output — never to silence a score that moved.

## Artifact hygiene

Captures contain no secrets. They hold market and registry facts the producer already compiled: supply, DEX liquidity, redemption backstops, reserves, peg provenance, and their fingerprints. No API keys, tokens, or credentials enter the envelope.

They still stay untracked. All harness artifacts live under `agents/v9-captures/`, and `/agents/` is gitignored — the directory is scratch working space, not a committed corpus. Captures are multi-megabyte point-in-time snapshots that go stale within one 30-minute producer cycle; committing them would add weight to the repository and invite reviewers to trust a frozen artifact as current data. Re-export instead of reusing an old capture.

## Worked example

The toolchain has a credential-free self-test that exercises steps (b) and (c) end to end against the committed two-asset regression fixture. Run it before spending a production capture — it proves the replay is deterministic and the diff CLI is wired correctly.

```sh
mkdir -p agents/v9-captures
npx tsx -e "
import { writeFileSync } from 'node:fs';
import miniCapture from './worker/src/lib/__tests__/fixtures/safety-score-v9-rateable-mini-capture.json';
import { createReportCardsFixedInput } from './worker/src/lib/report-cards-fixed-input';
writeFileSync('agents/v9-captures/selftest-input.json', JSON.stringify(createReportCardsFixedInput(miniCapture.draft as never), null, 2));
"
jq -r .clockSec agents/v9-captures/selftest-input.json
```

```
1786233600
```

Two independent replays of that input at one commit:

```sh
# The fixture's clock is frozen while curation advances, so the future-review
# gate must be waived here — for this self-test only, never for a production capture.
npm run safety-score-v9:replay -- --input agents/v9-captures/selftest-input.json \
  --output agents/v9-captures/selftest-a.json --published-at 1786233600 --allow-future-reviews
npm run safety-score-v9:replay -- --input agents/v9-captures/selftest-input.json \
  --output agents/v9-captures/selftest-b.json --published-at 1786233600 --allow-future-reviews
jq '.pipeline.candidate.cards | length' agents/v9-captures/selftest-a.json
```

```
2
```

Each artifact is ~1.5 MB for two assets, and both share one SHA-256 — the replay is byte-deterministic.

```sh
npm run safety-score-v9:diff -- --baseline agents/v9-captures/selftest-a.json \
  --candidate agents/v9-captures/selftest-b.json --assert-empty
```

```
EMPTY DIFF — bit-identical
```

What real drift looks like — one card's score moved by one point:

```sh
jq '.pipeline.candidate.cards[0].score = (.pipeline.candidate.cards[0].score - 1)' \
  agents/v9-captures/selftest-a.json > agents/v9-captures/selftest-drift.json
npm run safety-score-v9:diff -- --baseline agents/v9-captures/selftest-a.json \
  --candidate agents/v9-captures/selftest-drift.json --assert-empty
```

```
DIFF: 1 entries
{"assetId":"usdc-circle","path":"cards[usdc-circle].score","baseline":20,"candidate":19}
```

Exit code 1. The same pair under the Wave-2 gate passes, because a one-point score move inside a grade band is not a grade flip:

```sh
npm run safety-score-v9:diff -- --baseline agents/v9-captures/selftest-a.json \
  --candidate agents/v9-captures/selftest-drift.json --assert-grade-stable
```

```
drift entries: 1; grade flips: 0
```

The fixture is a frozen two-asset sample built for pipeline coverage, not a rating sample; its grades and scores carry no meaning outside this self-test. A production sweep runs the identical commands against a real capture and its full asset set.

## Related

- [`docs/scripts.md`](../scripts.md) — CLI reference for the capture, replay, diff, and summary scripts.
- [`docs/worker-infrastructure.md`](../worker-infrastructure.md) — cron cadence and freshness bounds for the V9 producer jobs.
- [`docs/report-cards.md`](../report-cards.md) — the private cache keys behind the V9 publication.
- [`docs/data-flow-map.md`](../data-flow-map.md) — where `report-cards:fixed-input:exact` sits in the pipeline.
