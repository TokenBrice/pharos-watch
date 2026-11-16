/**
 * D1 tables that Pages functions write and the Worker reads or prunes.
 * Each statement is declared once here so the two deploy units cannot drift.
 */
export const SITE_DATA_REQUEST_SAMPLES = {
  table: "site_data_request_samples",
  timestampColumn: "bucket_start",
  insertSql: `INSERT INTO site_data_request_samples (
           bucket_start,
           route_key,
           route_path,
           delivery_path,
           upstream_lane,
           sample_inverse_rate,
           sample_count
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, route_key, delivery_path, upstream_lane, sample_inverse_rate)
         DO UPDATE SET
           sample_count = sample_count + excluded.sample_count,
           route_path = excluded.route_path`,
  sourceEventsSql: `SELECT bucket_start, route_key, route_path, 'pages', 'site', delivery_path, '', sample_inverse_rate, 0, sample_count
  FROM site_data_request_samples WHERE bucket_start >= ?1 AND bucket_start < ?2`,
} as const;

export const SELECTOR_SNAPSHOT_DAILY_QUOTA = {
  table: "selector_snapshot_daily_quota",
  timestampColumn: "quota_date",
  consumeSql: `INSERT INTO selector_snapshot_daily_quota (
         quota_date,
         ip_hash,
         count,
         first_seen_at,
         last_seen_at
       )
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(quota_date, ip_hash) DO UPDATE SET
         count = count + 1,
         last_seen_at = excluded.last_seen_at
       WHERE selector_snapshot_daily_quota.count < ?`,
  refundSql: `UPDATE selector_snapshot_daily_quota
       SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END
       WHERE quota_date = ? AND ip_hash = ?`,
} as const;

/** Durable creation-attempt limits; accepted attempts are never refunded. */
export const SOCIAL_SCORECARD_DAILY_QUOTA = {
  table: "social_scorecard_daily_quota",
  timestampColumn: "quota_date",
  maxPerIp: 20,
  maxGlobal: 2_000,
  globalKey: "global",
  consumeSql: `INSERT INTO social_scorecard_daily_quota (
         quota_date,
         quota_key,
         count,
         first_seen_at,
         last_seen_at
       )
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(quota_date, quota_key) DO UPDATE SET
         count = count + 1,
         last_seen_at = excluded.last_seen_at
       WHERE social_scorecard_daily_quota.count < ?`,
  // Immediately follows the global reservation in one D1 batch. A full global
  // bucket must not create arbitrarily many empty per-IP rows.
  consumeIpSql: `INSERT INTO social_scorecard_daily_quota (
         quota_date,
         quota_key,
         count,
         first_seen_at,
         last_seen_at
       )
       SELECT ?, ?, 1, ?, ? WHERE changes() = 1
       ON CONFLICT(quota_date, quota_key) DO UPDATE SET
         count = count + 1,
         last_seen_at = excluded.last_seen_at
       WHERE social_scorecard_daily_quota.count < ?`,
  refundSql: `UPDATE social_scorecard_daily_quota
       SET count = count - 1
       WHERE quota_date = ? AND quota_key = ? AND count > 0`,
  // The date-leading primary key bounds this request-path cleanup without a cron.
  pruneSql: `DELETE FROM social_scorecard_daily_quota
       WHERE rowid IN (
         SELECT rowid FROM social_scorecard_daily_quota
         WHERE quota_date < ?
         ORDER BY quota_date, quota_key
         LIMIT 256
       )`,
} as const;
