// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    const strip = screen.getByText("1,842").closest("div");
    expect(strip?.getAttribute("aria-live")).toBe("polite");
    expect(strip?.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText(/estimated capacity/i)).toBeTruthy();
    expect(screen.getByText("5,621")).toBeTruthy();
    expect(screen.getByText(/alert links \(incl\. presets\)/i)).toBeTruthy();
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
  it("keeps the main pulse summary visible and folds deeper telemetry below the lifecycle chart", () => {
    mockUseTelegramPulse.mockReturnValue({ data: pulse, isLoading: false, isError: false } as ReturnType<
      typeof useTelegramPulse
    >);

    render(<TelegramPulseBoard />);

    const capacity = screen.getByText("Active / estimated capacity");
    const board = screen.getByLabelText("Live Telegram adoption metrics");
    expect(board.getAttribute("aria-live")).toBe("polite");
    expect(board.getAttribute("aria-busy")).toBe("false");
    const alertFollows = screen.getByText("Alert follows");
    const topFollowed = screen.getByText("Most followed");
    expect(capacity).toBeTruthy();
    expect(screen.getByText(/37% used/i)).toBeTruthy();
    expect(alertFollows).toBeTruthy();
    expect(topFollowed).toBeTruthy();
    const lifecycle = screen.getByText("Telegram chat lifecycle");
    expect(lifecycle).toBeTruthy();
    expect(screen.getByRole("figure", { name: /chat lifecycle chart/i })).toBeTruthy();
    expect(screen.queryByText(/Historical watcher points will appear/i)).toBeNull();
    expect(screen.queryByText(/Low-cardinality deltas below 5/i)).toBeNull();
    const summary = screen.getByText("More information").closest("summary") as HTMLElement | null;
    expect(summary).toBeTruthy();
    const details = summary?.closest("details") as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(Boolean(capacity.compareDocumentPosition(lifecycle) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(lifecycle.compareDocumentPosition(summary as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    fireEvent.click(summary as HTMLElement);

    expect(details?.open).toBe(true);
    const pulseDetails = screen.getByLabelText("Additional Telegram pulse details");
    expect(within(pulseDetails).queryByText("Active / estimated capacity")).toBeNull();
    expect(within(pulseDetails).queryByText("Alert follows")).toBeNull();
    expect(within(pulseDetails).queryByText("Most followed")).toBeNull();
    expect(within(pulseDetails).getByText("Follow composition")).toBeTruthy();
    expect(within(pulseDetails).getByText("Explicit coin follows")).toBeTruthy();
    expect(within(pulseDetails).getByText("Preset-implied follows")).toBeTruthy();
    expect(within(pulseDetails).getByText("Chats using presets")).toBeTruthy();
    expect(within(pulseDetails).getByText("Daily lifecycle")).toBeTruthy();
    expect(within(pulseDetails).getByText("New today")).toBeTruthy();
    expect(within(pulseDetails).getByText("Reactivated today")).toBeTruthy();
    expect(within(pulseDetails).getByText("Churned today")).toBeTruthy();
    expect(within(pulseDetails).getByText("Alert coverage")).toBeTruthy();
    expect(within(pulseDetails).getByText("DEWS chats")).toBeTruthy();
    expect(within(pulseDetails).getByText("Depeg chats")).toBeTruthy();
    expect(within(pulseDetails).getByText("Safety chats")).toBeTruthy();
    expect(within(pulseDetails).getByText("Launch chats")).toBeTruthy();
    expect(within(pulseDetails).getByText("All four families")).toBeTruthy();
    expect(within(pulseDetails).getByText("Delivery controls")).toBeTruthy();
    expect(within(pulseDetails).getByText("Quiet-hours chats")).toBeTruthy();
    expect(within(pulseDetails).getByText("1,701")).toBeTruthy();
    expect(within(pulseDetails).getByText("42")).toBeTruthy();
    const telemetry = screen.getByLabelText("Telegram aggregate alert telemetry");
    expect(within(telemetry).queryByText("Queued deliveries")).toBeNull();
  });

  it("clamps estimated capacity usage copy at the same bound as the bar", () => {
    mockUseTelegramPulse.mockReturnValue({
      data: { ...pulse, activeWatchers: 6_000 },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useTelegramPulse>);

    render(<TelegramPulseBoard />);

    expect(screen.getByText(/100% used/i)).toBeTruthy();
    expect(screen.queryByText(/120% used/i)).toBeNull();
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
    expect(screen.queryByRole("figure", { name: /chat lifecycle chart/i })).toBeNull();
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

    const loading = screen.getByLabelText("Loading Telegram adoption metrics");
    expect(loading).toBeTruthy();
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-busy")).toBe("true");
  });
});
