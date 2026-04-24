## WS-2 / WS-4 low-risk dedupe scope

### Assumption

WS-2 and WS-4 in this repo refer to low-risk maintainability cleanup only. No user-visible behavior, API shape, or cron semantics should change.

### Success criteria

1. Reserve adapters reuse shared helpers for optional redemption-rate probing and repeated redemption metadata fragments.
2. API-key query projections are declared once and reused across list/select/create-returning queries.
3. `fetch-tbill-rate` and `yield-sync/sources-riskfree` share one risk-free benchmark cache loader.
4. Digest-entry and AI-summary contracts live in shared runtime-neutral modules and the owned script/runtime consumers import them.
5. Targeted tests covering the touched seams pass.

### Implementation plan

1. Add shared editorial contracts under `shared/types` and switch owned digest/summary consumers.
2. Extract reusable API-key SQL projection fragments in `worker/src/lib/api-key-core.ts`.
3. Promote the risk-free cache loader in `worker/src/cron/yield-sync/sources-riskfree.ts` and import it from `fetch-tbill-rate.ts`.
4. Add reserve-adapter helpers under `worker/src/cron/reserve-adapters/` for redemption-rate probing and redemption metadata assembly, then migrate the duplicate call sites.
5. Run targeted tests, lint, and type-check commands for the changed slice.
