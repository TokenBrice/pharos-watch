/**
 * Static connection budget for the ADR-26 heavy Safety Score V9 Queue
 * continuation surface (`pharos-v9-continuation`). Stored separately from
 * `shared/lib/cron-jobs.ts` so the V9 evaluation-build manifest closure stays
 * unchanged while `check-cron-connection-budget.ts` accounts for both the
 * `:22`/`:52` post-lease Queue send and the heavy `queue()` consumer.
 */
export const V9_CONTINUATION_CONNECTION_BUDGET = {
  surface: "v9-continuation" as const,
  worker: "heavy" as const,
  maxConnections: 0,
  postSettlementSendConnections: 1,
  producerScheduleKeys: ["v9PublicationOffset"] as const,
} as const;
