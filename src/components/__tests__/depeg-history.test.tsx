// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DepegHistory } from "@/components/depeg-history";
import type { DepegEvent } from "@shared/types";
import { makeEvent } from "./depeg.test-support";

const { useInfiniteDepegEventsMock } = vi.hoisted(() => ({
  useInfiniteDepegEventsMock: vi.fn(),
}));

vi.mock("@/hooks/use-depeg-events", () => ({
  useInfiniteDepegEvents: useInfiniteDepegEventsMock,
}));

afterEach(() => {
  useInfiniteDepegEventsMock.mockReset();
});


function mockEvents(events: DepegEvent[], overrides: Record<string, unknown> = {}) {
  useInfiniteDepegEventsMock.mockReturnValue({
    data: { events, total: events.length },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetchingNextPage: false,
    loadedCount: events.length,
    isFullyLoaded: true,
    ...overrides,
  });
}

describe("DepegHistory provenance badges", () => {
  it("withholds partial metrics until all history has loaded", () => {
    const events = [makeEvent()];
    mockEvents(events, { data: { events, total: 2 }, isFullyLoaded: false, isFetchingNextPage: true });
    const view = render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.getByText(/Loading full history.*1 \/ 2 incidents/)).toBeTruthy();
    expect(screen.queryByText("Worst Depeg")).toBeNull();
    expect(screen.queryByText("Current Streak")).toBeNull();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
    mockEvents([...events, makeEvent({ id: 2, peakDeviationBps: -350, endedAt: null })]);
    view.rerender(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.queryByText(/Loading full history/)).toBeNull();
    expect(screen.getByText("Worst Depeg").parentElement?.textContent).toContain("-350 bps");
    expect(screen.getByText("Current Streak").parentElement?.textContent).toContain("Depegged now");
  });

  it.each([false, true])("offers retry after failure with retained rows=%s", (hasRows) => {
    const refetch = vi.fn();
    mockEvents(hasRows ? [makeEvent()] : [], { error: new Error("history unavailable"), refetch });
    render(<DepegHistory stablecoinId="usdc-circle" />);
    expect(screen.queryByTestId("stablecoin-depeg-history-table") !== null).toBe(hasRows);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders pending_reason and confirmation_sources badges when present", () => {
    mockEvents([
      makeEvent({
        id: 42,
        confirmationSources: "DEX+CEX",
        pendingReason: "large-cap",
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.getByTestId("stablecoin-depeg-history-table").getAttribute("data-table-id")).toBe(
      "stablecoin-depeg-history",
    );
    expect(screen.getByTestId("event-source").textContent).toContain("live");
    expect(screen.getByTestId("event-pending-reason").textContent).toContain("large cap");
    expect(screen.getByTestId("event-confirmed-by").textContent).toContain("DEX, CEX");
  });

  it("omits both badges for legacy events where provenance fields are null", () => {
    mockEvents([
      makeEvent({
        id: 7,
        confirmationSources: null,
        pendingReason: null,
      }),
    ]);

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(screen.getByTestId("event-source").textContent).toContain("live");
    expect(screen.queryByTestId("event-pending-reason")).toBeNull();
    expect(screen.queryByTestId("event-confirmed-by")).toBeNull();
  });
});

function tableRowCount(): number {
  return screen.getByTestId("stablecoin-depeg-history-table").querySelectorAll("tbody tr").length;
}

describe("DepegHistory incident fold", () => {
  it("opens truncated to six incidents and hides pagination while folded", () => {
    mockEvents(Array.from({ length: 9 }, (_, i) => makeEvent({ id: i + 1, startedAt: 1_700_000_000 - i * 86_400 })));

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(tableRowCount()).toBe(6);
    expect(screen.getByRole("button", { name: "Show all 9 incidents" })).toBeTruthy();
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
  });

  it("pages past 25 incidents then folds back to the newest six", () => {
    mockEvents(Array.from({ length: 27 }, (_, i) => makeEvent({
      id: i + 1, startedAt: 1_700_000_000 - i * 86_400, pendingReason: `incident-${i + 1}`,
    })));
    render(<DepegHistory stablecoinId="usdc-circle" />);
    const table = screen.getByTestId("stablecoin-depeg-history-table");
    const identities = () => within(table).getAllByTestId("event-pending-reason").map((node) => node.textContent);
    expect(identities()).toEqual(Array.from({ length: 6 }, (_, i) => `incident ${i + 1}`));
    fireEvent.click(screen.getByRole("button", { name: "Show all 27 incidents" }));
    expect(tableRowCount()).toBe(25);
    fireEvent.click(screen.getAllByRole("button", { name: "Go to next page" })[0]);
    expect(identities()).toEqual(["incident 26", "incident 27"]);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(identities()).toEqual(Array.from({ length: 6 }, (_, i) => `incident ${i + 1}`));
    expect(screen.queryByLabelText("Go to next page")).toBeNull();
  });

  it("keeps short histories unfolded", () => {
    mockEvents(Array.from({ length: 4 }, (_, i) => makeEvent({ id: i + 1, startedAt: 1_700_000_000 - i * 86_400 })));

    render(<DepegHistory stablecoinId="usdc-circle" />);

    expect(tableRowCount()).toBe(4);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
