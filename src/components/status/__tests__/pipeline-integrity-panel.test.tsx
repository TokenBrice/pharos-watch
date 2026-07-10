// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PipelineIntegrityPanel } from "../pipeline-integrity-panel";
import { buildPipelineIntegrityModel } from "@/lib/pipeline-workspace-model";
import {
  degraded,
  makeOperationalDependencyFailureStatusResponse,
  makePublicationFailureStatusResponse,
} from "@/test-utils/status-fixtures";

afterEach(cleanup);

describe("PipelineIntegrityPanel", () => {
  it("renders controls, publication surfaces, and dependencies with raw identifiers in detail", () => {
    const dependencyData = makeOperationalDependencyFailureStatusResponse();
    const publicationData = makePublicationFailureStatusResponse();
    const data = degraded(dependencyData, { publicationHealth: publicationData.publicationHealth });

    render(<PipelineIntegrityPanel model={buildPipelineIntegrityModel(data)} />);

    expect(screen.getByRole("table", { name: "Pipeline controls" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Publication surfaces" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Dependencies" })).toBeTruthy();
    expect(screen.getByText("DEX Liquidity")).toBeTruthy();
    expect(screen.getByText("dex-liquidity")).toBeTruthy();
    expect(screen.getByText("Fixture market cache")).toBeTruthy();
    expect(screen.getByText("fixture-market-cache")).toBeTruthy();
  });
});
