-- rollout-safety: backward-compatible
-- Close one reviewed worker-job ledger row whose DEX generation published in
-- full before platform termination prevented terminal attempt accounting.
-- Every source row is fingerprinted; any production drift makes this a no-op.

UPDATE worker_job_attempts
SET state = 'completed',
    status_class = 'degraded',
    finished_at = 1784230863,
    duration_ms = 1799000,
    item_count = 345,
    error = NULL,
    result_metadata_json = json_set(
      result_metadata_json,
      '$.reconciliation',
      json_object(
        'reason', 'published-terminal-accounting-recovered',
        'childDisposition', 'published_terminal_missing',
        'generationId', 'dex-liquidity-1784229064',
        'expectedRows', 345,
        'publishedRows', 345,
        'reconciledAt', 1784230863,
        'migration', '0213'
      )
    ),
    updated_at = 1784230863
WHERE attempt_id = 'attempt|scheduled-job|halfHourlyOffset|halfHourlyOffset|1784229000|sync-dex-liquidity|1'
  AND idempotency_key = 'scheduled-job|halfHourlyOffset|halfHourlyOffset|1784229000|sync-dex-liquidity|1'
  AND schedule_key = 'halfHourlyOffset'
  AND slot_started_at = 1784229000
  AND job = 'sync-dex-liquidity'
  AND producer_kind = 'scheduled-job'
  AND producer_path = 'halfHourlyOffset'
  AND state = 'running'
  AND status_class IS NULL
  AND attempt_no = 1
  AND owner = 'f8345f40-6505-4184-a1e2-76e666532a1f'
  AND invocation_id = '033eac44-02b1-4186-a3c2-090df3f35eae'
  AND worker_version = '33603497-0264-44dc-9bc1-c651473b9a3e'
  AND lease_until = 1784229994
  AND queued_at = 1784229063
  AND claimed_at = 1784229064
  AND started_at = 1784229064
  AND last_heartbeat_at = 1784229182
  AND finished_at IS NULL
  AND duration_ms IS NULL
  AND item_count = 260
  AND error IS NULL
  AND created_at = 1784229063
  AND updated_at = 1784229182
  AND json_valid(result_metadata_json)
  AND json_extract(result_metadata_json, '$.progress.stage') = 'persistence-complete'
  AND json_extract(result_metadata_json, '$.progress.itemsDone') = 260
  AND json_extract(result_metadata_json, '$.progress.itemsTotal') = 260
  AND json_extract(result_metadata_json, '$.progress.metadata.generationId') = 'dex-liquidity-1784229064'
  AND EXISTS (
    SELECT 1
    FROM cron_slot_executions slot
    WHERE slot.slot_key = 'halfHourlyOffset'
      AND slot.slot_started_at = 1784229000
      AND slot.state = 'finished'
      AND slot.result_status = 'error'
      AND slot.execution_owner = '50f6d2dc-c95a-48a8-af15-3f03e1045192'
      AND slot.execution_generation = 2
      AND slot.started_at = 1784229063
      AND slot.finished_at = 1784230863
      AND slot.updated_at = 1784230863
      AND slot.invocation_id = '033eac44-02b1-4186-a3c2-090df3f35eae'
      AND slot.worker_version = '33603497-0264-44dc-9bc1-c651473b9a3e'
      AND json_valid(slot.metadata)
      AND json_extract(slot.metadata, '$.error') = 'scheduled slot heartbeat stale; marked expired by later invocation'
  )
  AND EXISTS (
    SELECT 1
    FROM dex_liquidity_publication_generations generation
    WHERE generation.generation_id = 'dex-liquidity-1784229064'
      AND generation.started_at = 1784229064
      AND generation.state = 'published'
      AND generation.expected_row_count = 345
      AND generation.written_row_count = 345
      AND generation.current_row_count = 345
      AND generation.published_at = 1784229064
      AND generation.failed_at IS NULL
      AND generation.failure_reason IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cron_runs run
    WHERE run.job = 'sync-dex-liquidity'
      AND run.slot_started_at = 1784229000
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cron_leases lease
    WHERE lease.job = 'sync-dex-liquidity'
      AND lease.lease_owner = 'f8345f40-6505-4184-a1e2-76e666532a1f'
  );
