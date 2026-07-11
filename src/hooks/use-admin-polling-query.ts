"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { buildAdminApiPath } from "@/lib/admin-access";
import { createApiQueryFn, usePollingQuery, type ApiQueryOptions } from "./use-api-query";

type AdminPollingOptions<T> = Pick<ApiQueryOptions<T>, "enabled" | "retry" | "schema">;

const ADMIN_QUERY_SCOPE = "ops-proxy";

export function useAdminPollingQuery<T>(
  key: readonly unknown[],
  path: string | (() => string),
  cronInterval: number,
  options?: AdminPollingOptions<T>,
): UseQueryResult<T, Error> {
  return usePollingQuery<T>(
    [...key, ADMIN_QUERY_SCOPE],
    (context) =>
      createApiQueryFn<T>(buildAdminApiPath(typeof path === "function" ? path() : path), options?.schema)(context),
    cronInterval,
    {
      enabled: options?.enabled,
      retry: options?.retry ?? 0,
    },
  );
}
