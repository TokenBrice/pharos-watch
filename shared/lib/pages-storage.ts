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
