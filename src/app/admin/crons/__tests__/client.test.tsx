// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { useStatusMock, sectionPropsMock } = vi.hoisted(() => ({
  useStatusMock: vi.fn(),
  sectionPropsMock: vi.fn(),
}));

vi.mock("@/hooks/use-status", () => ({ useStatus: useStatusMock }));
vi.mock("../../workspace-status-boundary", () => ({
  WorkspaceStatusBoundary: ({ data, children }: { data: unknown; children: (data: unknown) => ReactNode }) =>
    data ? children(data) : null,
}));
vi.mock("../../sections/crons-section", () => ({
  CronsSection: (props: unknown) => {
    sectionPropsMock(props);
    return <div data-testid="crons-section">Cron workbench</div>;
  },
}));

import CronsClient from "../client";

beforeEach(() => {
  const status = makeHealthyStatusResponse();
  status.crons["dispatch-telegram-alerts"] = {
    ...status.crons["dispatch-telegram-alerts"]!,
    inFlight: {
      startedAt: status.timestamp - 30,
      updatedAt: status.timestamp - 5,
      stale: false,
    },
  };
  useStatusMock.mockReturnValue({
    data: status,
    error: null,
    isLoading: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CronsClient", () => {
  it("passes the full registry-grouped cron payload and running count to the routed workbench", () => {
    render(<CronsClient />);

    expect(screen.getByTestId("crons-section")).toBeTruthy();
    const props = sectionPropsMock.mock.calls.at(-1)?.[0] as {
      runningCrons: number;
      cronGroups: Array<{ key: string; entries: Array<[string, unknown]> }>;
      data: ReturnType<typeof makeHealthyStatusResponse>;
    };
    expect(props.runningCrons).toBe(1);
    expect(props.cronGroups).toHaveLength(1);
    expect(props.cronGroups[0]?.key).toBe("five-minute");
    expect(props.cronGroups[0]?.entries.map(([job]) => job)).toEqual(["dispatch-telegram-alerts"]);
    expect(props.data).toBe(useStatusMock.mock.results[0]?.value.data);
  });
});
