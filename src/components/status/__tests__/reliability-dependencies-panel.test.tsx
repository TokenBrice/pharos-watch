// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReliabilityDependenciesPanel } from "../reliability-dependencies-panel";
import { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-model";
import {
  makeHealthyHealthResponse,
  makeOperationalDependencyFailureStatusResponse,
} from "@/test-utils/status-fixtures";

afterEach(cleanup);

describe("ReliabilityDependenciesPanel", () => {
  it("renders root causes, provider circuits, and canary evidence from the status payload", () => {
    const data = makeOperationalDependencyFailureStatusResponse();
    const model = buildReliabilityWorkspaceModel({
      data,
      healthData: makeHealthyHealthResponse(),
      healthLoading: false,
      probes: [],
      probesLoading: false,
      browserProbeSummary: null,
      requestSourceStats: null,
      requestSourceLoading: true,
    });

    render(<ReliabilityDependenciesPanel model={model.dependencies} />);

    expect(screen.getByRole("table", { name: "Dependency root causes" })).toBeTruthy();
    expect(screen.getByText("Fixture market cache")).toBeTruthy();
    expect(screen.getByText("fixture-market-cache")).toBeTruthy();
    expect(screen.getByText("fixture-provider-a")).toBeTruthy();
    expect(screen.getByText("Fixture publication invariant")).toBeTruthy();
    expect(screen.getByText("fixture-publication-check")).toBeTruthy();
  });
});
