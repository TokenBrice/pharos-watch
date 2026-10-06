---
name: dependency-coverage-drain
description: Drain the Pharos Dependency Map coverage-audit queues into evidence-refreshed edges, reviewed target dispositions, or documented deferrals. Use monthly after weekly production dependency audits, after dependency coverage drops, or when reviewing adapter gaps, material unlinked slices, symbol leads, duplicate/split groups, or unverifiable published edges.
---

Read `docs/editorial-style.md` before writing. Its universal rules and the named `technical-evidence` register govern all Pharos-owned prose; this skill adds only factual, sourcing, schema, and format requirements.

# Dependency Coverage Drain

Turn the weekly production audit queues into reviewed dependency changes. Leads never create edges automatically. A link requires current claim identity plus a measured basket weight or reviewed serial/mechanism semantics.

## Required Context

Read routed docs and scoped instructions, `docs/dependency-map.md`, `docs/runbooks/dependency-network.md`, and `docs/runbooks/artifacts/dependency-coverage-reviewed-ledger.json`. Inspect the emitting queues in `scripts/maintenance/generate-dependency-coverage-audit.ts`, admission rules in `shared/lib/dependency-derivation.ts`, and reviews in `shared/data/coverage-dispositions/dependency-target-dispositions.ts`.

Use `skill://reserve-research` for reserve evidence, provenance, custody, backing dependencies, and source freshness. Read the relevant adapter and authored reserves before changing a claim. Verified docs own durable policy; `/agents/` holds scratch evidence only.

Use `npm run research:dwellir-rpc --` for supplemental pinned on-chain evidence reads; see `docs/process/agent-artifacts.md#pinned-on-chain-evidence`.
Cite its provenance record (keyless URL, block, timestamp); never cite `latest` reads as evidence.

## Queue Snapshot

Run the read-only production report:

```bash
npm run audit:coverage -- --domain=dependency-coverage --prod
```

Capture the report and static-versus-published reconciliation using the runbook. Record access date, publication generation and timestamp, supply timestamp, report counts, and whether inputs are production, local, or fixture-derived. A held publication can predate current supply and local registry changes. Do not call a static-versus-published difference a missing edge without comparing authored relationships, admitted live reserve mappings, and the accepted publication.

If production is unavailable, label the local or fixture snapshot and leave production-only conclusions open. Do not manually mutate production D1 or bypass admission guards.

## Monthly Decision Workflow

### 1. Order and triage

Process unresolved items in dependent market-cap order, largest first. Unknown market caps remain unknown and are listed separately, never as zero. Use ledger age and next-review triggers within the same priority; immediately triage a failed weekly invariant rather than waiting for the monthly drain.

Handle each queue from its emitting source:

- Adapter gaps: verify which mappings actually produce dependencies and add or refresh their dated `adapterReview(...)` registry entries in the same change as mapping fixes.
- Target dispositions: resolve invalid, expired, or newly scoreable targets with current publication evidence. Recheck an intentional gap when its trigger fires.
- Material unlinked slices: establish exact claim identity and the correct denominator, then measure the backing share. Protocol-wide assets, LP debt, or borrow-market collateral are not interchangeable with dependent backing.
- Symbol leads: verify chain, contract, issuer and claim form. A symbol match, even unique, is only a research lead.
- Duplicate/split groups: distinguish duplicate claims from additive measured positions in the same upstream. Preserve valid split positions; never deduplicate by label alone.
- Unverifiable published edges: refresh primary evidence, retarget to the verified claim, or withhold the relationship to the coverage list. Do not treat the seed ledger's captured publication as a new verification.

### 2. Verify and decide

For each claim use dated primary issuer, contract, API, or on-chain evidence through `skill://reserve-research`. Bind observations to an access date and, for on-chain measurements, a stated block. Record the numerator, denominator, measurement time and source scope for weights. Do not fabricate weights or promote a settlement currency into a full backing claim.

Look through a bridge or intermediary only when its escrow/claim relationship is verified, preserving the required annotation and provenance. Otherwise withhold the canonical issuer link and record the unresolved representation on the coverage list without a guessed tracked target.

Resolve an item as `evidence-refreshed`, `retargeted`, or `withheld`; use `deferred` when a named prerequisite remains unavailable and `rejected` for a disproven lead. Withholding changes published data through the normal review/admission path, not by editing the audit output. Role dependencies remain distinct from serial/basket graph edges.

### 3. Preserve reviewed history

Append a dated decision in `docs/runbooks/artifacts/dependency-coverage-reviewed-ledger.json` for each reviewed claim group. Use stable `claimGroupId`, `taskIds` (NC IDs when available), dependent/upstream IDs, queue/work type, resolution mode, status, decision, reviewer, `reviewedAt`, evidence with access dates, rationale, change references, sentinels, facts closed and next review trigger. `reviewedAt` dates an actual review, never a reminder or audit regeneration. Seed entries remain `open` with null review fields until reviewed.

Preserve prior decisions when a row reopens; append a new decision rather than deleting history. Record a concrete next-review date or event for deferrals. Report the oldest unresolved first-seen date and oldest reviewed deferral; do not refresh dates to hide queue age.

## Documentation and Validation

Update routed docs for changes to mapping semantics, queues or admission rules. Methodology-affecting changes follow ADR-3 in `docs/architecture.md` and the owning version/changelog contract; display-only or evidence-only changes do not receive an invented scoring revision.

Run focused tests for the changed producer/admission surfaces, `npm run check:stablecoin-data`, and `npm run check:dependency-review-gaps`. Repeat the production report and reconciliation after publication. The weekly production gate fails and alerts on structural issues but never blocks releases. Use `pharos-release-runner` only when publication is requested.

## Output and Hard Stops

If all queues are empty, report source/date and zero counts, then stop. Otherwise report reviewed outcomes, changes by file, dated evidence, checks actually exercised, deferred prerequisites and triggers, remaining queue counts and age, and weekly failure risk.

- Never create an edge from a lead alone, invent a weight, or bypass a missing target card.
- Never replace a failed live mapping with stale curated weights to recover coverage.
- Never change supply sources or weaken global scoring/admission gates to close the queue.
- Never claim a verification from an old snapshot or bump `reviewedAt` without a new review.
