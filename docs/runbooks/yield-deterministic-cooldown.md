# Runbook: Yield Deterministic All-Fail Cooldown

Triggered by:
- `sync-yield-data` metadata showing `onChainAllDeterministicFailed`, `onChainCooldownTriggered`, or `onChainSkippedDueToCooldown`
- `fallbackMode` containing `onchain-rates:all-deterministic-failed` or `onchain-rates:cooldown-coverage-gap`
- `cache['yield:onchain-health:v1']` showing an active `cooldownUntil`

## Symptom

Deterministic on-chain yield reads fail in a run. If all configured deterministic sources have non-onchain alternative coverage, the failure is masked and a 6-hour cooldown can arm after repeated masked all-fail runs. During cooldown, the post-V9 publisher skips deterministic on-chain reads.

## Impact

Rows backed by non-onchain sources continue to publish. Native deterministic rows may be absent or replaced by lower-confidence alternatives until the cooldown expires. If a coverage gap appears while cooldown is active, `sync-yield-data` degrades and retries deterministic reads on the next post-V9 cycle.

## First Checks

1. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `sync-yield-data` metadata.
2. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
3. **Public rankings:** inspect affected rows in `GET https://api.pharos.watch/api/yield-rankings` for source changes and warning signals.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, value
FROM cache
WHERE key = 'yield:onchain-health:v1';
```

```sql
SELECT job, started_at, status, item_count, metadata
FROM cron_runs
WHERE job = 'sync-yield-data'
ORDER BY started_at DESC
LIMIT 8;
```

```sql
SELECT stablecoin_id, source_key, data_source, yield_source, current_apy, updated_at
FROM yield_data
WHERE data_source IN ('onchain', 'rate-derived')
ORDER BY updated_at DESC
LIMIT 30;
```

## Common Causes

- RPC provider outage or chain-specific empty `eth_call` responses.
- Explorer fallback also returned empty for supported EVM chains.
- Sticky provider failure masked by public fallback ordering, later recovered.
- Deterministic sources all failed but every configured coin had non-onchain coverage, causing cooldown instead of public outage.

## Remediation

- If cooldown is active and no coverage gap is reported, leave it in place. It exists to protect the post-V9 publisher from repeatedly burning time on a fully masked outage.
- If metadata reports `onchain-rates:cooldown-coverage-gap`, wait for the next post-V9 run after the cooldown state is reset by the publisher, then confirm deterministic reads are attempted again.
- If failures persist across providers, check Cloudflare/RPC/explorer provider status and `ETHERSCAN_API_KEY` availability through the normal secret/config process.
- If a stale cron lease is preventing retries, clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `sync-yield-data`, and verify the next post-V9 run.

## Abort Conditions

- Do not delete or edit `cache['yield:onchain-health:v1']` to force reads while an upstream outage is active.
- Do not add manual APY or supply overrides to compensate for missing deterministic rows.
- Do not promote a source-risk or scoring change as part of cooldown remediation.

## Validation

- `cache['yield:onchain-health:v1']` shows either no active cooldown, a decreasing valid cooldown, or a reset after successful deterministic reads.
- `sync-yield-data` metadata shows `onChainRatesResolved > 0` after recovery or `onChainFailureMaskedByAlternativeCoverage: true` while protected.
- Public rankings remain non-empty and affected rows clearly expose their current source/provenance.

## Rollback Notes

The cooldown state is designed to self-expire and self-reset on successful deterministic reads. If a deployment introduced persistent all-fail behavior, roll back the Worker version; do not override cached APY rows by hand.
