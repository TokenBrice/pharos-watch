"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { buildAdminApiPath } from "@/lib/admin-access";
import { apiFetch } from "@/lib/api";
import { usePollingQuery } from "./use-api-query";
import type { SchemaLike } from "@/lib/schema-like";

interface AdminPollingOptions<T> {
  enabled?: boolean;
  retry?: number | boolean;
  schema?: SchemaLike<T>;
}

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
