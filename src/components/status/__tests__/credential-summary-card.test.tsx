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
});
