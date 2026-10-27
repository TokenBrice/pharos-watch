// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { DEWSRadarPanel } from "@/components/dews-summary";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { ApiFetchError } from "@/lib/api";

const { useStablecoinsMock, useStressSignalsMock } = vi.hoisted(() => ({
  useStablecoinsMock: vi.fn(),
  useStressSignalsMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useStressSignals: useStressSignalsMock,
}));

const RETAINED_SIGNALS = {
  updatedAt: 1_775_898_800,
  signals: {
    "frax-frax": { score: 88, band: "DANGER" },
    "usdc-circle": { score: 68, band: "WARNING" },
    "usdt-tether": { score: 42, band: "ALERT" },
    "dai-makerdao": { score: 25, band: "WATCH" },
  },
};

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: useStablecoinsMock,
}));

beforeEach(() => {
  installMatchMediaMock(true);
  useStablecoinsMock.mockReturnValue({ data: undefined });
  useStressSignalsMock.mockReturnValue({ data: RETAINED_SIGNALS, isLoading: false, error: null });
});
afterEach(cleanupFrontendTest);


describe("DEWSRadarPanel radar logos", () => {
  it("announces unavailable supply without turning it into the observed-zero size tier", () => {
    useStablecoinsMock.mockReturnValue({ data: { peggedAssets: [
      makeStablecoin({ id: "usdc-circle", circulating: {} }),
      makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 0 } }),
    ] } });
    const { getByRole, getByText } = render(<DEWSRadarPanel />);
    const missing = getByRole("button", { name: /USDC.*supply unavailable/ });
    const zero = getByRole("button", { name: /USDT.*\$0.*market cap/ });
    expect(missing.getAttribute("aria-label")).not.toContain("$0");
    expect(zero.getAttribute("aria-label")).not.toContain("supply unavailable");
    fireEvent.focus(missing);
    expect(getByText("Supply unavailable")).toBeTruthy();
  });
});

describe("DEWSRadarPanel refresh errors", () => {
  it.each([
    ["network", new TypeError("Failed to fetch")],
    ["503", new ApiFetchError("/api/stress-signals", 503, null)],
  ])("keeps the retained radar and focusable marks through a %s refresh error", (_label, error) => {
    useStressSignalsMock.mockReturnValue({ data: RETAINED_SIGNALS, isLoading: false, error });
    const { getByRole, queryByText } = render(<DEWSRadarPanel />);
    const mark = getByRole("button", { name: /USDC/ });
    mark.focus();
    expect(document.activeElement).toBe(mark);
    expect(queryByText(/Connection issue|Waiting for first sync|Failed to load/)).toBeNull();
  });

  it("keeps the load-error notice when no radar was ever retained", () => {
    useStressSignalsMock.mockReturnValue({ data: undefined, isLoading: false, error: new TypeError("Failed to fetch") });
    const { getByText, queryByRole } = render(<DEWSRadarPanel />);
    expect(getByText("Connection issue")).toBeTruthy();
    expect(queryByRole("button", { name: /USDC/ })).toBeNull();
  });

  it("keeps a successful empty map empty across a refresh error rather than inventing marks", () => {
    useStressSignalsMock.mockReturnValue({
      data: { updatedAt: 1_775_898_800, signals: {} }, isLoading: false, error: new Error("HTTP 502"),
    });
    const { container } = render(<DEWSRadarPanel />);
    expect(container.innerHTML).toBe("");
  });
});

describe("DEWSRadarPanel open-incident halos", () => {
  it("describes a haloed coin as having an open confirmed incident, not a live depeg", () => {
    const { getByRole, getByText } = render(<DEWSRadarPanel activeDepegIds={new Set(["usdc-circle"])} />);
    expect(getByRole("button", { name: /USDC.*with an open confirmed incident/ })).toBeTruthy();
    expect(getByText("Elevated, open confirmed incident (1)")).toBeTruthy();
    expect(getByRole("button", { name: /FRAX/ }).getAttribute("aria-label")).not.toContain("incident");
  });
});
