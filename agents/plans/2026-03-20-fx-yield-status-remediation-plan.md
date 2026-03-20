# FX / Yield Status Remediation Plan

Date: 2026-03-20

## Scope

- Investigate the stale public status state around `sync-fx-rates` and `sync-yield-data`
- Fix the root cause in the worker with minimal surface-area change
- Verify locally, deploy, and observe two successful production runs for each affected job

## Findings So Far

- Public `/api/health` is currently `degraded`
- The active public warning is `fx-rates: using cached fallback FX rates (10+ consecutive runs)`
- `yield-rankings` is currently serving fresh public data, so the urgent production issue is concentrated in the FX cron path
- Frankfurter and the existing secondary `currency-api` mirrors are reachable from this shell, which points to a worker fallback-path gap rather than a permanently dead upstream
- The first deployed secondary-only fallback fix restored the yield lane but did not clear prod FX fallback; the first post-deploy FX run still incremented the cached-fallback streak
- Admin cron metadata confirms the FX job is still writing a full 20-rate dataset with `chainlink: ok` and `gold-api.com: gold-api.com`; the remaining user-visible problem is the `cached-fallback` classification, not missing output

## Fix Strategy

1. Extend `sync-fx-rates` so the existing secondary `fawazahmed0/currency-api` mirror can backstop the full fiat FX set, not just CNH/RUB/UAH/ARS, when Frankfurter is unavailable or invalid.
2. Preserve cadence-aware FX metadata so health/status semantics stay correct.
3. Add a tertiary full-set FX fallback so production can still publish live dated fiat references if both Frankfurter and the current secondary mirrors are unavailable from the worker runtime.
4. Treat cadence-valid carry-forward daily references as a successful live FX refresh instead of a degraded cached fallback when transport fails but the dated sources are still fresh.
5. Add regression coverage for the secondary, tertiary, and carry-forward live fallback paths.
6. Update pricing methodology/docs and the About page to reflect the wider externally visible FX fallback stack and the revised carry-forward semantics.
7. Validate locally, then push/deploy and watch live telemetry until two successful runs are observed.
