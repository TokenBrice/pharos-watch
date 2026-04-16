# DOLA Live Reserve Adapter Check

Date: 2026-04-16

## Findings

Production `reserve_sync_attempt_history` showed hourly `dola-inverse-finance` failures from 2026-04-16 00:12:16 UTC through 08:12:11 UTC:

- failure category: `validation`
- error: `Upstream reserve source timestamp is ... in the future`
- latest raw timestamp shape: `1776330494053`

The Inverse FiRM endpoint still returns valid JSON from:

`https://www.inverse.finance/api/f2/fixed-markets`

The payload now emits a JavaScript millisecond timestamp. The live reserve validation layer expects Unix seconds and rejects future timestamps more than 600 seconds ahead, so the adapter was incorrectly passing a millisecond timestamp through as seconds.

## Change Made

Updated `worker/src/cron/reserve-adapters/dola-inverse.ts` to normalize `payload.timestamp` through `parseTimestampLikeToUnixSeconds()` before storing `metadata.timestamp` and `sourceTimestamp`.

The current payload adapts cleanly after the fix:

- 44 total markets
- 20 active markets
- normalized timestamp: `1776330494`
- no unknown exposure
- no adapter warnings

## Verification

```bash
npm test -- worker/src/cron/reserve-adapters/__tests__/dola-inverse.test.ts
npm run typecheck
```

All passed.
