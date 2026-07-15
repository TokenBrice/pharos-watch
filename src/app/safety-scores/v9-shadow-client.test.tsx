// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeReportCardsV9Response } from "@/test/fixtures/safety-score-v9";
import { ReportCardsV9ShadowClient } from "./v9-shadow-client";

const { useReportCardsV9 } = vi.hoisted(() => ({ useReportCardsV9: vi.fn() }));

vi.mock("@/hooks/api-hooks", () => ({ useReportCardsV9 }));
vi.mock("@/components/report-card-v9", () => ({
  ReportCardsV9ShadowRenderer: ({ response, expectedIdentity }: {
    response: ReturnType<typeof makeReportCardsV9Response>;
    expectedIdentity: ReturnType<typeof makeReportCardsV9Response>["safetyScoreIdentity"];
  }) => (
    <div data-testid="v9-renderer" data-model={expectedIdentity.model}>
      {response.cards.length}
    </div>
  ),
}));

describe("ReportCardsV9ShadowClient", () => {
  afterEach(cleanup);

  it("uses only the V9 hook and passes its exact identity to the native renderer", () => {
    const data = makeReportCardsV9Response();
    useReportCardsV9.mockReturnValue({ data, isLoading: false, error: null });
    render(<ReportCardsV9ShadowClient />);
    expect(screen.getByTestId("v9-renderer").getAttribute("data-model")).toBe("v9");
  });

  it("renders an explicit unavailable state", () => {
    useReportCardsV9.mockReturnValue({ data: undefined, isLoading: false, error: new Error("offline") });
    render(<ReportCardsV9ShadowClient />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  });
});
