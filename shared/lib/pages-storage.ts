const SITE_DATA_SAMPLES_TABLE = "site_data_request_samples";
const siteDataSampleColumns = {
  bucketStart: "bucket_start",
  routeKey: "route_key",
  routePath: "route_path",
  deliveryPath: "delivery_path",
  upstreamLane: "upstream_lane",
  sampleInverseRate: "sample_inverse_rate",
  sampleCount: "sample_count",
} as const;

export const SITE_DATA_REQUEST_SAMPLES = {
  table: SITE_DATA_SAMPLES_TABLE,
  timestampColumn: siteDataSampleColumns.bucketStart,
  // SAFETY: Table and column identifiers are the static declarations above.
  insertSql: `INSERT INTO ${SITE_DATA_SAMPLES_TABLE} (
           ${Object.values(siteDataSampleColumns).join(",\n           ")}
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(${siteDataSampleColumns.bucketStart}, ${siteDataSampleColumns.routeKey}, ${siteDataSampleColumns.deliveryPath}, ${siteDataSampleColumns.upstreamLane}, ${siteDataSampleColumns.sampleInverseRate})
         DO UPDATE SET
           ${siteDataSampleColumns.sampleCount} = ${siteDataSampleColumns.sampleCount} + excluded.${siteDataSampleColumns.sampleCount},
           ${siteDataSampleColumns.routePath} = excluded.${siteDataSampleColumns.routePath}`,
  // SAFETY: This is a fixed projection of the same static table and columns.
  sourceEventsSql: `SELECT ${siteDataSampleColumns.bucketStart}, ${siteDataSampleColumns.routeKey}, ${siteDataSampleColumns.routePath}, 'pages', 'site', ${siteDataSampleColumns.deliveryPath}, '', ${siteDataSampleColumns.sampleInverseRate}, 0, ${siteDataSampleColumns.sampleCount}
  FROM ${SITE_DATA_SAMPLES_TABLE} WHERE ${siteDataSampleColumns.bucketStart} >= ?1 AND ${siteDataSampleColumns.bucketStart} < ?2`,
} as const;

const SELECTOR_QUOTA_TABLE = "selector_snapshot_daily_quota";
const selectorQuotaColumns = {
  quotaDate: "quota_date",
  ipHash: "ip_hash",
  count: "count",
  firstSeenAt: "first_seen_at",
  lastSeenAt: "last_seen_at",
} as const;

export const SELECTOR_SNAPSHOT_DAILY_QUOTA = {
  table: SELECTOR_QUOTA_TABLE,
  timestampColumn: selectorQuotaColumns.quotaDate,
  // SAFETY: Table and column identifiers are the static declarations above.
  consumeSql: `INSERT INTO ${SELECTOR_QUOTA_TABLE} (
         ${Object.values(selectorQuotaColumns).join(",\n         ")}
       )
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(${selectorQuotaColumns.quotaDate}, ${selectorQuotaColumns.ipHash}) DO UPDATE SET
         ${selectorQuotaColumns.count} = ${selectorQuotaColumns.count} + 1,
         ${selectorQuotaColumns.lastSeenAt} = excluded.${selectorQuotaColumns.lastSeenAt}
       WHERE ${SELECTOR_QUOTA_TABLE}.${selectorQuotaColumns.count} < ?`,
  // SAFETY: This statement uses only the static table and columns above.
  refundSql: `UPDATE ${SELECTOR_QUOTA_TABLE}
       SET ${selectorQuotaColumns.count} = CASE WHEN ${selectorQuotaColumns.count} > 0 THEN ${selectorQuotaColumns.count} - 1 ELSE 0 END
       WHERE ${selectorQuotaColumns.quotaDate} = ? AND ${selectorQuotaColumns.ipHash} = ?`,
} as const;
