// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
} from "@shared/lib/telegram-mini-app-contract";
import type { TelegramMiniAppPortabilityResponse, TelegramMiniAppState } from "../types";
import { WatchlistPortabilityPanel } from "./WatchlistPortabilityPanel";

const state: TelegramMiniAppState = {
  viewer: {
    userId: "42",
    username: "watcher",
    chatId: "42",
    chatType: "private",
    canMutate: false,
    mutationBlockReason: "stale-auth",
  },
  subscriber: {
    exists: true,
    globalAlerts: { dews: true, depeg: false, safety: false, launch: false, reserve: false, freeze: false, depegStepBps: null },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
    snoozeUntilTs: null,
  },
  presets: [],
  subscriptions: [],
  catalog: {
    recommendedPresets: [],
    searchableCoins: [{ stablecoinId: "usdc-circle", symbol: "USDC", name: "USD Coin" }],
  },
  health: { lastSuccessfulDeliveryAt: null, lastSuccessfulReplyAt: null, queuedAlerts: 0, recentFailureClass: null },
};

const exportResponse: TelegramMiniAppPortabilityResponse = {
  contractVersion: TELEGRAM_MINI_APP_CONTRACT_VERSION,
  catalogVersion: TELEGRAM_MINI_APP_CATALOG_VERSION,
  result: { kind: "watchlist-export", token: "pw2.payload.digest", directCount: 1, presetCount: 0 },
};

afterEach(cleanup);

describe("WatchlistPortabilityPanel", () => {
  it("keeps signed export and preview available while stale auth disables confirmation", async () => {
    const onExport = vi.fn().mockResolvedValue(exportResponse);
    const onPreview = vi.fn().mockResolvedValue({
      ...exportResponse,
      result: {
        kind: "watchlist-import-preview",
        expectedPreferenceGeneration: 2,
        previewFingerprint: "preview-v1-12-deadbeef",
        preview: {
          directAdds: [], directRemoves: [], directChanges: [],
          presetAdds: [], presetRemoves: [], presetChanges: [],
          directBroadenedCoverage: [], directRemovedCoverage: [],
          presetBroadenedCoverage: [], presetRemovedCoverage: [],
        },
      },
    } satisfies TelegramMiniAppPortabilityResponse);

    render(
      <WatchlistPortabilityPanel
        state={state}
        canMutate={false}
        canReadPortability
        isMutating={false}
        pendingOperation={null}
        onExport={onExport}
        onPreview={onPreview}
        onConfirm={vi.fn()}
      />,
    );

    const exportButton = screen.getByRole("button", { name: "Export watchlist" });
    expect(exportButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(exportButton);
    await waitFor(() => expect(onExport).toHaveBeenCalledOnce());

    const input = screen.getByLabelText("Import a portable token");
    expect(input.hasAttribute("disabled")).toBe(false);
    fireEvent.change(input, { target: { value: "pw2.payload.digest" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replacement" }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith("pw2.payload.digest"));
    await screen.findByText("Exact replacement preview");
    expect(screen.getByRole("button", { name: "Apply exact replacement" }).hasAttribute("disabled")).toBe(true);
  });
});
