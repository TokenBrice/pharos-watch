// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC, DEPENDENCY_SCENARIOS_INTERVAL_MS, type DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { useDependencyScenarios } from "../use-dependency-scenarios";
import { selectDependencyScenario } from "@/app/dependency-map/dependency-scenario-view";
import * as apiQuery from "../use-api-query";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("withdraws cached current numbers at the artifact budget before the next fetch", () => {
  const pollingOptions = vi.spyOn(apiQuery, "createApiPollingQueryOptions");
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data: DependencyScenariosResponse = { artifact: { schemaVersion: 2, sourcePublicationGenerationId: "pub", sourceBaseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`, methodologyVersion: "10.01", evaluationBuildDigest: "b".repeat(64), computedAtSec: 990, cohort: { rootIds: [], selection: "Top direct exposure" }, scenarios: [] }, freshness: { status: "current", reason: null, ageSec: 10, budgetSec: DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC, sourcePublicationGenerationId: "pub", acceptedPublicationGenerationId: "pub" } };
  client.setQueryData(["dependency-scenarios", "v2"], data);
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
  const { result } = renderHook(() => {
    const query = useDependencyScenarios();
    return selectDependencyScenario(query.data, [], "", "pub", query.isError, query.nowSec);
  }, { wrapper: Wrapper });
  expect(result.current.current).toBe(true);
  expect(pollingOptions).toHaveBeenCalledWith(
    ["dependency-scenarios", "v2"], expect.any(String), DEPENDENCY_SCENARIOS_INTERVAL_MS,
    expect.objectContaining({ enabled: true }),
  );
  const options = pollingOptions.mock.results[0]?.value;
  expect(options?.staleTime).toBe(DEPENDENCY_SCENARIOS_INTERVAL_MS);
  expect(options?.refetchInterval).toBe(2 * DEPENDENCY_SCENARIOS_INTERVAL_MS);
  act(() => { vi.advanceTimersByTime((DEPENDENCY_SCENARIOS_FRESHNESS_BUDGET_SEC - 10) * 1000 + 1); });
  expect(result.current.current).toBe(false);
  expect(result.current.showNumbers).toBe(false);
  expect(result.current.state).toContain("Artifact exceeds its freshness budget");
  client.clear();
});
