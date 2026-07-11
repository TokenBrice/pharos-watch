// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusCause } from "@shared/types";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { PublicAdminSplitPanel } from "../public-admin-split-panel";

afterEach(cleanup);

describe("PublicAdminSplitPanel", () => {
  it("uses the normalized issue collection so duplicate causes count once", () => {
    const maintenanceCause: StatusCause = {
      code: "ddr_repair_debt_present",
      layer: "data-quality",
      severity: "warning",
      message: "Four DDR source events await repair.",
    };
    const base = makeHealthyStatusResponse();
    const data = {
      ...base,
      causes: {
        overall: [maintenanceCause],
        availability: [],
        dataQuality: [maintenanceCause],
      },
    };

    render(<PublicAdminSplitPanel data={data} healthData={makeHealthyHealthResponse()} browserProbeSummary={null} />);

    expect(screen.getByText("Maintenance").parentElement?.textContent).toBe("Maintenance1");
    expect(screen.getByText("Impacting").parentElement?.textContent).toBe("Impacting0");
    expect(screen.getByText("Admin service state is healthy. 1 planned maintenance item remains.")).toBeDefined();
    expect(screen.queryByText(/admin blockers/i)).toBeNull();
  });

  it("renders missing public health as unknown rather than healthy", () => {
    render(<PublicAdminSplitPanel data={makeHealthyStatusResponse()} healthData={null} browserProbeSummary={null} />);

    expect(screen.getByText("Public").parentElement?.textContent).toBe("Publicunknown");
    expect(screen.getByText("Public health has not loaded in this browser session.")).toBeDefined();
  });
});
