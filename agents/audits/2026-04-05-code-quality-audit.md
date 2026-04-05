# Code Quality Audit - Stablecoin Dashboard

Scope: full repository, code quality only. I verified findings against the current tree after running `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, and `cd worker && npx tsc --noEmit`.

## 1. Executive Summary

Confirmed findings: 3 total

- Critical: 0
- High: 1
- Medium: 2
- Low: 0

Top issues:

1. `runIdempotentAdminAction` can leave an idempotency reservation stuck in `PENDING` if the execute path throws and the cleanup delete also fails.
2. The core Worker ingress path has only indirect coverage; there are no direct branch tests for `handleHttpRequestImpl` or `createRequestSourceRecorder`, and the failure/recovery path in `recordWorkerRequestAttribution` is also untested.
3. `getTelegramBotStats` is a large multi-responsibility aggregation helper that mixes SQL, coercion, and output shaping in one function.

Overall code quality score: 7/10. The codebase is generally disciplined and well-tested at the API level, but the request/idempotency path has a real failure-mode risk and the ingress path still depends too heavily on indirect tests.

Estimated affected surface: approximately 2-3% of the runtime surface is directly implicated by the confirmed findings, with a broader indirect impact on request handling and status reporting.

## Verification

The findings below were checked against the current sources, not stale assumptions. Relevant coverage already exists for some happy paths, but it does not cover the failure branches called out here.

## 2. Findings

### High

**1. Idempotency cleanup can strand a reservation in `PENDING` after a thrown action**

- Location: [worker/src/lib/idempotency.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/idempotency.ts), `runIdempotentAdminAction`, lines 50-141.
- What is wrong: If `execute()` throws, the code tries to delete the pending reservation row, but a second failure in that cleanup path is only logged. The warning explicitly says the key "may be stuck in PENDING", which means the row can survive in a non-terminal state until TTL cleanup happens.
- Why it matters: That can block retries with the same idempotency key for the rest of the retention window, which is a real availability and operator-friction problem for admin actions that are expected to be retry-safe.
- Remediation: Do not rely on best-effort cleanup alone. Record an explicit terminal failure state, or otherwise guarantee that a failed execution cannot leave a reservation pending indefinitely. Add tests for `execute()` rejection and cleanup-delete failure so the behavior is pinned.

### Medium

**2. Core request ingress lacks direct tests for the important branch paths**

- Location: [worker/src/handlers/http/request-dispatch.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-dispatch.ts), `handleHttpRequestImpl`, lines 10-79; [worker/src/handlers/http/request-source.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-source.ts), `createRequestSourceRecorder`, lines 5-43; [worker/src/lib/request-source-attribution.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/request-source-attribution.ts), `recordWorkerRequestAttribution`, lines 28-76.
- What is wrong: The Worker ingress path is doing a lot of critical work in one flow: preflight handling, maintenance mode, access gating, edge-cache hits, 404 routing, telemetry recording, and cache writes. Current tests exercise some of that indirectly through [worker/src/__tests__/index.fetch.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/__tests__/index.fetch.test.ts), but the specific branch logic in the dispatcher and attribution recorder is not directly pinned.
- Why it matters: This is the highest-blast-radius request path in the Worker. A regression here can silently change auth, cache behavior, or telemetry without a test failure that points to the exact branch that broke.
- Remediation: Add focused tests for preflight, maintenance responses, access-gate rejection, cache hit, route-not-found, normal dispatch, and the request-source recorder branches for admin, site-api, and public-api traffic. Add explicit failure-path coverage for the attribution prune helper as well.

**3. Telegram bot status aggregation is a monolithic helper with too many responsibilities**

- Location: [worker/src/lib/status/derived-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/status/derived-data.ts), `getTelegramBotStats`, lines 93-219.
- What is wrong: This function owns the SQL, the coercion of loosely typed DB values, the derivation of multiple alert and subscription metrics, and the output shaping for the status API. The logic is correct enough to pass current integration tests, but it is concentrated in one large block with many nested CASE expressions and hand-rolled conversions.
- Why it matters: Changes to Telegram metrics are likely to be fragile because the query and the output mapping are tightly coupled. That increases the chance of accidental metric drift and makes branch-level testing difficult.
- Remediation: Split the query into smaller helpers by metric group, keep the SQL in named constants, and map each result set in a separate pure function. Add focused unit tests for the metric groups rather than relying only on the full status endpoint.

## 3. Cross-Cutting Concerns

- The request-idempotency and request-ingress paths share a pattern of "indirect coverage only". That is tolerable for routine code, but not for the Worker front door and admin retry logic.
- The status aggregation smell and the idempotency cleanup issue both reflect the same maintainability risk: business logic is bundled with recovery logic, so failures are easy to log and hard to test.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

- Add direct tests for `handleHttpRequestImpl` branch paths and `createRequestSourceRecorder`. Files: [worker/src/handlers/http/request-dispatch.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-dispatch.ts), [worker/src/handlers/http/request-source.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-source.ts), [worker/src/lib/request-source-attribution.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/request-source-attribution.ts). Effort: small. Depends on: none.

### Phase 2 - Targeted Refactoring

- Make idempotency failure handling deterministic instead of warning-only. Files: [worker/src/lib/idempotency.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/idempotency.ts). Effort: medium. Depends on: the failure-path tests from Phase 1.
- Split Telegram bot stat aggregation into smaller helpers and pure mapping functions. Files: [worker/src/lib/status/derived-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/status/derived-data.ts). Effort: medium. Depends on: focused metric tests.

## 5. Appendices

### Finding Index

- [worker/src/lib/idempotency.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/idempotency.ts): finding 1.
- [worker/src/handlers/http/request-dispatch.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-dispatch.ts): finding 2.
- [worker/src/handlers/http/request-source.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-source.ts): finding 2.
- [worker/src/lib/request-source-attribution.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/request-source-attribution.ts): finding 2.
- [worker/src/lib/status/derived-data.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/status/derived-data.ts): finding 3.

### Test Surface Notes

- [worker/src/lib/__tests__/idempotency.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/idempotency.test.ts) covers the happy path and in-flight replay behavior, but not execute failure or cleanup failure.
- [worker/src/lib/__tests__/request-source-attribution.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/request-source-attribution.test.ts) covers mapping helpers only, not the DB write/prune recorder path.
- [worker/src/api/__tests__/status.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/status.test.ts) already exercises the status endpoint shape, so the Telegram aggregation issue is about maintainability, not missing endpoint coverage.

### Glossary

- `PENDING` reservation: the temporary idempotency row inserted before a handler executes.
- Branch-level test coverage: tests that hit specific control-flow paths, not just a broader integration response.
- Monolithic helper: a function that mixes data access, business rules, and output shaping in one place.
