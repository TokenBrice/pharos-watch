// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramPulseBoard, TelegramPulseStrip } from "./telegram-pulse-strip";
import { useTelegramPulse } from "@/hooks/use-telegram-pulse";
import type { TelegramPulse } from "@shared/types/status";

vi.mock("@/hooks/use-telegram-pulse", () => ({
  useTelegramPulse: vi.fn(),
}));

const mockUseTelegramPulse = vi.mocked(useTelegramPulse);

const pulse: TelegramPulse = {
  activeWatchers: 1842,
  coinSubscriptions: 5621,
  topCoins: ["USDT", "USDC", "USDe", "DAI", "USD1"],
  watcherHistory: [
    {
      date: "2026-04-01",
      timestamp: 1_775_001_600_000,
      newWatchers: 12,
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
  pendingDeliveries: 3,
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
    expect(screen.getByText("Per-coin alert follows")).toBeTruthy();
    expect(screen.getByText("Most followed")).toBeTruthy();
    expect(screen.getByText("DEWS chats")).toBeTruthy();
    expect(screen.getByText("Depeg chats")).toBeTruthy();
    expect(screen.getByText("Safety chats")).toBeTruthy();
    expect(screen.getByText("Launch chats")).toBeTruthy();
    expect(screen.getByText("All alert families")).toBeTruthy();
    expect(screen.getByText("Quiet hours enabled")).toBeTruthy();
    expect(screen.getByText("Queued deliveries")).toBeTruthy();
    expect(screen.getByText("1,701")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    const telemetry = screen.getByLabelText("Telegram aggregate alert telemetry");
    expect(within(telemetry).getByText("3")).toBeTruthy();
  });

  it("renders loading placeholders", () => {
    mockUseTelegramPulse.mockReturnValue({ data: undefined, isLoading: true, isError: false } as ReturnType<
      typeof useTelegramPulse
    >);

    render(<TelegramPulseBoard />);

    expect(screen.getByLabelText("Loading Telegram adoption metrics")).toBeTruthy();
  });
});
