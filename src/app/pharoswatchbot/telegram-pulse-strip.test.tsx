// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramPulseBoard, TelegramPulseStrip } from "./telegram-pulse-strip";
import { useTelegramPulse } from "@/hooks/use-telegram-pulse";
import type { TelegramPulse } from "@shared/types/status";

vi.mock("@/hooks/use-telegram-pulse", () => ({
  useTelegramPulse: vi.fn(),
}));

vi.mock("@/hooks/use-chart-container-ready", () => ({
  useChartContainerReady: () => ({
    ref: vi.fn(),
    ready: false,
    width: 0,
    height: 0,
  }),
}));

const mockUseTelegramPulse = vi.mocked(useTelegramPulse);

const pulse: TelegramPulse = {
  activeWatchers: 1842,
  coinSubscriptions: 5621,
  explicitCoinSubscriptions: 5000,
  presetImpliedCoinSubscriptions: 621,
  activePresetFollowers: 81,
  newWatchersToday: 12,
  churnedWatchersToday: 3,
  reactivatedWatchersToday: 5,
  historySource: "snapshot",
  topCoins: ["USDT", "USDC", "USDe", "DAI", "USD1"],
  watcherHistory: [
    {
      date: "2026-04-01",
      timestamp: 1_775_001_600_000,
      snapshotAt: 1_775_002_000,
      newWatchers: 12,
      activeWatchers: 1700,
    },
    {
      date: "2026-04-02",
      timestamp: 1_775_088_000_000,
      snapshotAt: 1_775_088_400,
      newWatchers: 142,
      activeWatchers: 1842,
    },
  ],
  alertTypeChats: {
    dews: 1701,
    depeg: 1644,
    safety: 1512,
    launch: 1208,
    allTypes: 1191,
  },
  quietHoursEnabledChats: 42,
  pendingDeliveries: null,
  currentSnapshotAt: 1_771_856_400,
  lifecycleHistoryUpdatedAt: 1_775_002_000,
  lifecycleHistoryEverySeconds: 900,
  quality: { status: "complete", unavailableFields: [] },
  privacy: {
    exactActiveWatchers: true,
    lowCardinalityThreshold: 5,
    suppressedFields: ["pendingDeliveries"],
  },
  updatedAt: 1_771_856_400,
  updatedEverySeconds: 300,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TelegramPulseStrip", () => {
  it("renders the compact public pulse metrics", () => {
    mockUseTelegramPulse.mockReturnValue({ data: pulse, isLoading: false, isError: false } as ReturnType<
      typeof useTelegramPulse
    >);

    render(<TelegramPulseStrip />);

    expect(screen.getByText("1,842")).toBeTruthy();
    expect(screen.getByText(/estimated capacity/i)).toBeTruthy();
    expect(screen.getByText("5,621")).toBeTruthy();
    expect(screen.getByText(/updated every 5m/i)).toBeTruthy();
    expect(screen.getByText(/USDT, USDC, USDe/)).toBeTruthy();
  });

  it("renders the unavailable state without hiding bot setup", () => {
    mockUseTelegramPulse.mockReturnValue({ data: undefined, isLoading: false, isError: true } as ReturnType<
      typeof useTelegramPulse
    >);

    render(<TelegramPulseStrip />);

    expect(screen.getByText(/commands still work/i)).toBeTruthy();
  });
});

describe("TelegramPulseBoard", () => {
  it("renders all public aggregate pulse fields intentionally", () => {
    mockUseTelegramPulse.mockReturnValue({ data: pulse, isLoading: false, isError: false } as ReturnType<
      typeof useTelegramPulse
    >);

    render(<TelegramPulseBoard />);

    expect(screen.getByText("Active Telegram chats")).toBeTruthy();
    expect(screen.getByText("Estimated capacity")).toBeTruthy();
    expect(screen.getByText(/active watcher target/i)).toBeTruthy();
    expect(screen.getByText(/37% used/i)).toBeTruthy();
    expect(screen.getByText("Alert follows")).toBeTruthy();
    expect(screen.getByText("Most followed")).toBeTruthy();
    expect(screen.getByText("Explicit follows")).toBeTruthy();
    expect(screen.getByText("Preset-implied")).toBeTruthy();
    expect(screen.getByText("Preset followers")).toBeTruthy();
    expect(screen.getByText("New today")).toBeTruthy();
    expect(screen.getByText("Reactivated today")).toBeTruthy();
    expect(screen.getByText("Churned today")).toBeTruthy();
    expect(screen.getByText("DEWS chats")).toBeTruthy();
    expect(screen.getByText("Depeg chats")).toBeTruthy();
    expect(screen.getByText("Safety chats")).toBeTruthy();
    expect(screen.getByText("Launch chats")).toBeTruthy();
    expect(screen.getByText("All alert families")).toBeTruthy();
    expect(screen.getByText("Quiet hours enabled")).toBeTruthy();
    expect(screen.getByText("1,701")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText(/the chart is lifecycle history/i)).toBeTruthy();
    expect(screen.getByRole("figure", { name: /watcher growth chart/i })).toBeTruthy();
    expect(screen.queryByText(/Historical watcher points will appear/i)).toBeNull();
    expect(screen.getByText(/Low-cardinality deltas below 5/i)).toBeTruthy();
    const telemetry = screen.getByLabelText("Telegram aggregate alert telemetry");
    expect(within(telemetry).queryByText("Queued deliveries")).toBeNull();
  });

  it("keeps the lifecycle placeholder only when no history points are available", () => {
    mockUseTelegramPulse.mockReturnValue({
      data: {
        ...pulse,
        watcherHistory: [],
        lifecycleHistoryUpdatedAt: null,
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useTelegramPulse>);

    render(<TelegramPulseBoard />);

    expect(screen.getByText(/Historical watcher points will appear/i)).toBeTruthy();
    expect(screen.queryByRole("figure", { name: /watcher growth chart/i })).toBeNull();
  });

  it("renders the lifecycle chart for a single snapshot history point", () => {
    mockUseTelegramPulse.mockReturnValue({
      data: {
        ...pulse,
        activeWatchers: 519,
        watcherHistory: [
          {
            date: "2026-05-13",
            timestamp: 1_778_630_400_000,
            snapshotAt: 1_778_680_473,
            newWatchers: 305,
            activeWatchers: 519,
            churnedWatchers: 0,
            reactivatedWatchers: 0,
          },
        ],
        lifecycleHistoryUpdatedAt: 1_778_680_473,
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useTelegramPulse>);

    render(<TelegramPulseBoard />);

    expect(screen.getByRole("figure", { name: /1 daily points/i })).toBeTruthy();
    expect(screen.queryByText(/Historical watcher points will appear/i)).toBeNull();
  });

  it("renders generic partial telemetry state without exposing operator errors", () => {
    mockUseTelegramPulse.mockReturnValue({
      data: {
        ...pulse,
        quality: { status: "partial", unavailableFields: ["topCoins"], errors: { topCoins: "D1 unavailable" } },
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useTelegramPulse>);

    render(<TelegramPulseBoard />);

    expect(screen.getByText(/Some public Telegram telemetry is temporarily unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/D1 unavailable/i)).toBeNull();
  });

  it("renders loading placeholders", () => {
    mockUseTelegramPulse.mockReturnValue({ data: undefined, isLoading: true, isError: false } as ReturnType<
      typeof useTelegramPulse
    >);

    render(<TelegramPulseBoard />);

    expect(screen.getByLabelText("Loading Telegram adoption metrics")).toBeTruthy();
  });
});
