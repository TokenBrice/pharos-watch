// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";

const { useDailyDigestMock } = vi.hoisted(() => ({
  useDailyDigestMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDailyDigest: useDailyDigestMock,
}));

vi.mock("@/lib/fonts/digest", () => ({
  digestDisplay: { className: "digest-display-test" },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DailyDigestCard", () => {
  it("uses the current digest title and short text instead of placeholder promo copy", () => {
    useDailyDigestMock.mockReturnValue({
      data: {
        digestTitle: "USDT's Quiet Billion-Dollar Exit",
        digest:
          "$1.14B of USDT's $1.24B weekly outflow landed in the last 24 hours. If Tether prints another $1B tomorrow, the drift becomes rotation.",
        digestExtended: null,
      },
    });

    render(<DailyDigestCard />);

    expect(screen.getByText("Daily Digest")).toBeTruthy();
    expect(screen.getByText(/USDT's Quiet Billion-Dollar Exit/i)).toBeTruthy();
    expect(screen.getByText(/\$1\.14B of USDT's \$1\.24B weekly outflow/i)).toBeTruthy();
    expect(screen.queryByText(/Best stablecoin watcher/i)).toBeNull();
    expect(screen.getByRole("link", { name: /View Digest/i }).getAttribute("href")).toBe("/digest");
    expect(screen.getByRole("link", { name: /Read on Telegram/i }).getAttribute("href")).toBe(
      "https://t.me/pharoswatch",
    );
  });
});
