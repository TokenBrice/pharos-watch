# Kinesis Supply First-Run Investigation

- Date: 2026-03-23
- Scope: `worker/src/cron/sync-kinesis-supply.ts`

## Root Cause

The live Kinesis Horizon endpoint at `/coin_in_circulation` returns a top-level object with a `records` array, not a raw record object or a raw array. The parser only accepted those two older shapes, so both `kinesis-kau` and `kinesis-kag` failed validation on their first scheduled run and never reached the D1/cache writes.

Example live shape observed during investigation:

```json
{
  "history_latest_ledger": 42691026,
  "records": [
    {
      "circulation": "2586388.6348000",
      "mint": "131051834.8394000",
      "redemption": "128465446.2046000",
      "date": "2026-03-23T00:00:00Z"
    }
  ]
}
```

## Fix

- Extend `parseKinesisResponse()` to accept the live envelope and parse the last entry from `records`.
- Keep support for the prior raw-object and raw-array formats.
- Add test coverage for the live envelope shape.
