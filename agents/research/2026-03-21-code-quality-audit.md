# Code Quality Audit — 2026-03-21

## Inventory Summary

- Frontend: `src/app/`, `src/components/`, `src/hooks/`, `src/lib/`
- Shared runtime-neutral logic: `shared/lib/`, `shared/types/`, `shared/data/`
- Worker API and cron runtime: `worker/src/api/`, `worker/src/cron/`, `worker/src/lib/`, `worker/src/handlers/`
- Pages Functions bridge: `functions/`
- Policy / CI guardrails: `scripts/`

Audit focus: code correctness, error handling, readability, type safety, complexity, testing, and security-sensitive implementation details.

## Findings

### High

1. `worker/src/lib/jwt-verify.ts:47-105`, `worker/src/lib/__tests__/jwt-verify.test.ts:260-299`
   - Problem: JWKS is cached in a single module-global slot (`cachedJwks` / `cachedJwksExpiry`) even though `verifyAccessJwt()` accepts `teamDomain` as an input. That means one tenant’s JWKS can be reused for another tenant in the same isolate, which is a correctness bug in the auth path.
   - Why it matters: the cache key does not match the data’s scope. A multi-tenant or future tenant-expansion scenario can return false negatives or opaque auth failures, and the current tests only cover repeated calls for the same domain.
   - Remediation: key the cache by `teamDomain` or store a per-domain JWKS map, and add a regression test that exercises two different domains in the same process.

2. `worker/src/lib/telegram.ts:34-52`, `worker/src/lib/twitter.ts:105-123`, `worker/src/api/feedback.ts:120-130`
   - Problem: success responses from Telegram, Twitter, and GitHub issue creation are not consistently drained or cancelled. In this codebase, other fetch helpers deliberately consume bodies to free Worker connection slots, but these helpers return after `res.ok` without doing the same.
   - Why it matters: on Workers, unread response bodies can hold connections open. These helpers are used in cron-heavy paths, so the bug can surface as intermittent pool exhaustion or delayed downstream fetches.
   - Remediation: standardize a helper that always drains or cancels response bodies on both success and failure, then use it in all notification / submission clients.

### Medium

3. `worker/src/api/stablecoin-detail.ts:24-205`
   - Problem: `handleStablecoinDetail()` mixes cache lookup, circuit-breaker decisions, provider-specific fetch logic, fallback selection, cache writes, and error translation in one long branching function. The commodity, CoinGecko-only, and DefiLlama branches all repeat the same fallback and cache-wrapping patterns.
   - Why it matters: this is hard to reason about and hard to test in isolation. Any future change to fallback policy or freshness handling has to be replicated across three branches, which increases drift risk.
   - Remediation: extract a shared provider-branch template and move provider-specific behavior into small strategy functions or dedicated handlers.

4. `worker/src/api/feedback.ts:210-320`
   - Problem: `handleFeedback()` bundles request parsing, schema validation, honeypot handling, stablecoin resolution, rate limiting, data-correction verification, and GitHub submission into one handler.
   - Why it matters: the function is doing orchestration, policy enforcement, and external I/O all at once. That makes the happy path and failure modes difficult to exercise independently and raises the chance of regressions when one concern changes.
   - Remediation: split the handler into a validation layer, a verification layer, and a GitHub submission service. Keep the top-level route handler thin.

5. `worker/src/cron/daily-digest/collectors.ts:35-163`
   - Problem: the early collectors (`collectActiveDepegs`, `collectBlacklistActivity`, `collectSupplyVelocity`) swallow query failures and convert them into empty / `undefined` outputs without surfacing a degraded reason.
   - Why it matters: a broken query, schema mismatch, or missing table becomes indistinguishable from “there was no interesting signal today.” That weakens the digest’s trustworthiness and makes production debugging much harder.
   - Remediation: return a structured degraded state or append a collector-specific failure reason for every catch path, then propagate that into the digest metadata.

6. `worker/src/api/telegram-webhook-parsing.ts:95-147`
   - Problem: `parsePendingDisambiguation()` catches every parsing failure across five stored JSON fields and returns `null`. A single malformed field discards the entire pending action, including otherwise recoverable state.
   - Why it matters: corrupted or partially migrated rows quietly terminate Telegram flows with no diagnostic surface. This is the kind of bug that will be reported as “the bot randomly forgot my command.”
   - Remediation: parse each stored field independently, log which field failed, and preserve any valid sub-state where possible. Add a malformed-row regression test.

### Low

7. `scripts/check-worker-import-boundary.mjs:82-88`
   - Problem: the boundary checker scans `src/`, `shared/`, and `scripts/`, but it omits `functions/`. That leaves Pages Functions outside the automated import boundary enforcement.
   - Why it matters: a future `functions/` file can import worker runtime code without CI catching it, which defeats one of the repo’s main architectural guardrails.
   - Remediation: include `functions/` in the scan or add a dedicated `functions -> worker/src` boundary rule.

## Notes

- Existing tests cover some of the defensive parsing behavior in this codebase, so the issues above are not “all parse fallbacks are bad.” The problem is where silent fallback erases important failure semantics or where the tests do not cover the actual edge that matters.
- No code changes were made in this audit pass.
