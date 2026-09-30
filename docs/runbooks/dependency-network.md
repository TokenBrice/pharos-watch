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

## Verification and Handoff

Follow [Testing: Smallest adequate check per area](../testing.md#smallest-adequate-check-per-area) for changed producers and registries. Run `npm run check:dependency-review-gaps` for local structural review, focused producer tests for behavior changes, then the production report and reconciliation against the new accepted publication. Record checks actually exercised, publication/supply clocks, outcomes, deferred prerequisites and remaining alert risk. The skill facade is maintained by `node scripts/maintenance/sync-agent-skills.mjs --write`; `npm run check:agent-skills` checks its frontmatter and mirrors.
