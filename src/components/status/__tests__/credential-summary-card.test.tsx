// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { useCredentialLifecycleSummaryMock } = vi.hoisted(() => ({
  useCredentialLifecycleSummaryMock: vi.fn(),
}));

vi.mock("@/hooks/admin-api-hooks", () => ({
  useCredentialLifecycleSummary: useCredentialLifecycleSummaryMock,
}));

import { CredentialSummaryCard } from "../credential-summary-card";

afterEach(() => {
  vi.clearAllMocks();
});

describe("CredentialSummaryCard", () => {
  it("keeps counts Unknown with a local retry when the inventory fails", () => {
    const refetch = vi.fn();
    useCredentialLifecycleSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });

    render(<CredentialSummaryCard />);

    expect(screen.getAllByText("Unknown")).toHaveLength(5);
    screen.getByRole("button", { name: "Retry" }).click();
    expect(refetch).toHaveBeenCalled();
  });

  it("marks retained counts as the last successful load after a failed refresh", () => {
    useCredentialLifecycleSummaryMock.mockReturnValue({
      data: { generatedAt: 1_700_000_000, totalKeys: 4, active: 3, expiringSoon: 1, expired: 0, nonExpiring: 0, auditAnomalies7d: 0 },
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: vi.fn(),
    });

    render(<CredentialSummaryCard />);

    expect(screen.queryByText(/counts below are Unknown/)).toBeNull();
    expect(screen.getByText(/counts below are the last successful load/)).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("of 4 total keys")).toBeTruthy();
  });
});
