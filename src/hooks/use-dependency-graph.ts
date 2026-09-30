"use client";

import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { useRegisteredApiQuery, type V9QueryControlOverrides } from "./api-hooks";

/** Poll the accepted graph on the V9 publication cadence, without full evaluator internals. */
export function useDependencyGraph(overrides?: V9QueryControlOverrides) {
  return useRegisteredApiQuery<DependencyGraphResponse>(FRONTEND_API_QUERY_DESCRIPTORS.dependencyGraph, {
    ...overrides,
    keepPreviousData: false,
  });
}
