# Safety Score V9 Data Agent Notes

Applies to curated and generated Safety Score V9 evidence under `shared/data/safety-score-v9/`.

## Read First

- [Report cards](../../../docs/report-cards.md)
- [Equivalence harness](../../../docs/process/safety-score-equivalence-harness.md)
- [Curation-expiry sweep](../../../docs/process/safety-score-curation-expiry-sweep.md)
- [Mechanism evidence standard](../../../docs/process/mechanism-overlay-evidence-standard.md)

## Invariants

- Treat evidence JSON as reviewed curation; never invent, extrapolate, or date-bump facts to satisfy schema or remove a gap.
- Publication fails closed: missing, malformed, stale, or incompatible score-bearing input holds the last accepted ratings.
- Never hand-edit `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`; artifact `safety-score-v9-evaluation-build` is registry-generated and checked.
- Methodology version changes follow [ADR-3](../../../docs/architecture.md#architectural-decision-records) across every listed target.

## Entrypoints & generation

- `shared/data/safety-score-v9/methodology-policy-candidate-v1.json` owns policy; `shared/data/safety-score-v9/mechanism-measurements/` holds evidence governed by [shock coverage](../../../docs/process/shock-coverage-refresh.md) and [protocol API](../../../docs/process/protocol-api-mechanism-refresh.md) refresh procedures.
- Regenerate with `npm run generate:safety-score-v9-evaluation-build`; verify artifact id with `npm run check:generated-artifacts -- --only=safety-score-v9-evaluation-build`.

## Tests

- Focused suites live in `shared/lib/__tests__/` and `worker/src/lib/__tests__/`; select their matching safety-score-v9-*.test.ts files.

## Common checks

- Evidence comparison: `npm run safety-score-v9:replay`, `npm run safety-score-v9:diff`, and `npm run safety-score-v9:movers`.
