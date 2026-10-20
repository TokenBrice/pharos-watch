"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { AdminApiQueryDescriptor } from "@/lib/admin-api-query-descriptors";
import { buildAdminApiPath } from "@/lib/admin-access";
import { createApiQueryFn, usePollingQuery } from "./use-api-query";

const ADMIN_QUERY_SCOPE = "ops-proxy";

/**
 * Admin twin of `useRegisteredApiQuery`: binds one `ADMIN_API_QUERY_DESCRIPTORS`
 * entry, letting a caller override only the enablement gate.
 */
export function useRegisteredAdminQuery<T>(
  descriptor: AdminApiQueryDescriptor<T>,
  overrides?: { enabled?: boolean; retry?: number | boolean },
): UseQueryResult<T, Error> {
  return usePollingQuery<T>(
    [...descriptor.queryKey, ADMIN_QUERY_SCOPE],
    (context) =>
      createApiQueryFn<T>(
        buildAdminApiPath(typeof descriptor.path === "function" ? descriptor.path() : descriptor.path),
        descriptor.schema,
      )(context),
    descriptor.producerIntervalMs,
    {
      enabled: overrides?.enabled ?? descriptor.enabled,
      retry: overrides?.retry ?? 0,
    },
  );
}
