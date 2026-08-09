"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { ADMIN_API_QUERY_DESCRIPTORS } from "@/lib/admin-api-query-descriptors";
import type { AdminActionAuditLogResponse } from "@/lib/actions-workbench-model";
import { useRegisteredAdminQuery } from "./use-admin-polling-query";

export function useAdminActionLog(): UseQueryResult<AdminActionAuditLogResponse, Error> {
  return useRegisteredAdminQuery(ADMIN_API_QUERY_DESCRIPTORS.adminActionLog);
}
