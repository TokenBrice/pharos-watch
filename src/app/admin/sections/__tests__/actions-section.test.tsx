// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

vi.mock("@/components/status/admin-actions-panel", () => ({
  AdminActionsPanel: () => null,
}));

import { ActionsSection } from "../actions-section";

afterEach(cleanup);

describe("ActionsSection cron evidence", () => {
  it.each([null, 0])("renders unavailable separately from observed zero (%s)", (count) => {
    const data = makeHealthyStatusResponse();
    data.summary.cronErrors = count;
    data.summary.availabilityImpactingUnhealthyCrons = count;
    data.summary.cronHistoryUnavailableReason = count == null ? "cron-history-read-failed" : null;
    render(<ActionsSection data={data} healthData={makeHealthyHealthResponse()} clientDataStale={false}
      handleRefresh={vi.fn()} recommendedActions={[]} />);
    for (const label of ["Cron errors", "Impacting crons"]) {
      const badge = screen.getByText(label).parentElement!;
      expect(within(badge).getByText(count == null ? "Unavailable" : "0")).toBeTruthy();
      expect(within(badge).queryByText(count == null ? "0" : "Unavailable")).toBeNull();
    }
  });
});
