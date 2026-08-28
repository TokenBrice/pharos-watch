// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyDigestCard } from "@/components/home-alt-mini-cards/daily-digest-card";

const { useDailyDigestMock, useDigestArchiveMock } = vi.hoisted(() => ({
  useDailyDigestMock: vi.fn(),
  useDigestArchiveMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useDailyDigest: useDailyDigestMock,
  useDigestArchive: useDigestArchiveMock,
}));

vi.mock("@/lib/fonts/digest", () => ({
  digestDisplay: { className: "digest-display-test" },
}));

afterEach(() => {
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
        editionNumber: 407,
      },
    });
    useDigestArchiveMock.mockReturnValue({
      data: {
        digests: [
          {
            digestTitle: "USDT's Quiet Billion-Dollar Exit",
            digestText: "$1.14B of USDT's $1.24B weekly outflow landed in the last 24 hours.",
            digestExtended: null,
            generatedAt: 1_800_000_000,
            psiScore: null,
            psiBand: null,
            totalMcapUsd: null,
            editionNumber: 407,
          },
          {
            digestTitle: "USDC Rebuilds Its Cushion",
            digestText: "Circle adds supply.",
            digestExtended: null,
            generatedAt: 1_799_913_600,
            psiScore: null,
            psiBand: null,
            totalMcapUsd: null,
            editionNumber: 406,
          },
          {
            digestTitle: "PYUSD Finds Weekend Demand",
            digestText: "PayPal moves higher.",
            digestExtended: null,
            generatedAt: 1_799_827_200,
            psiScore: null,
            psiBand: null,
            totalMcapUsd: null,
            editionNumber: 405,
          },
        ],
      },
    });

    render(<DailyDigestCard />);

    expect(screen.getByText("Daily Digest")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /#407 — USDT's Quiet Billion-Dollar Exit/i })).toBeTruthy();
    expect(screen.getByText("#406")).toBeTruthy();
    expect(screen.getByText(/USDC Rebuilds Its Cushion/i)).toBeTruthy();
    expect(screen.getByText("#405")).toBeTruthy();
    expect(screen.getByText(/PYUSD Finds Weekend Demand/i)).toBeTruthy();
    expect(screen.getByText(/USDT's Quiet Billion-Dollar Exit/i)).toBeTruthy();
    expect(screen.getByText(/\$1\.14B of USDT's \$1\.24B weekly outflow/i)).toBeTruthy();
    expect(screen.queryByText(/Pharos Watch/i)).toBeNull();
    expect(screen.queryByText(/Best stablecoin watcher/i)).toBeNull();
    expect(screen.getByRole("link", { name: /View Digest/i }).getAttribute("href")).toBe("/digest");
    expect(screen.getByRole("link", { name: /Read on Telegram/i }).getAttribute("href")).toBe(
      "https://t.me/pharoswatch",
    );
  });
});
