# Dependency Network Operations

## Scope and Commands

The [Dependency Map contract](../dependency-map.md#dependency-coverage-audit) owns graph semantics and curation. This runbook owns the weekly production audit and monthly queue drain. The map publishes serial/basket relationships from the accepted Safety Score V9 graph; authored relationships and current live reserves can differ from a held publication.

Run a read-only report against current production inputs:

```bash
npm run audit:coverage -- --domain=dependency-coverage --prod
```

Without `--prod`, the report covers the authored registry. The local gate is `npm run check:dependency-review-gaps`, included in `check:structural`; a static gate cannot prove production graph invariants when report cards are absent.

Capture the full production JSON and a readable report, then reconcile that JSON with its authored graph:

```bash
npm run audit:coverage -- --domain=dependency-coverage --prod --json --report .tmp/dependency-coverage/audit.json
npm run audit:coverage -- --domain=dependency-coverage --prod --report .tmp/dependency-coverage/audit.md
npm run audit:dependency-reconcile -- --audit .tmp/dependency-coverage/audit.json --report .tmp/dependency-coverage/reconciliation.md
```

The reconcile entrypoint is `scripts/maintenance/reconcile-dependency-graph.ts`. It requires a non-static dependency-coverage JSON report with `reportCardGraph` present. `--format=json` selects machine-readable reconciliation output; `--help` describes its strict CLI. The two audit commands fetch independently, so retain their timestamps and use the JSON capture as the reconciliation's exact input. Do not assume the Markdown capture has the same publication generation.

The reconciliation lists static-only edges, published-only edges and weight differences. Differences are advisory and exit successfully; malformed input or CLI usage fails the command. A difference alone does not prove a missing dependency: compare authored reserve/variant/manual claims, admitted live reserve mappings and the accepted graph before deciding.

## Weekly Failure Versus Advisory Findings

`.github/workflows/weekly-validation.yml` runs the production audit. Structural failures fail that weekly job and raise an alert, feeding the review queue. **The weekly production audit never blocks releases.** Do not add it as a required release check or weaken a structural rule to make the weekly job green.

The production failure lane covers report-card self-edges, duplicate edges and strongly connected components; target-disposition issues; review gaps for dependency-producing adapter mappings; and authored linked-slice dependency-kind mismatches. Existing authored review/provenance and structural rules remain governed by `scripts/ci/check-dependency-review-gaps.ts` and the audit generator.

The job compares the captured publication's methodology version with the checkout. A mismatch produces the named `checkout-production-skew` status and a workflow warning. During skew, published self-edges, duplicate edges and strongly connected components still fail, as do duplicate registry entries or invalid review provenance. Checkout-sensitive target lifecycle/reference/scoreability issues, missing or stale adapter reviews and authored dependency-kind mismatches remain visible but do not fail the weekly job until the publication matches the checkout. Static checks are unchanged. Matching methodology versions do not prove identical registry contents; reconciliation remains advisory.

In wave 1, `coinIdWithoutDepTypeCount` is an advisory audit counter; its zero-tolerance gate is planned for wave 3. The full audit and static-versus-published reconciliation are advisory artifacts, including material unlinked slices, symbol leads and additive split-position groups. An additive split is not automatically a duplicate. Artifact uploads live under `.tmp/dependency-coverage/`: `audit.json`, `audit.md`, and `reconciliation.md`.

When the weekly job fails:

1. Read the failed counters and full artifact rows; keep the production capture and its timestamps.
2. Separate a malformed/unavailable capture from actual structural findings. An unavailable capture does not establish zero gaps.
3. Add unresolved claim groups to the durable ledger and triage structural findings immediately.
4. Repair the producer, review registry or authored claim using primary evidence. Do not edit audit output, bypass target-card admission, or restore stale reserve weights to manufacture coverage.
5. After normal publication, repeat the production report and reconciliation. Observe the first relevant weekly run; deployment success alone does not prove graph health.

## Monthly Drain and Reviewed Ledger

Use the `dependency-coverage-drain` skill monthly and after coverage drops or weekly alerts. Use `skill://reserve-research` for source identity, backing, custody and provenance evidence. Drain adapter gaps, target dispositions, material unlinked slices, symbol leads, duplicate/split groups and unverifiable published edges in dependent market-cap order. Unknown market cap remains unavailable, never zero; report those items separately.

The durable ledger is [`artifacts/dependency-coverage-reviewed-ledger.json`](./artifacts/dependency-coverage-reviewed-ledger.json). It mirrors the reviewed-history envelope used by `.github/workflows/artifacts/safety-score-missing-data-reviewed-ledger.json`: `schemaVersion`, decision-field inventory, allowed decisions and a `decisions` array. Dependency entries add status and explicit dependent/upstream identity. Audit regeneration must not overwrite or prune it.

The initial 16 entries are `open`, with `firstSeenAt: 2026-09-29` and null `reviewedAt`, reviewer and decision. They identify WS1.E's unresolved published claims, including NC-163 as the third DUSD-alto edge alongside NC-164/165. The seed is an investigation index, not independently verified evidence, and does not author any edge or weight.

For every actual review, append a dated decision with:

- Stable `claimGroupId`, `taskIds` (including NC IDs where available), dependent/upstream IDs, queue `workType` and `resolutionMode`.
- `status`: `resolved`, `deferred`, or `rejected`; keep unreviewed items `open`.
- `decision`: `evidence-refreshed`, `retargeted`, `withheld`, `deferred`, or `rejected`.
- `reviewedAt` and reviewer, primary evidence URLs with access dates and measurement blocks/times, rationale, `changeRefs`, remaining `sentinels`, `factsClosed`, and a concrete `nextReviewTrigger`.

Resolve each claim from its latest dated decision; retain earlier entries as history. Reopening a claim adds a decision rather than deleting the prior outcome. Do not bump `reviewedAt` when regenerating an audit or scheduling a reminder. Report queue counts, oldest unresolved first-seen date, oldest reviewed deferral and concrete blockers after each drain.

**Curation rule:** leads never create edges. Require current claim identity plus a measured basket weight with the correct denominator, or reviewed serial/mechanism semantics. Symbol matches, LP debt, protocol-wide backing and settlement currency alone are insufficient. Unverified bridge/intermediary claims stay on the coverage list until escrow is proven; verified look-through retains annotation and provenance. Evidence-refreshed, retargeted and withheld outcomes must land through the normal registry/adapter/admission path, not ledger edits alone.

## Offline Scenario Workflow

This is a separate hypothetical lane, not Worker cron or canonical score publication. [ADR-36](../architecture.md#adr-36) owns placement and storage; [modeled scenarios](../dependency-map.md#offline-modeled-scenarios) owns reader behavior. `.github/workflows/dependency-scenarios-refresh.yml` runs hourly at minute 17, serializes non-canceling writers, and has a 15-minute deadline.

For an authorized production refresh, dispatch the workflow on `main`:

```bash
gh workflow run dependency-scenarios-refresh.yml --ref main
```

The workflow uses existing `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `PHAROS_API_KEY`. To reproduce its stages from the repository root, use an ignored output directory:

For local read-only D1 exports, a valid Wrangler OAuth session can be used with `CLOUDFLARE_API_TOKEN` unset if the token in `.env.local` lacks D1 scope. Never print credentials or substitute an invented token.

```bash
node --import tsx worker/scripts/compute-dependency-scenarios.ts --mode plan --out-dir agents/dependency-scenarios/manual
node --expose-gc --import tsx worker/scripts/compute-dependency-scenarios.ts --mode compute --out-dir agents/dependency-scenarios/manual --input agents/dependency-scenarios/manual/capture.json --publication agents/dependency-scenarios/manual/publication.json
node --import tsx worker/scripts/compute-dependency-scenarios.ts --mode publish --out-dir agents/dependency-scenarios/manual
```

`plan` reads accepted public report cards with the API key and exports D1 `report-cards:v9:accepted-replay-base:v1` plus `report-cards:v9:accepted-replay:v1`. The canonical publisher writes these two rows atomically with the accepted publication and retains only that generation: an unchanged compressed base envelope plus a bounded compressed compute-time enrichment delta. Plan rejects missing base/delta rows, a base-input mismatch, or an accepted-publication mismatch rather than using mutable prepare-time inputs. Immediately after deploying this storage change, wait for a successful canonical publication before running plan. `compute` requires replay publication/base-input/build identity, candidate/fact/result digests, the publication clock, and all captured published score/grade baselines to match; failures log the mismatching component keys and hashes. It runs three shocks per root for up to 15 publication-bound direct-exposure hubs, producing `artifact.json` and metrics including `acceptedPublicationVerified`, roots, scenarios, rows, and failures. Omitting `--publication` is a local replay only, not authorized publication evidence; use a fresh output directory without a retained `publication.json`, and do not run `publish` on it.

If replay-delta serialization exceeds the codec ceilings or fails compression, canonical publication continues and logs `safety_score_v9_replay_capture_retention_failed`; neither retained replay row advances. Plan then rejects their earlier generation. Resolve the named serialization failure before expecting an offline refresh; never bypass the generation gate.

The hosted workflow preserves the validated artifact for 14 days before publishing. `publish` requires the accepted-equivalence `artifact.verified.sha256` stamp binding source identities, methodology version, and exact payload hash, rechecks those identities before remote writes, schema-validates the artifact, writes the content-hashed payload, verifies exact readback, then advances and verifies the latest marker. New plan/compute attempts invalidate old stamps, preventing local replay-only publication. It subsequently retains the newest 24 payloads plus the marker target. Never advance the marker manually or edit artifact bytes to bypass equivalence.

After the workflow completes, read the uncached public endpoint:

```bash
curl --fail-with-body https://api.pharos.watch/api/dependency-scenarios/v1
```

Verify `artifact.sourcePublicationGenerationId`, base-input/build identity, `computedAtSec`, cohort, assumptions, and per-asset failures against the run's saved artifact. The response freshness names both source and currently accepted publication generations, `ageSec`, `budgetSec: 7200`, and a machine-readable reason for every non-current status:

- `current`: generations match and artifact age is within budget.
- `earlier-generation`: accepted generation has changed within budget. Numbers must be labelled with modeled generation and age, never represented as current.
- `stale`: age exceeds budget; modeled numbers are withheld.
- `unavailable`: artifact or accepted identity is missing/unreadable, artifact validation failed, or artifact clock is in the future; modeled numbers are withheld.

An accepted publication can rotate after a successful run; earlier-generation alone is not corruption. In Exposure mode, confirm the selected cohort root has the selector and assumptions, generation/age/budget labels, and Published → modeled view. NR and missing stored rows are not numeric changes. Canonical cards and journals remain independent.

On failure, retain workflow logs and the saved capture/publication/artifact when available. Capture mismatch or baseline disagreement rejects compute: obtain a fresh coherent plan and rerun rather than weakening the gate. Artifact validation or payload readback failure must not advance latest; inspect the failing D1 operation and rerun the normal workflow after repair. Marker readback failure requires inspecting the marker and its payload before claiming publication. Pruning failure only logs a warning after verified publication and retries on the next successful run; do not roll back good data for that warning. Missing commit data or accepted identity yields unavailable; repair the source/read path, never fabricate a generation. Scheduling delay may leave committed data earlier-generation or stale. Record the first actual production run and endpoint freshness separately from deployment success.

## Verification and Handoff

Follow [Testing: Smallest adequate check per area](../testing.md#smallest-adequate-check-per-area) for changed producers and registries. Run `npm run check:dependency-review-gaps` for local structural review, focused producer tests for behavior changes, then the production report and reconciliation against the new accepted publication. Record checks actually exercised, publication/supply clocks, outcomes, deferred prerequisites and remaining alert risk. The skill facade is maintained by `node scripts/maintenance/sync-agent-skills.mjs --write`; `npm run check:agent-skills` checks its frontmatter and mirrors.
