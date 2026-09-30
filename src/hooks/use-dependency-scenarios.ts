"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DEPENDENCY_SCENARIOS_INTERVAL_MS, DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC, DependencyScenariosResponseSchema, type DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { createApiPollingQueryOptions } from "./use-api-query";

export function useDependencyScenarios(enabled = true) {
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNowSec(Date.now() / 1000), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const query = useQuery(createApiPollingQueryOptions<DependencyScenariosResponse>(
    ["dependency-scenarios", "v1"],
    API_PATHS.dependencyScenarios(),
    DEPENDENCY_SCENARIOS_INTERVAL_MS,
    { schema: DependencyScenariosResponseSchema, enabled },
  ));
  const computedAtSec = query.data?.artifact?.computedAtSec;
  useEffect(() => {
    if (computedAtSec === undefined) return;
    const delay = Math.max(0, (computedAtSec + DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC) * 1000 - Date.now() + 1);
    const timer = window.setTimeout(() => setNowSec(Date.now() / 1000), delay);
    return () => window.clearTimeout(timer);
  }, [computedAtSec]);
  return { ...query, nowSec };
}
