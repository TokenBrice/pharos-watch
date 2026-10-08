// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { SystemDiagnostics } from "../system-diagnostics";

afterEach(cleanup);

describe("SystemDiagnostics discrepancy evidence", () => {
  it.each([null, 0, 3])("renders the actual nullable streak (%s)", (streak) => {
    const status = makeHealthyStatusResponse();
    render(<SystemDiagnostics
      state={status.state}
      staleness={status.staleness}
      probe={status.probe}
      discrepancy={{ ...status.discrepancy, consecutiveDivergent: streak }}
      nowSeconds={status.timestamp}
    />);
    expect(screen.getByText(`streak: ${streak ?? "unavailable"}`)).toBeTruthy();
    if (streak == null) expect(screen.queryByText("streak: 0")).toBeNull();
  });
});
