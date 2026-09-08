// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATUS_FIXTURE_NOW_SECONDS } from "@/test-utils/status-fixtures";

const { useCredentialLifecycleSummaryMock } = vi.hoisted(() => ({
  useCredentialLifecycleSummaryMock: vi.fn(),
}));

vi.mock("@/hooks/admin-api-hooks", () => ({
  useCredentialLifecycleSummary: useCredentialLifecycleSummaryMock,
}));

import { CredentialSummaryCard } from "../credential-summary-card";

const NOW = STATUS_FIXTURE_NOW_SECONDS;


afterEach(() => {
  vi.clearAllMocks();
});

describe("CredentialSummaryCard", () => {
  it("summarizes the inventory and links lifecycle work to API Management", () => {
    useCredentialLifecycleSummaryMock.mockReturnValue({
      data: {
        generatedAt: NOW,
        totalKeys: 4,
        active: 3,
        expiringSoon: 1,
        expired: 1,
        nonExpiring: 1,
        auditAnomalies7d: 2,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<CredentialSummaryCard />);

    expect(screen.getByRole("heading", { level: 2, name: "Credentials" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open API Management/ }).getAttribute("href")).toMatch(/^\/admin-api\/?$/);
    expect(screen.getByText("Expired").nextElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Audit anomalies").nextElementSibling?.textContent).toBe("2");
    // Summary only: no inventory rows or row actions leak into Triage.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Rotate/ })).toBeNull();
  });

  it("keeps counts Unknown with a local retry when the inventory fails", () => {
    const refetch = vi.fn();
    useCredentialLifecycleSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });

    render(<CredentialSummaryCard />);

    expect(screen.getAllByText("Unknown")).toHaveLength(5);
    screen.getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
