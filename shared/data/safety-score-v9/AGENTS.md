# Safety Score V9 Data Agent Notes

Applies to curated and generated Safety Score V9 evidence under `shared/data/safety-score-v9/`.

## Read First

- [Report cards](../../../docs/report-cards.md)
- [Equivalence harness](../../../docs/process/safety-score-equivalence-harness.md)
- [Curation-expiry sweep](../../../docs/process/safety-score-curation-expiry-sweep.md)
- [Mechanism evidence standard](../../../docs/process/mechanism-overlay-evidence-standard.md)

## Invariants

- Treat evidence JSON as reviewed curation; never invent, extrapolate, or date-bump facts to satisfy schema or remove a gap.
- Global publication-gate failures hold the last accepted ratings; asset-local failures may publish as quarantined pipeline gaps within the partial-publication allowance. `worker/src/lib/safety-score-v9/publication-assessment.ts` owns that distinction.
- Never hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`; artifact `safety-score-v9-evaluation-build` is registry-generated and checked.
- Methodology version changes follow [ADR-3](../../../docs/architecture.md#architectural-decision-records) across every listed target.
- Protocol API journals and reviewed weekly/manual automation are permanent non-publishing evidence tools, not automatic overlay importers. Direct adoption remains blocked. Strict replay requires original-byte readback: canonical raw-byte V2 or the one path/hash-pinned normalized-only V1; summary recognition and unavailable bodies are not verification success.
- Access-lookthrough's four scoped graphs are public diagnostics, not economic loss estimates. The retained nullable supply reporting state and private legacy-backfill-excluded peg scenario cannot change scoring authority; unknown supply is never zero.
- TRON remains excluded pending independent finality/control proof. Close the special admission investigation on 2026-11-24 unless a gate-complete packet passes; retain pending evidence/audit sources, never date-bump, auto-admit or invent a failed gate.

## Entrypoints & generation

- `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` owns policy; `shared/data/safety-score-v9/mechanism-measurements/` holds evidence governed by [shock coverage](../../../docs/process/shock-coverage-refresh.md) and [protocol API](../../../docs/process/protocol-api-mechanism-refresh.md) refresh procedures.
- Regenerate with `npm run generate:safety-score-v9-evaluation-build`; verify artifact id with `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`.

## Tests

- Focused suites live in `shared/lib/__tests__/` and `worker/src/lib/__tests__/`; select their matching safety-score-v9-*.test.ts files.

## Common checks

- Evidence comparison: `npm run safety-score-v9:replay`, `npm run safety-score-v9:diff`, and `npm run safety-score-v9:movers`.
