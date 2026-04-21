# 2026-04-21 Archivist Documentation Verification — Loop 3

## Scope

Loop 3 started after loop 2 was pushed at `bc5fd132`. Two read-only `gpt-5.4` / `xhigh` agents checked residual API, route, operations, and feature-doc claims against the current source tree.

## Issues Corrected

- Yield docs now include the `protocol-api` source key / data source family.
- Telegram callback docs now match visible unknown-action callback toasts.
- Scripts docs now use the actual `screenshot-og.mjs` 1200x628 capture size.
- Live-reserve registry docs now name the definition source and include the `redemptionTelemetry` property.
- Stale-data banner coverage now includes redemption backstops on stablecoin detail and the Coverage page.
- Worker infrastructure docs now describe the digest-trigger poll as directly running `generateDailyDigest(...)` under the existing lease and correct the connection-budget full rows.
- API reference now describes `fxFallbackRates` as coming from the full FX/reference state rather than only the ECB/Frankfurter path.

## Verification Commands

Passed:

- `npm run check:doc-source-paths`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run check:doc-counts`

## Loop Result

Loop 3 found more than 3 code-verifiable errors, so this correction pass requires commit/push and one more verification loop.
