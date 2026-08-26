// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MintBurnCard } from "@/components/home-alt-mini-cards/mint-burn-card";
import { PegHealthCard } from "@/components/home-alt-mini-cards/peg-health-card";
import { RecentFreezesCard } from "@/components/home-alt-mini-cards/recent-freezes-card";

const { useBlacklistEventsPageMock, useMintBurnFlowsMock, usePegSummaryMock } = vi.hoisted(() => ({
  useBlacklistEventsPageMock: vi.fn(),
  useMintBurnFlowsMock: vi.fn(),
  usePegSummaryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({ usePegSummary: usePegSummaryMock }));
vi.mock("@/hooks/use-blacklist-events", () => ({ useBlacklistEventsPage: useBlacklistEventsPageMock }));
vi.mock("@/hooks/use-mint-burn-flows", () => ({ useMintBurnFlows: useMintBurnFlowsMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("homepage monitoring failure states", () => {
  it("does not leave Peg Health in a skeleton after a terminal request failure", () => {
    usePegSummaryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("peg summary failed"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });

    render(<PegHealthCard />);

    expect(screen.getByRole("alert").textContent).toContain("Peg health data is temporarily unavailable");
  });

  it("does not translate a mint/burn request failure into no activity", () => {
    useMintBurnFlowsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("flow feed failed"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });
    render(<MintBurnCard />);

    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    expect(screen.queryByText("No 24h activity")).toBeNull();
  });

  it("distinguishes an unavailable freeze feed from a valid zero-event window", () => {
    useBlacklistEventsPageMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("freeze feed failed"),
      refetch: vi.fn(),
      dataUpdatedAt: 0,
    });
    const view = render(<RecentFreezesCard />);
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    view.unmount();

    useBlacklistEventsPageMock.mockReturnValue({
      data: { events: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      dataUpdatedAt: 1_700_000_000_000,
    });
    render(<RecentFreezesCard />);

    expect(screen.getByText("$0")).toBeTruthy();
    expect(screen.getByText("0X")).toBeTruthy();
  });
});
