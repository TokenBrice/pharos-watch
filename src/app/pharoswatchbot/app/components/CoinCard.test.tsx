// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoinCard } from "./CoinCard";
import type { FollowedPreset, SubscribedCoin, TelegramMiniAppState } from "../types";

type GlobalAlerts = TelegramMiniAppState["subscriber"]["globalAlerts"];

const NO_GLOBAL: GlobalAlerts = { dews: false, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };

function makeCoin(
  alertTypes: Partial<SubscribedCoin["alertTypes"]>,
  alertOverrides: Partial<NonNullable<SubscribedCoin["alertOverrides"]>> = {},
): SubscribedCoin {
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    alertTypes: { dews: false, depeg: false, safety: false, launch: false, reserve: false, ...alertTypes },
    alertOverrides: { dews: false, depeg: false, safety: false, launch: false, reserve: false, ...alertOverrides },
    dewsMinBand: null,
    depegStepBps: null,
    safetyMode: null,
    snoozeUntilTs: null,
  };
}

function renderCard(overrides: { coin: SubscribedCoin; globalAlerts?: GlobalAlerts; presets?: FollowedPreset[] }) {
  return render(
    <CoinCard
      coin={overrides.coin}
      globalAlerts={overrides.globalAlerts ?? NO_GLOBAL}
      presets={overrides.presets ?? []}
      canMutate
      isMutating={false}
      pendingOperation={null}
      onMutate={vi.fn()}
      onRemove={vi.fn()}
      onOpenInsight={vi.fn()}
      webApp={null}
      nowSec={1_700_000_000}
      highlighted={false}
    />,
  );
}

afterEach(() => cleanup());

describe("CoinCard source chip (C74)", () => {
  it("renders a Per-coin chip when a per-coin flag is enabled", () => {
    renderCard({ coin: makeCoin({ dews: true }) });
    expect(screen.getByText("Per-coin")).toBeTruthy();
  });

  it("renders a Per-coin chip when only Reserve is enabled", () => {
    renderCard({ coin: makeCoin({ reserve: true }) });
    expect(screen.getByText("Per-coin")).toBeTruthy();
  });

  it("renders a Muted override chip for an all-off row that suppresses a global default", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, depegStepBps: null };
    renderCard({ coin: makeCoin({}, { dews: true }), globalAlerts: global });
    expect(screen.getByText("Muted override")).toBeTruthy();
  });

  it("renders an All-stablecoins chip when nothing covers the coin", () => {
    renderCard({ coin: makeCoin({}) });
    expect(screen.getByText("All-stablecoins")).toBeTruthy();
  });

  it("keeps long symbol/source-chip rows wrappable on narrow webviews", () => {
    renderCard({
      coin: {
        ...makeCoin({}),
        symbol: "SUPERLONGSTABLECOINSYMBOL",
        name: "A coin with a long display name",
      },
    });

    const symbol = screen.getByText("SUPERLONGSTABLECOINSYMBOL");
    expect(symbol.className).toContain("truncate");
    expect(symbol.parentElement?.className).toContain("flex-wrap");
    expect(screen.getByText("All-stablecoins").className).toContain("truncate");
  });

  it("keeps remove, snooze, and tune targets at least 44px with visible focus styles", () => {
    renderCard({ coin: makeCoin({ dews: true }) });

    const remove = screen.getByRole("button", { name: "Remove USDC" });
    expect(remove.className).toContain("min-h-11");
    expect(remove.className).toContain("min-w-11");

    for (const label of ["Snooze USDC", "Tune USDC"]) {
      const summary = screen.getByText(label).closest("summary");
      expect(summary).toBeTruthy();
      expect(summary?.className).toContain("min-h-11");
      expect(summary?.className).toContain("pharos-focus-ring");
    }
  });
});
