// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { useDependencyScenarios } from "../use-dependency-scenarios";
import { selectDependencyScenario } from "@/app/dependency-map/dependency-scenario-view";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("withdraws cached current numbers at the artifact budget before the next fetch", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data: DependencyScenariosResponse = { artifact: { schemaVersion: 2, sourcePublicationGenerationId: "pub", sourceBaseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`, methodologyVersion: "10.01", evaluationBuildDigest: "b".repeat(64), computedAtSec: 990, cohort: { rootIds: [], selection: "Top direct exposure" }, scenarios: [] }, freshness: { status: "current", reason: null, ageSec: 10, budgetSec: 7200, sourcePublicationGenerationId: "pub", acceptedPublicationGenerationId: "pub" } };
  client.setQueryData(["dependency-scenarios", "v2"], data);
  function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
  const { result } = renderHook(() => {
    const query = useDependencyScenarios();
    return selectDependencyScenario(query.data, [], "", "pub", query.isError, query.nowSec);
  }, { wrapper: Wrapper });
  expect(result.current.current).toBe(true);
  act(() => { vi.advanceTimersByTime(7_190_001); });
  expect(result.current.current).toBe(false);
  expect(result.current.showNumbers).toBe(false);
  expect(result.current.state).toContain("Artifact exceeds its freshness budget");
  client.clear();
});
