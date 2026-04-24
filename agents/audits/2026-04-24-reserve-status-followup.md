# 2026-04-24 reserve/status follow-up

## Prompted concerns

1. Reserve adapters reportedly had broad zero-test exposure.
2. Yield / Telegram crons were reportedly invisible to `/api/status`.

## Findings

- The reserve-adapter concern was stale at the unit level. The checkout already has extensive adapter coverage under `worker/src/cron/reserve-adapters/__tests__/`, plus registry coverage.
- The remaining worthwhile gap was one integration seam: the reserve cron tests mostly mock adapter lookup/fetch, so they do not prove `configured coin -> real registry adapter -> real parser -> validation -> D1 write`.
- `/api/status` already monitors all 31 cron jobs defined in `shared/lib/cron-jobs.ts` through `worker/src/lib/status/cron-health.ts`.
- Yield, Telegram, digest, and monthly-yield jobs are visible today as watch-tier cron statuses. They do not degrade availability by themselves unless their downstream freshness/data-quality surfaces also degrade.
- `/api/health` is intentionally narrower than `/api/status`; it is not the right place to infer full cron coverage.

## Action taken

- Added `worker/src/cron/__tests__/reserve-adapter-real-registry-smoke.test.ts`.
- The new smoke runs `syncReserveCoin()` with the real `mento` adapter and a real configured Mento coin (`ceur-celo`), mocks only network + breaker permission, and asserts:
  - the real adapter fetch/parsing path succeeds
  - validation warnings are preserved
  - `reserve_composition` is written with the expected Mento metadata/slices
  - reserve sync attempt history is persisted as an `ok` sync

## Why this scope

- This is the smallest credible hardening for the flagged reserve risk.
- It covers the exact seam that can regress from upstream payload drift without turning live-reserve tests into a flaky full-cron network simulation.
- No `/api/status` implementation change was warranted because the flagged visibility issue is already resolved in the current checkout.

## Verification

- `npx vitest run worker/src/cron/__tests__/reserve-adapter-real-registry-smoke.test.ts worker/src/cron/reserve-adapters/__tests__/mento.test.ts`
- `npx vitest run worker/src/api/__tests__/health.test.ts worker/src/api/__tests__/status.test.ts`
- `npm run check:cron-sync`
- `npm run test:merge-gate`
