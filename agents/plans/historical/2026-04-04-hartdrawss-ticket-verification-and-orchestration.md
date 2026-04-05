# 2026-04-04 Hartdrawss Ticket Verification And Orchestration Note

Inputs:
- [Hartdrawss remediation implementation plan](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-remediation-implementation-plan.md)
- [Hartdrawss sequenced ticket backlog](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-04-hartdrawss-sequenced-ticket-backlog.md)

Purpose:
- record one verification pass over the ticket backlog before implementation begins
- confirm whether the execution architecture is suitable for subagent-driven work under a single orchestrator
- capture the corrections required to make the backlog dispatch-safe

## Final Position

The remediation train is suitable for subagent-driven execution, but only after tightening the backlog and treating the sequenced backlog as the single execution authority.

The main issues found in verification were:
- ticket-ID drift between the implementation plan and the sequenced backlog
- a too-broad secret-rotation ticket that was not safe for delegation
- API-key UI scope that missed the actual frontend surface
- error-sanitization scope that understated the live leak surface
- validation commands that were too generic or pointed at the wrong test surfaces
- shared-doc collision risk that needed explicit orchestrator ownership

These have now been corrected in the sequenced backlog.

## Key Corrections Applied

1. Execution authority normalized
- The sequenced backlog now explicitly supersedes the older ticket numbering in the implementation plan.
- The implementation plan now points readers back to the sequenced backlog.

2. `SEC-02` widened to the real leak surface
- The ticket now covers all response-body error text on `/api/status`, not only `sectionErrors`.
- `docs/worker-infrastructure.md` is now part of the expected doc surface.

3. `SEC-03` validation tightened
- Shared Access-JWT extraction now includes verifier/JWKS-cache tests, not only auth wrapper tests.

4. `SEC-04` hardened as a true auth-boundary ticket
- `CTRL-00` now captures whether Pages actually receives `Cf-Access-Jwt-Assertion`.
- `SEC-04` now includes env-contract tests, Pages env docs, and live smoke expectations for `/api/admin/*`.
- The mutating-request CSRF/origin rule is now explicit.

5. `SEC-05` and `SEC-06` aligned to the real API-key surfaces
- `SEC-05` now covers fetch-level expired-key enforcement and migration bookkeeping.
- `SEC-06` now points at the actual UI surface:
  - `src/components/status/api-keys-panel.tsx`
  - `src/hooks/use-api-keys.ts`
- The old `src/app/admin/*`-only assumption was incorrect.

6. `SEC-07` split for delegation safety
- `SEC-07A` site-data shared-secret overlap
- `SEC-07B` Telegram webhook secret overlap
- `SEC-07C` ops / CI Access-token rotation runbook
- This split removes a high-risk mixed ticket that was not suitable for independent subagent ownership.

7. `SEC-08` and `SEC-09` validation narrowed to the right targets
- `SEC-08` now expects a focused CORS/request-dispatch test, not only the broad worker fetch suite.
- `SEC-09` now explicitly covers `worker/scripts/**` and expects dedicated regression tests.

8. `SEC-10` made serial and convergence-focused
- It now owns one canonical closure matrix for the remaining non-applicable or already-mitigated findings.
- It should not run in parallel with active code tickets.

## Remaining Hard Preconditions

These are still real blockers and should be treated as program-level gates:

1. `CTRL-00` must confirm whether Pages Functions receives `Cf-Access-Jwt-Assertion`.
2. `CTRL-00` must confirm the intended `CF_ACCESS_TEAM_DOMAIN` policy instead of relying on implicit defaults.
3. `SEC-04` should not start before `SEC-03` lands and `CTRL-00` is complete.
4. `SEC-10` should remain the last serial convergence lane.

## Orchestrator Architecture

The implementation is now suitable for subagent-driven execution with the following model:

### Orchestrator-owned lanes

- `CTRL-00`
- all Cloudflare-account-side actions
- merge ordering
- shared-doc conflict resolution
- manual browser and live-smoke verification
- wave-end validation and merge gate

### Good subagent tickets

- `SEC-01`
- `SEC-03`
- `SEC-05`
- `SEC-06`
- `SEC-07A`
- `SEC-07B`
- `SEC-08`
- `SEC-09`

### Single-owner tickets that should not be split further

- `SEC-02`
- `SEC-04`
- `SEC-10`

Reason:
- each of those tickets is a single trust-boundary or convergence problem with too much internal coupling for profitable sub-splitting

### Safe parallel windows

Wave 1:
- `SEC-01`
- `SEC-02`
- `SEC-03`

Wave 2:
- `SEC-04`
- `SEC-05`

Wave 3:
- `SEC-06`
- `SEC-07A`
- `SEC-07B`

Wave 4:
- `SEC-07C`
- `SEC-08`
- `SEC-09`
- `SEC-10` stays serial after the others in the wave are ready

## Dispatch Guidance

If the implementation train starts immediately, dispatch in this order:

1. finish `CTRL-00`
2. run `SEC-01`, `SEC-02`, `SEC-03`
3. merge `SEC-03`
4. run `SEC-04` and `SEC-05`
5. run `SEC-06`, `SEC-07A`, `SEC-07B`
6. close with `SEC-07C`, `SEC-08`, `SEC-09`, then `SEC-10`

## Verification Outcome

Status:
- backlog verified and materially improved
- subagent-driven execution approved with orchestrator control
- no application code changed in this verification pass

Residual risk:
- medium, but now operational rather than structural
- the remaining risk is mostly in Cloudflare posture confirmation and disciplined merge orchestration, not in the backlog architecture itself
