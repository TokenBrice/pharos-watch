// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentPanel } from "./instrument-panel";
import { useTelegramPulse } from "@/hooks/api-hooks";
import { TELEGRAM_METRIC_SEMANTICS } from "@shared/lib/telegram-metrics";
import type { TelegramPulse } from "@shared/types/status";

vi.mock("@/hooks/api-hooks", () => ({
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

vi.mock("@/hooks/use-count-up", () => ({
  useCountUp: (target: number | null | undefined) => ({
    value: target ?? null,
    display: target == null ? null : target.toLocaleString("en-US"),
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
  pendingDeliveries: 7,
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

function mockPulse(data: TelegramPulse | undefined, overrides: { isLoading?: boolean; isError?: boolean } = {}) {
  mockUseTelegramPulse.mockReturnValue({
    data,
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
  } as ReturnType<typeof useTelegramPulse>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InstrumentPanel", () => {
  it("shows the live adoption board in full — nothing folded away", () => {
    mockPulse(pulse);
    render(<InstrumentPanel />);

    expect(screen.getByRole("heading", { name: "Live adoption" })).toBeTruthy();
    expect(screen.getByText("Complete telemetry")).toBeTruthy();
    // Dominant watcher figure with its live count (also shown as the latest
    // daily snapshot in the lifecycle header).
    expect(screen.getByText(TELEGRAM_METRIC_SEMANTICS.activeWatchers.label)).toBeTruthy();
    expect(screen.getAllByText("1,842").length).toBeGreaterThan(0);
    // Follows with the explicit/preset split.
    expect(screen.getByText(TELEGRAM_METRIC_SEMANTICS.coinFollows.label)).toBeTruthy();
    expect(screen.getByText(/5,000 explicit · 621 preset-implied/)).toBeTruthy();
    expect(screen.getByText(/81 chats using presets/)).toBeTruthy();
    // Lifecycle today.
    expect(screen.getByText("New today")).toBeTruthy();
    expect(screen.getByText("Reactivated today")).toBeTruthy();
    expect(screen.getByText("Churned today")).toBeTruthy();
    // Most-followed coins and the lifecycle chart stay on the surface — the old
    // board folded them behind a details element.
    expect(screen.getByText("Most followed")).toBeTruthy();
    expect(screen.getByText("USDe")).toBeTruthy();
    expect(screen.getByRole("figure", { name: /lifecycle chart with 2 daily points/i })).toBeTruthy();
    expect(screen.queryByText("Adoption history")).toBeNull();
    expect(screen.queryByText(/watcher load scenarios|modeled workloads|fixed capacity limit/i)).toBeNull();
    expect(screen.getByRole("link", { name: "status page" }).getAttribute("href")).toMatch(/^\/status\/?$/);
  });

  it("keeps operational Mini App and delivery counts off the public board", () => {
    mockPulse({
      ...pulse,
      miniAppDeniedToday: 1,
      miniAppMutationsToday: 1,
      miniAppReplayClaimsToday: 1,
      miniAppSessionsToday: 2,
    });
    render(<InstrumentPanel />);

    expect(screen.queryByText("Mini App today")).toBeNull();
    expect(screen.queryByText("Sessions today")).toBeNull();
    expect(screen.queryByText("Mutations today")).toBeNull();
    expect(screen.queryByText("Denied today")).toBeNull();
    expect(screen.queryByText("Queued deliveries")).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
  });

  it("keeps the lifecycle placeholder only when no history points are available", () => {
    mockPulse({ ...pulse, watcherHistory: [], lifecycleHistoryUpdatedAt: null });
    render(<InstrumentPanel />);

    expect(screen.getByText(/Historical watcher points will appear/i)).toBeTruthy();
    expect(screen.queryByRole("figure", { name: /lifecycle chart/i })).toBeNull();
  });

  it("renders generic partial telemetry state without exposing operator errors", () => {
    mockPulse({
      ...pulse,
      quality: { status: "partial", unavailableFields: ["topCoins"], errors: { topCoins: "D1 unavailable" } },
    });
    render(<InstrumentPanel />);

    expect(screen.getByText("Partial telemetry")).toBeTruthy();
    expect(screen.getByText(/Some public Telegram telemetry is temporarily unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/D1 unavailable/i)).toBeNull();
  });

  it("renders a loading state and an honest unavailable state", () => {
    mockPulse(undefined, { isLoading: true });
    const { unmount } = render(<InstrumentPanel />);
    const loading = screen.getByRole("status", { name: "Loading Telegram adoption metrics" });
    expect(loading.getAttribute("aria-live")).toBe("polite");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    unmount();

    mockPulse(undefined, { isError: true });
    render(<InstrumentPanel />);
    const unavailable = screen.getByRole("status", { name: "Telegram adoption metrics unavailable" });
    expect(unavailable.getAttribute("aria-live")).toBe("polite");
    expect(unavailable.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy();
  });
});
