"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { API_PATHS, buildQueryPath } from "@shared/lib/api-endpoints";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { AdminActionAuditLogResponseSchema, type AdminActionAuditLogResponse } from "@/lib/actions-workbench-model";
import { useAdminPollingQuery } from "./use-admin-polling-query";

const ACTION_HISTORY_LIMIT = 100;

export function useAdminActionLog(): UseQueryResult<AdminActionAuditLogResponse, Error> {
  return useAdminPollingQuery<AdminActionAuditLogResponse>(
    ["admin-action-log"],
    buildQueryPath(API_PATHS.adminActionLog(), { limit: ACTION_HISTORY_LIMIT }),
    CRON_1MIN,
    { schema: AdminActionAuditLogResponseSchema },
  );
}
