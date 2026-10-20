// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CoinCard } from "./CoinCard";
import { makeSubscribedCoin as makeCoin } from "@shared/test-utils/telegram-mini-app-state";
import type { FollowedPreset, SubscribedCoin, TelegramMiniAppOperation, TelegramMiniAppState } from "../types";

type GlobalAlerts = TelegramMiniAppState["subscriber"]["globalAlerts"];

const NO_GLOBAL: GlobalAlerts = { dews: false, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };

function renderCard(overrides: { coin: SubscribedCoin; globalAlerts?: GlobalAlerts; presets?: FollowedPreset[]; onMutate?: (operation: TelegramMiniAppOperation) => void }) {
  return render(
    <CoinCard
      coin={overrides.coin}
      globalAlerts={overrides.globalAlerts ?? NO_GLOBAL}
      presets={overrides.presets ?? []}
      canMutate
      isMutating={false}
      pendingOperation={null}
      onMutate={overrides.onMutate ?? vi.fn()}
      onRemove={vi.fn()}
      onOpenInsight={vi.fn()}
      webApp={null}
      nowSec={1_700_000_000}
      highlighted={false}
    />,
  );
}

describe("CoinCard source chip (C74)", () => {
  it.each([
    ["USDC DEWS minimum band", "Default", "dewsMinBand"],
    ["USDC depeg step", "Any", "depegStepBps"],
    ["USDC safety mode", "Default", "safetyMode"],
  ])("sends a null tuning patch, not Off, from %s", (group, label, field) => {
    const onMutate = vi.fn();
    renderCard({
      coin: { ...makeCoin({ dews: true, depeg: true, safety: true }), dewsMinBand: "DANGER", depegStepBps: 250, safetyMode: "downgrade-only" },
      onMutate,
    });
    fireEvent.click(screen.getByText("Tune USDC"));
    fireEvent.click(within(screen.getByRole("group", { name: group })).getByRole("button", { name: (name) => name.startsWith(label) }));
    expect(onMutate).toHaveBeenCalledWith({ kind: "set-coin", stablecoinId: "usdc-circle", patch: { [field]: null } });
    expect(screen.getByRole("button", { name: "USDC DEWS" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders a Per-coin chip when a per-coin flag is enabled", () => {
    renderCard({ coin: makeCoin({ dews: true }) });
    expect(screen.getByText("Per-coin")).toBeTruthy();
  });

  it("renders a Muted override chip for an all-off row that suppresses a global default", () => {
    const global: GlobalAlerts = { dews: true, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null };
    renderCard({ coin: makeCoin({}, { dews: true }), globalAlerts: global });
    expect(screen.getByText("Muted override")).toBeTruthy();
  });

  it("renders an All-stablecoins chip when nothing covers the coin", () => {
    renderCard({ coin: makeCoin({}) });
    expect(screen.getByText("All-stablecoins")).toBeTruthy();
  });
});
