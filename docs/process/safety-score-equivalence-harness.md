# Safety Score V9 Equivalence Harness

> **Agent navigation** — Grep the heading you need instead of reading wholesale: When to use it · Why the replay is a fair test · Prerequisites · (a) Export a production capture · [Historical release and data separation](#historical-release-and-data-separation) · [Local D1 and offline-object exercise](#local-d1-and-offline-object-exercise) · (b) Replay a capture at a given commit · (c) Diff a baseline replay against a candidate replay · (d) Pre-activation sweep · (e) Post-deploy first-cycle check · Triaging a non-empty diff · Artifact hygiene · Worked example · Related.

Operational procedure for proving that a code change either leaves published Safety Score V9 output unchanged or moves only a reviewed, declared set of grades.

The harness freezes one production compiler input, replays it through the V9 pipeline at two commits, and diffs the two replay artifacts. A refactor that is genuinely score-neutral produces an empty diff; anything else names the asset and the field that moved.

Every later task that says "verified against the harness runbook" means the procedure on this page.

## When to use it

| Situation                                                     | Gate                                      | Expected result                                  |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Score-neutral refactor, dedup, or extraction                   | `--assert-empty`                          | `EMPTY DIFF — normalized score-output equality`   |
| Intentional score change that must not change a grade          | `--assert-grade-stable`                   | Reported drift entries, zero grade flips          |
| Intentional release with reviewed grade changes                | `safety-score-v9:movers --assert-declared` | Every grade flip is declared with the observed direction |
| Before activating a score-neutral candidate stack in production | Pre-activation sweep                    | Both captures empty at both commits               |
| Immediately after a score-neutral cutover deploy               | Post-deploy check                         | Replay at the pre-cutover commit matches the live publication |

## Why the replay is a fair test

`prepare-safety-score-v9-input` writes the publication-exact compiler input to the private D1 cache row `report-cards:fixed-input:exact` in the logical `16,46` slot (a 30-minute producer cycle). `compute-safety-score-v9` reads that row at `22,52` and publishes `report-cards:v9`.

Two properties make the replay equal to production:

- The producer compiles the publication with `publishedAtSec = fixedInput.clockSec` in `worker/src/lib/safety-score-v9/publication-runner.ts`, which `worker/src/cron/compute-safety-score-v9.ts` invokes. Replaying with `--published-at <capture clockSec>` therefore reproduces the exact publication clock, not an approximation; use the symbol rather than a brittle source line as the maintenance anchor.
- Compilation is offline, with no network, D1, or wall-clock reads. SHA-addressed capture acquisition may read R2 and cache verified bytes locally. Capture-time replay freezes registry and input clocks, not checkout evaluator, policy or non-transfer overlays. Determinism is not historical production equivalence; frozen V3 parsing likewise preserves format/bytes, not historical evaluator output.

The prepare-time `report-cards:fixed-input:exact` row excludes compute-time supply attribution, both reserve and supply evidence journals, peg provenance, and transfer materiality. A deterministic base-only replay is not accepted-publication equivalence. Export the atomically retained accepted base and enrichment delta using `--accepted-cache-export` below, or use dependency-scenario `--mode plan` from [the offline scenario runbook](../runbooks/dependency-network.md#offline-scenario-workflow). Both paths fail closed on missing/mismatched retained rows. Preserve both journals' cause, responsibility and rejection metadata even though excluded from the base digest; explicit null transfer enrichment is not permission to load current observations.

Private peg provenance uses the historical `verifiedOnlyDiagnostic` field as a legacy-backfill-excluded scenario, not an all-verified score or a numerical upper bound. Low-provenance and unprovenanced live events remain included; only `legacy-backfill-unprovenanced` is omitted. Preserve exact seed/generation/clock binding and inclusive-result equality; the scenario never replaces the score-bearing inclusive peg row or exposes private event bytes.

`worker/scripts/diff-safety-score-v9-replays.ts` drops two separately-owned key families at every depth — `VOLATILE_KEYS` (per-run publication identity and capture timing) and `VERSION_ACTIVATION_KEYS` (pinned-build and methodology-identity digests plus `policyVersion`, which move only on a deliberate version activation) — and matches per-asset cards by `id`, so a reordered or resized card array reports real drift instead of an index shift.

Comparators reject missing card arrays, empty/duplicate IDs and inconsistent score/grade/status projections before normalization. Full replay artifacts additionally undergo pure schema, asset-set, generation, fact/result-digest and identity-coherence validation in `worker/scripts/lib/safety-score-v9-replay-validation.ts`. That layer does not compile or pin either artifact's policy/build to the current checkout.

The movers CLI lives at `worker/scripts/diff-safety-score-v9-movers.ts` behind the unchanged `safety-score-v9:movers` alias. Full-artifact validation parses the retained capture through its native v4 or legacy v3 schema before deriving the matching base-input digest; the compiler's narrower common projection is not an artifact admission contract.

For weekly retrospective production-history review, use the separate [Safety Score movement ledger](../scripts.md#safety-score-movement-ledger). It reads 120-day change-only compact publication rows and accepted/held attempt lineage, reports missing baselines, and labels identity boundaries as non-comparable rather than causal proof. It is not the `safety-score-v9:movers` frozen-input gate and does not substitute for replay/equivalence or exact accepted-publication reproduction; no pre-deployment journal history is backfilled.

Exact reproduction is a separate intended-revision operation: use a trusted checkout at the recorded source SHA, recorded policy/build, verified frozen registry, capture input/clock, expected output and accepted enrichment (both journals and explicit null transfer materiality). `reproduceSafetyScoreV9Replay` requires that context and verifies rebuilt pipeline equality. A normalized empty diff is not bit-identical artifact equality or expected-activation proof; independently check intended release identities.

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

### Accepted publication, including enrichment

Read both retained rows in **one SELECT** from `worker/`. Publication storage writes them atomically, so a single query cannot pair the base from one publication with the delta from another:

```sh
date_stamp="$(date -u +%Y%m%d-%H%M)"
cd worker
npx --no-install wrangler d1 execute stablecoin-db --remote --json \
  --command "SELECT key, value, updated_at FROM cache
             WHERE key IN ('report-cards:v9:accepted-replay-base:v1',
                           'report-cards:v9:accepted-replay:v1')" \
  > "../agents/v9-captures/accepted-${date_stamp}.raw.json"
cd ..
npm run report-cards:capture-fixed-input -- \
  --accepted-cache-export "agents/v9-captures/accepted-${date_stamp}.raw.json" \
  --output "agents/v9-captures/accepted-${date_stamp}.json"
```

The capture CLI requires one successful query result, exactly one row per retained key, equal retention timestamps, the retained base's scoring clock, checksum-valid envelopes, matching base/publication generations and matching pipeline-gap identity. It exports `kind:"safety-score-v9-accepted-publication-capture"` with the restored fixed input, retained `publicationGenerationId`, raw transfer generation (including rejected observations), and a fingerprint-verified registry snapshot. Supply and journal projections are restored verbatim; partial transfer packets stay partial. This is restoration, not a new supply producer or a change to methodology.

If the local registry no longer matches production, pass `--registry-ref <capture-time-git-sha>` to capture; do not substitute today's registry or combine a current delta with an older base. Replay consumes the embedded registry snapshot for accepted captures as it does for registry captures. Historical accepted captures without an embedded snapshot remain supported with the existing explicit registry-ref/current-curation replay modes. As with every replay, current evaluator/policy and non-transfer overlays still come from the checkout: accepted bytes do not alone prove equality to a historical production score.

```sh
clock_sec="$(jq -r '.fixedInput.clockSec' "agents/v9-captures/accepted-${date_stamp}.json")"
npm run safety-score-v9:replay -- \
  --input "agents/v9-captures/accepted-${date_stamp}.json" \
  --published-at "$clock_sec" \
  --output "agents/v9-captures/accepted-${date_stamp}.replay.json"
```

`--accepted-cache-export` is mutually exclusive with `--exact-cache-export` and `--normalized-only`; neither a single prepare-time envelope nor a base-only normalized export can claim accepted-publication enrichment.

### Historical release and data separation

Archiving is **best effort** after the accepted publication commits: every successfully indexed generation has an R2 object containing the exact compressed base, delta and accepted-card cache strings. Failed/skipped archives can leave permanent coverage gaps when later publications overwrite the live retained rows; an index-write failure can leave an undiscoverable R2 orphan. `list --gaps` exposes accepted attempts without an archive index while their 120-day journal evidence remains available, not missing/pruned journal attempts or index-present missing objects. The enabled `pharos-measurements` lifecycle rule `180d-capture-cleanup`, covering `captures/` with a 180-day delete age, was verified on **2026-10-08**; it is **external account state**, not created or continuously established by this migration/CLI. D1 index pruning uses the publication-age window, while R2 expiry uses object upload age and asynchronous lifecycle deletion. There are no sampling tiers, retry backfills or pre-deployment captures. An index row is not proof that an object is still retrievable: export fails on missing objects, checksum/byte-count mismatch or identity drift. See [the archive CLI contract](../scripts.md#safety-score-historical-capture-archive).

To measure a release against historical data, take the **exact UTC deployment instant from its deployment record**, resolve the last **archived** publication strictly before it, export its paired inputs and accepted publication, restore the capture, and replay on the candidate checkout. A calendar date alone selects midnight and is not the boundary of an intraday release:

```sh
mkdir -p agents/v9-captures/historical
# Replace this example with the exact deployment timestamp from the deployment record.
release_time="2026-10-08T12:00:00Z"
# Audit retained accepted-attempt gaps around the deployment before claiming complete coverage.
npx tsx worker/scripts/export-safety-score-capture-archive.ts list \
  --from 2026-10-07 --to 2026-10-09 --gaps \
  > agents/v9-captures/historical/coverage.json
npx tsx worker/scripts/export-safety-score-capture-archive.ts boundary \
  --before-time "$release_time" > agents/v9-captures/historical/index.json
generation="$(jq -r .generation_id agents/v9-captures/historical/index.json)"
npx tsx worker/scripts/export-safety-score-capture-archive.ts export \
  --generation "$generation" \
  --output agents/v9-captures/historical/accepted.raw.json \
  --cards-output agents/v9-captures/historical/accepted.cards.json
npm run report-cards:capture-fixed-input -- \
  --accepted-cache-export agents/v9-captures/historical/accepted.raw.json \
  --output agents/v9-captures/historical/capture.json
# If registry admission fails, rerun capture with --registry-ref <trusted-capture-time-sha>.
# Do not bypass the fingerprint check or substitute the current registry.
clock_sec="$(jq -r .fixedInput.clockSec agents/v9-captures/historical/capture.json)"
npm run safety-score-v9:replay -- \
  --input agents/v9-captures/historical/capture.json --published-at "$clock_sec" \
  --output agents/v9-captures/historical/candidate.replay.json

# The diff CLI expects pipeline.candidate on BOTH sides. Accepted cards are a
# publication, not a full replay: compare the same explicit projection.
jq '{pipeline:{candidate:.}}' agents/v9-captures/historical/accepted.cards.json \
  > agents/v9-captures/historical/accepted.projection.json
jq '{pipeline:{candidate:.pipeline.candidate}}' agents/v9-captures/historical/candidate.replay.json \
  > agents/v9-captures/historical/candidate.projection.json
npm run safety-score-v9:diff -- \
  --baseline agents/v9-captures/historical/accepted.projection.json \
  --candidate agents/v9-captures/historical/candidate.projection.json
```

`--before-time` accepts nonnegative integer Unix seconds or a validated ISO-8601 timestamp ending in `Z` (seconds with optional millisecond precision), and compares publication clocks strictly before that instant. Existing `--before YYYY-MM-DD` retains its UTC-midnight semantics. The `--before build:<digest>`, `policy:<digest>` and `methodology:<version>` selectors are **retrospective**: they find the predecessor of an already archived transition into an identity, not an unpublished future release boundary. Permanent archive gaps mean the selected row is the latest known archived input, not necessarily the immediately preceding accepted production publication.

This is the **release delta on the archived input**, including checkout evaluator/policy and non-transfer overlays. The comparator reports normalized candidate-output drift, not bit-identical bytes, a complete full-replay diff, or proof that a particular code edit caused each change. Identity keys are normalized separately; check the intended candidate build/policy identities independently. The archive contains exact accepted output, but not a source commit or the complete historical checkout. To check historical equivalence, run the same capture under a trusted checkout matching the recorded methodology/policy/build and its capture-time curation, project that replay identically, then diff against `accepted.projection.json` with `--assert-empty`. Resolve the matching source revision from deployment/release records; never infer it from a digest or claim a current-build replay reproduces an older build.

For **data deltas**, select consecutive archived generations with unchanged methodology, policy digest and evaluation-build digest (`list --from ... --to ...` exposes those identities), export both accepted cards, wrap each as `{pipeline:{candidate:<publication>}}`, and diff them. This reports observed same-identity publication movement, including data/operational effects; it does not establish independent causal attribution, and missing archive rows prevent a claim of consecutive production coverage. Replaying both captures under one candidate build similarly measures its response to those two inputs without mixing in a build boundary. Do not compare a pre-release capture with a post-release capture and call the entire difference a release effect.

#### Local D1 and offline-object exercise

The exporter supports `--local` for its index and `--source-dir` for exact object bytes, so the same real archived generation can be exercised without production writes. First obtain `historical/index.json` with the remote `boundary` command above (or save a selected real index row from `list`). From the repository root, with read-capable R2 measurement credentials in the environment, download its object and prepare a **local-only** index fixture:

```sh
node --import tsx --input-type=module <<'NODE'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createR2MeasurementsClient } from './scripts/lib/r2-measurements-client.ts';
import { sqlString } from './scripts/lib/remote-d1.ts';
import { SafetyScoreCaptureArchiveIndexSchema, archiveObjectKey } from './worker/scripts/lib/safety-score-capture-archive.ts';
const row = SafetyScoreCaptureArchiveIndexSchema.parse(JSON.parse(readFileSync('agents/v9-captures/historical/index.json', 'utf8')));
if (row.r2_key !== archiveObjectKey(row)) throw new Error('archive key mismatch');
const bytes = await createR2MeasurementsClient().get(row.r2_key);
if (bytes === null) throw new Error('archived R2 object unavailable');
const path = resolve('agents/v9-captures/historical/objects', row.r2_key);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, bytes);
const columns = ['generation_id', 'published_at', 'methodology_version', 'policy_digest',
  'evaluation_build_digest', 'r2_key', 'object_sha256', 'object_bytes', 'archived_at'];
const values = columns.map(name => typeof row[name] === 'number' ? String(row[name]) : sqlString(row[name]));
writeFileSync('agents/v9-captures/historical/local-index.sql',
  `INSERT OR REPLACE INTO safety_score_capture_archive (${columns.join(',')}) VALUES (${values.join(',')});\n`);
NODE

# Apply 0263 once to the LOCAL database if this table is not already present.
# These --file writes are ONLY local fixture setup, never a remote inspection.
(cd worker && npx wrangler d1 execute stablecoin-db --local \
  --file migrations/0263_safety_score_capture_archive.sql)
(cd worker && npx wrangler d1 execute stablecoin-db --local \
  --file ../agents/v9-captures/historical/local-index.sql)
generation="$(jq -r .generation_id agents/v9-captures/historical/index.json)"
npx tsx worker/scripts/export-safety-score-capture-archive.ts export \
  --local --source-dir agents/v9-captures/historical/objects \
  --generation "$generation" \
  --output agents/v9-captures/historical/accepted.raw.json \
  --cards-output agents/v9-captures/historical/accepted.cards.json
```

Continue with the `report-cards:capture-fixed-input`, replay, projection and diff commands above. The local exercise consumes the same recorded checksums/identities and verifies the same bytes; it is not a deployment or a remote migration. The source directory preserves the complete R2 key under its root, not just the generation filename. A pruned/missing real row or object is an unavailable historical input, not permission to fabricate a fixture and describe it as production evidence.


### Prepare-time base only

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
# then write a registry-bound capture wrapper containing the normalized fixed input.
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
jq -r '(.fixedInput // .).clockSec' "agents/v9-captures/capture-${date_stamp}.json"

# From the compressed envelope
jq -r .payload "agents/v9-captures/capture-${date_stamp}.envelope.json" \
  | base64 -d | gunzip | jq -r .clockSec
```

Also record the capture's identity — `sourceGeneration` is present on both the envelope and the normalized capture, and the normalized capture additionally carries the content-derived `baseInputGenerationId`:

```sh
jq -r '(.fixedInput // .) | {sourceGeneration, baseInputGenerationId, clockSec}' \
  "agents/v9-captures/capture-${date_stamp}.json"
```

Two captures sharing a `sourceGeneration` are the same producer cycle and do not count as two samples.

## (b) Replay a capture at a given commit

Check out the commit you want to measure, then:

```sh
clock_sec="$(jq -r '(.fixedInput // .).clockSec' agents/v9-captures/capture-20260807-1500.json)"
commit="$(git rev-parse --short HEAD)"
npm run safety-score-v9:replay -- \
  --input agents/v9-captures/capture-20260807-1500.json \
  --output "agents/v9-captures/replay-${commit}-20260807-1500.json" \
  --published-at "${clock_sec}"
```

Name every artifact `replay-<commit>-<capture stamp>.json`. The commit is what the diff attributes drift to; a replay whose provenance is unclear is not evidence.

The replay writes canonical byte-stable JSON. The published response lives at `pipeline.candidate`; its `cards` array carries one card per asset.

Asset-local extension or fact failures do not abort a replay: the asset is quarantined to producer-failed NR, exactly as the producer would publish it, and named in `pipeline.quarantines` with its code and `<field path>: <reason>` message; its dependents appear in `pipeline.quarantineAffectedAssetIds`. Check both before diffing. A quarantine in a replay of an older capture against newer curation — for example a review dated after the capture clock — is a replay artifact, not a regression, and must be read like the future-dated reserve reviews that the replay CLI refuses without `--allow-future-reviews`.

### Capture-time registry replay

Prepare-time `report-cards:capture-fixed-input --exact-cache-export` exports wrap the normalized input as
`{kind:"safety-score-v9-registry-capture", fixedInput, registrySnapshot}`.
Accepted exports use `{kind:"safety-score-v9-accepted-publication-capture", publicationGenerationId, fixedInput, transferMaterialityGeneration, registrySnapshot}`.
The snapshot contains the full active/frozen/dead registry identity projection,
its recomputed fingerprint, and separately digest-bound transfer reviews.
Keeping full registry rows rather than a flag-only projection lets replay
recompute the original fingerprint, not merely trust a claimed identity.
This is an operator export format; the production D1 envelope is unchanged.

For an older capture with only a fingerprint, supply a trusted local commit:

```sh
npm run safety-score-v9:replay -- \
  --input agents/v9-captures/capture-20260904-1100.json \
  --output agents/v9-captures/replay-registry-20260904.json \
  --published-at 1788509806 \
  --registry-ref 83ee5baede53181d2fc07fd43a7acd103f0f562f
```

`--registry-ref` accepts a 7–40-character lowercase hexadecimal commit SHA.
The loader exports that commit's `shared/` and catalog-generation scripts to
ignored scratch under `agents/v9-captures/registry-scratch/`, rebuilds its
catalog, computes the registry fingerprint with the generator's shared
algorithm, and removes the temporary tree even on failure. It never fetches
Git history. Only use trusted local commits: their catalog loader executes.
The same flag on `report-cards:capture-fixed-input` embeds that verified registry.
Without the flag, export verifies the local registry before embedding it;
a mismatch requires the correct ref, never an invented snapshot.

Replay uses an embedded snapshot automatically. If both it and a ref are
present, registry fingerprints and transfer-review digests must agree.
Malformed snapshots, missing refs, and capture/snapshot mismatches fail closed.
The NAV validator and baseline extension use snapshot classifications and
metadata, never today's classifications. No NAV rows are discarded.
Every ordinary replay preserves captured redemption observations and base generation.
Only `--rederive-current-redemption` requests the current-producer scenario for
undisclosed-reviewed fee rows; it reseals changed bytes and records the source generation.
The option is rejected with accepted captures, embedded registry wrappers or `--registry-ref`.

The registry fingerprint does **not** identify every V9 overlay or the evaluator.
Transfer reviews are loaded from the same ref and separately digest-bound to
avoid future-dated live reviews; policy, other V9 overlays, and evaluation-build
identity remain checkout-owned. Retain the original publication and evaluator
revision for a production-result comparison. See the recovered capture mapping
and digest limitations in [V9 readiness](./safety-score-v9-readiness.md#recovered-capture-time-registries).

`--normalized-only` retains the plain normalized export for current-curation
workflows such as the expiry sweep. It cannot be combined with `--registry-ref`.

### `--allow-registry-mismatch`

A capture records the registry fingerprint of the tree it was taken from, and the replay refuses to score it against a different registry. That refusal is what makes an ordinary replay a clean code-only measurement, so it must stay on by default. A frozen capture stops replaying after any change to the fully merged stablecoin registries—including base files, domain sidecars, lifecycle/listing inputs, or the dead registry—that rotates the fingerprint. `--allow-registry-mismatch` is the operator's explicit acceptance of that mismatch: the replay proceeds against the local registry rows and adopts the capture's registry identity so the pipeline's internal identity checks stay coherent. The resulting diff no longer isolates the code change — it measures **code and curation together**, and it must be partitioned by attribution (which drift entries belong to a methodology change, which to each curation commit, which to neither) before any of it is read as an equivalence result. An entry that lands in no attribution class is a finding, not noise. The flag is replay-only; the production publication path never sets it and its fingerprint check is unchanged.

With a registry-bound wrapper, `--allow-registry-mismatch` explicitly selects the
local registry instead of the embedded snapshot (snapshot integrity remains checked).
It remains a code-plus-current-curation comparison with existing NAV validation,
but does not implicitly rederive redemption. To request that scenario, use a plain
normalized capture with `--allow-registry-mismatch --rederive-current-redemption`.
Combining mismatch with `--registry-ref` is rejected.

## (c) Diff a baseline replay against a candidate replay

```sh
npm run safety-score-v9:diff -- \
  --baseline agents/v9-captures/replay-<baseline-commit>-<stamp>.json \
  --candidate agents/v9-captures/replay-<candidate-commit>-<stamp>.json \
  --assert-empty
```

| Mode                    | Passes when                                    | Stdout                                        | Exit |
| ----------------------- | ---------------------------------------------- | --------------------------------------------- | ---- |
| `--assert-empty`        | Every field matches after identity-key removal | `EMPTY DIFF — normalized score-output equality` | 0 |
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

Manifest IDs must be unique/nonempty, grade/status transitions supported/coherent, and rationale/workstream nonempty. Malformed declarations fail before mapping; this does not strengthen `--assert-declared` into an exact-manifest/census gate. Manually close absent declarations, appeared/disappeared assets and same-grade findings.

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

Choose the branch by the reviewed release contract. A neutral release retains the pre-cutover comparison below; a release with intentional movers must instead prove **same-code accepted-publication equivalence** and evaluate pre-cutover movers separately.

### Neutral release: pre-cutover comparison

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

### Intentional movers: accepted-publication equivalence, then attribution

Do not compare the live publication with pre-cutover code using `--assert-empty`: reviewed methodology changes are expected to move numbers. That does not relax the empty-diff requirement between the **exact deployed code** and its accepted live publication.

1. Retain the first complete producer pair starting after actual Worker activation: `prepare-safety-score-v9-input` (`16,46`), then `compute-safety-score-v9` (`22,52`). Record their Worker version, execution outcomes, and generation/publication metadata. Require the first accepted publication from that pair; a held, skipped, deferred, or failed cycle is not acceptance, and a later success does not erase it.
2. At the exact deployed tree, export the accepted publication and its retained **base plus compute-time enrichment delta**, not the mutable prepare-time capture from step (a):

   ```sh
   # Read-only plan; credentials remain scoped to the subshell.
   ( set -a; . ./.env.local; set +a
     node --import tsx worker/scripts/compute-dependency-scenarios.ts \
       --mode plan \
       --out-dir agents/v9-captures/post-deploy-<stamp> )
   ```

   This saves `publication.json` and `capture.json` using `report-cards:v9:accepted-replay-base:v1` and `report-cards:v9:accepted-replay:v1`; see the [accepted-capture contract](../runbooks/dependency-network.md#offline-scenario-workflow). Plan fails closed if either retained row is absent or mismatched. Export promptly because only one accepted generation is retained. Require the capture's publication generation and fixed-input base generation to match the saved live identity and the recorded first pair. If the generation advances during collection, obtain a fresh matching pair but preserve the first-cycle evidence and report its equivalence check as unproven; never label a later capture as the first publication. Do not run scenario compute or publish merely to obtain this check.
3. Verify exact deployed-code/live identity **outside the normalized-card diff**, which deliberately removes activation and digest fields. Require public `methodology.version` and `safetyScoreIdentity.policyVersion` to equal the deployed release version, and require `safetyScoreIdentity.evaluationBuildDigest`, `policy.id`, and `policy.semanticDigest` to equal the exact deployed tree's reviewed build and policy identities. Record the registry fingerprint, complete `sourceGenerations`, `publicationGenerationId`, `baseInputGenerationId`, `factSetDigest`, `resultDigest`, `asOfSec`, `publishedAtSec`, `source.candidateId`, and top-level `updatedAt`; correlate them with the accepted capture and the first pair. Use refreshed identities if review fixes changed the final deployed tree, not obsolete review-head digests.
4. Replay that accepted capture at the **exact deployed commit**, preserving enrichment and transfer materiality and using `capture.json.fixedInput.clockSec` verbatim:

   ```sh
   npm run safety-score-v9:replay -- \
     --input agents/v9-captures/post-deploy-<stamp>/capture.json \
     --output agents/v9-captures/post-deploy-<stamp>/replay-deployed.json \
     --published-at <captured-clockSec>
   ```

   Require replay candidate `publicationGenerationId`, `baseInputGenerationId`, `evaluationBuildDigest`, `candidateId`, `factSetDigest`, `resultDigest`, and `publishedAtSec` to equal the accepted live counterparts (the candidate/fact/result digests are also exposed under `source`, and the publication clock under `updatedAt`). Then project both sides to cards and require an empty normalized diff:

   ```sh
   jq '{pipeline:{candidate:{cards:.cards}}}' \
     agents/v9-captures/post-deploy-<stamp>/publication.json \
     > agents/v9-captures/post-deploy-<stamp>/live-cards.json
   jq '{pipeline:{candidate:{cards:.pipeline.candidate.cards}}}' \
     agents/v9-captures/post-deploy-<stamp>/replay-deployed.json \
     > agents/v9-captures/post-deploy-<stamp>/replay-cards.json
   npm run safety-score-v9:diff -- \
     --baseline agents/v9-captures/post-deploy-<stamp>/replay-cards.json \
     --candidate agents/v9-captures/post-deploy-<stamp>/live-cards.json \
     --assert-empty
   ```

   Any same-code identity or normalized-card mismatch is a production regression and a rollback decision, not an expected methodology mover.
5. Separately replay the accepted capture at the pre-cutover and deployed code/curation attribution boundaries, using the same captured clock and explicit registry handling for each tree (step b). Apply the reviewed [expected-movers gate](#expected-movers-gate-for-an-intentional-multi-grade-release), not a pre-cutover empty-diff assertion:

   ```sh
   npm run safety-score-v9:movers -- \
     --before agents/v9-captures/post-deploy-<stamp>/replay-pre-cutover.json \
     --after agents/v9-captures/post-deploy-<stamp>/replay-deployed.json \
     --manifest agents/v9-captures/expected-movers-<stamp>.json \
     --assert-declared
   ```

   Freeze declarations from reviewed methodology and attribution before inspecting live output; never declare an unexpected mover to turn the gate green. Resolve declared-but-absent moves and explain differences caused by the captured clock or market state rather than requiring historical capture totals forever. Report accepted-publication equivalence and reviewed mover attribution as separate results; neither substitutes for the other.

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
import { createReportCardsFixedInput } from './worker/src/test-helpers/report-cards-fixed-input';
writeFileSync('agents/v9-captures/selftest-input.json', JSON.stringify(createReportCardsFixedInput(miniCapture.draft as never), null, 2));
"
jq -r .clockSec agents/v9-captures/selftest-input.json
```

```
1788566400
```

Two independent replays of that input at one commit:

```sh
# The fixture's clock is frozen while curation advances, so the future-review
# gate must be waived here — for this self-test only, never for a production capture.
npm run safety-score-v9:replay -- --input agents/v9-captures/selftest-input.json \
  --output agents/v9-captures/selftest-a.json --published-at 1788566400 --allow-future-reviews
npm run safety-score-v9:replay -- --input agents/v9-captures/selftest-input.json \
  --output agents/v9-captures/selftest-b.json --published-at 1788566400 --allow-future-reviews
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
