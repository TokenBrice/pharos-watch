# Safety Score V9 Data Agent Notes

Applies to curated and generated Safety Score V9 evidence under `shared/data/safety-score-v9/`.

## Read First

Read the applicable owner anchors, not every background document; use [task routing](../../../docs/process/agent-start-here.md#2-route-a-task) when the affected contract is unclear.

| Work | Required context |
| --- | --- |
| Policy, scoring or publication semantics | [V10 model](../../../docs/report-cards.md#v10-model) |
| Evidence/compiler changes requiring comparison | [When to use the equivalence harness](../../../docs/process/safety-score-equivalence-harness.md#when-to-use-it), then the selected procedure |
| Expiry, freshness or missing-data queue work | [Capture current input](../../../docs/process/safety-score-curation-expiry-sweep.md#1-capture-the-current-production-input), then the affected queue step |
| Mechanism overlays or measured claims | [Evidence scope](../../../docs/process/mechanism-overlay-evidence-standard.md#scope), [evidence classes](../../../docs/process/mechanism-overlay-evidence-standard.md#evidence-classes) and [process requirements](../../../docs/process/mechanism-overlay-evidence-standard.md#process-requirements) |

## Invariants

- Treat evidence JSON as reviewed curation; never invent, extrapolate, or date-bump facts to satisfy schema or remove a gap.
- Negative-incident reviews and gap classifications author ordered `sourcesRefs` / `searchedSurfacesRefs` into file-local `sourceObservations` / `searchedSurfaceObservations` tables of `{ id, value }`. Keep table values immutable: add a new record for a changed observation and rebind only intended reviews. IDs use `source:` / `surface:` plus the first 24 hex characters of SHA-256 over canonical JSON; retained repeated occurrences use `:2`, `:3`, etc. Exact observations may be shared, never review scopes, dates, windows, conclusions or gap assertions. URL equality alone is insufficient; inline/reference dual formats and dangling/duplicate refs are rejected.
- Active gap classifications are unique by the full research-normalized scope key (`v9EvidenceCauseScopeKey`), not by review ID or timestamp. A refreshed same-scope review replaces the older active row; appending a newer row does not supersede it and quarantines the asset. Keep immutable observation tables intact when replacing a review. Fragment authors must use `replace` for an existing scope, not append a second classification.
- Global publication-gate failures hold the last accepted ratings; asset-local failures may publish as quarantined pipeline gaps within the partial-publication allowance. `worker/src/lib/safety-score-v9/publication-assessment.ts` owns that distinction.
- Never hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`; artifact `safety-score-v9-evaluation-build` is registry-generated and checked.
- Methodology version changes follow [ADR-3](../../../docs/architecture.md#architectural-decision-records) across every listed target.
- Protocol API journals and reviewed weekly/manual automation are permanent non-publishing evidence tools, not automatic overlay importers. Direct adoption remains blocked. Strict replay requires original-byte readback: canonical raw-byte V2 or the one path/hash-pinned normalized-only V1; summary recognition and unavailable bodies are not verification success.
- Access-lookthrough's four scoped graphs are public diagnostics, not economic loss estimates. The retained nullable supply reporting state and private legacy-backfill-excluded peg scenario cannot change scoring authority; unknown supply is never zero.
- TRON remains excluded pending independent finality/control proof. Close the special admission investigation on 2026-11-24 unless a gate-complete packet passes; retain pending evidence/audit sources, never date-bump, auto-admit or invent a failed gate.

## Entrypoints & generation

- `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` owns policy; `shared/data/safety-score-v9/mechanism-measurements/` holds evidence governed by [shock coverage](../../../docs/process/shock-coverage-refresh.md) and [protocol API](../../../docs/process/protocol-api-mechanism-refresh.md) refresh procedures.
- Incident source changes first regenerate `safety-score-v9-incident-runtime` with `node --import tsx scripts/build-data/generate-safety-score-v9-incident-runtime.ts`, then refresh the evaluation build. Representation-only changes retain exact expanded payloads, generated runtime bytes and evidence digests; prove those before proceeding from incident normalization to gap normalization. This is not a runtime memory/performance claim.
- Regenerate with `npm run generate:safety-score-v9-evaluation-build`; verify artifact id with `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`.

## Tests

- Focused suites live in `shared/lib/__tests__/` and `worker/src/lib/__tests__/`; select their matching safety-score-v9-*.test.ts files.

## Common checks

- Evidence comparison: `npm run safety-score-v9:replay`, `npm run safety-score-v9:diff`, and `npm run safety-score-v9:movers`.
