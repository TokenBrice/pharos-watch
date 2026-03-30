"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { buildAdminApiPath, buildAdminFetchInit, getAdminQueryScope, type AdminAccess } from "@/lib/admin-access";
import { apiFetch } from "@/lib/api";
import { usePollingQuery } from "./use-api-query";

interface AdminPollingOptions {
  enabled?: boolean;
  retry?: number | boolean;
}

export function useAdminPollingQuery<T>(
  adminAccess: AdminAccess,
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  options?: AdminPollingOptions,
): UseQueryResult<T, Error> {
  return usePollingQuery<T>(
    [...key, getAdminQueryScope()],
    () => apiFetch<T>(
      buildAdminApiPath(path, adminAccess),
      undefined,
      buildAdminFetchInit(),
    ),
    cronInterval,
    {
      enabled: options?.enabled ?? true,
      retry: options?.retry ?? 0,
    },
  );
}
