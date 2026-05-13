# Runbook: D1 Telemetry Kill Switch

## Symptom

D1 latency or queue pressure threatens product reads, Telegram dispatch, or cron writes, and low-value request attribution telemetry should degrade first.

Detection signals:

- `/api/status` shows D1 subsection errors, stale cron telemetry, or D1 usage warnings.
- Cloudflare logs include D1 overload messages such as `D1 DB is overloaded` or `Requests queued for too long`.
- Public API cache-hit traffic is still generating route/source attribution writes.
- Telegram pending drain or dispatch metadata writes are delayed while request-source telemetry volume is high.

## Kill-Switch Order

1. **Disable route/source attribution if the deployed build supports it.** Set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on the Worker and Pages environments. This should stop low-value route/source telemetry while leaving API-key auth, D1-backed rate limiting, and per-key public API load controls intact.
2. **Disable Pages site-data attribution by removing the Pages `DB` binding** if the narrower flag is not available in the deployed build. The same-origin `/_site-data/*` proxy still serves allowed reads without the optional binding, but Pages delivery-path telemetry is skipped.
3. **Do not use `MAINTENANCE_MODE=true` for telemetry pressure alone.** That is a global product kill switch and returns 503 for non-OPTIONS traffic.

## Commands

Worker secret:

```bash
printf "true" | npx wrangler secret put REQUEST_SOURCE_ATTRIBUTION_DISABLED
```

Pages uses the Cloudflare Pages project environment variables. Set the same variable for production and preview if both are generating telemetry pressure.

## Verification

1. Check `/api/request-source-stats` after one or two aggregation windows. Route/source counters should stop increasing for disabled environments.
2. Confirm protected API requests still enforce `X-API-Key` and per-key limits.
3. Confirm Telegram dispatch still writes `cron_runs` metadata and pending queue rows.
4. Remove the flag after D1 pressure clears, then verify counters resume.

## Cross-References

- [`docs/worker-infrastructure.md`](../worker-infrastructure.md) section Request Attribution.
- [`docs/worker-and-api-limits.md`](../worker-and-api-limits.md) for D1 overload retry posture.
- [`telegram-backlog-expiration.md`](./telegram-backlog-expiration.md) when D1 pressure is causing Telegram pending rows to age out.
