## WS-7 / PR-11 Catalog Foundation

### Success Criteria

- Keep the public stablecoin registry exports unchanged for runtime consumers.
- Add mixed-source foundation support for legacy shard arrays plus per-coin source files.
- Fail validation on duplicate IDs across source systems and on canonical-order coverage drift.
- Keep the slice scoped to foundation only: no broad shard migration in this change.

### Plan

1. Add the mixed-source scaffolding under `shared/data/stablecoins/` plus a generator/helper for per-coin sources.
2. Update `shared/lib/stablecoins/registry.ts` and `scripts/check-stablecoin-data.ts` to consume the mixed-source model and enforce duplicate/canonical-order failures.
3. Update stablecoin-focused tests and the source-model docs, then run targeted validation.
