## Yield Intelligence stale warning fix

- Symptom: stablecoin detail Yield Intelligence cards show `Data stale` even when the hourly `sync-yield-data` publisher is still within tolerance.
- Root cause: row-level `data-stale` warning decoration still uses a hard-coded `90 min` threshold from the old half-hourly cadence.
- Fix: derive the threshold from the shared `sync-yield-data` interval so it remains aligned with cron timing changes.
- Validation: add regression tests for the threshold and warning decoration, update yield methodology docs/changelog text, then run targeted tests plus lint/build/worker type-check.
