## Goal

Make the Sim-backed treasury stable-exposure sync stay within free-tier request-rate limits by construction rather than relying on average runtime.

## Scope

- add explicit pacing between owner groups in `sync-treasury-stable-exposure`
- keep the existing two-request owner-group shape and 8-minute cron budget
- document the enforced throttle in worker limits docs
- add targeted test coverage for the pacing behavior

## Non-goals

- changing treasury launch scope
- changing the snapshot schema or public API contract
- changing Sim retry semantics beyond existing `fetchWithRetry()` behavior

## Implementation sketch

1. Introduce a dedicated Sim owner-group delay constant in worker constants.
2. Sleep between owner groups with abort support after each completed owner group except the last.
3. Add a focused cron test that proves the sleep happens between owner groups and not after the final group.
4. Update `docs/worker-and-api-limits.md` to reflect the enforced throttle.
