"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { buildAdminApiPath } from "@/lib/admin-access";
import { apiFetch } from "@/lib/api";
import { usePollingQuery, type ApiQueryOptions } from "./use-api-query";

type AdminPollingOptions<T> = Pick<ApiQueryOptions<T>, "enabled" | "retry" | "schema">;

const ADMIN_QUERY_SCOPE = "ops-proxy";

export function useAdminPollingQuery<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  options?: AdminPollingOptions<T>,
): UseQueryResult<T, Error> {
  return usePollingQuery<T>(
    [...key, ADMIN_QUERY_SCOPE],
    () => apiFetch<T>(buildAdminApiPath(path), options?.schema),
    cronInterval,
    {
      enabled: options?.enabled ?? true,
      retry: options?.retry ?? 0,
    },
  );
}
