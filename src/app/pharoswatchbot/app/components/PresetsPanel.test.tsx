// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramMiniAppState } from "../types";
import { PresetsPanel } from "./PresetsPanel";

const state: TelegramMiniAppState = {
  viewer: {
    userId: "42",
    username: "watcher",
    chatId: "42",
    chatType: "private",
    canMutate: true,
    mutationBlockReason: null,
  },
  subscriber: {
    exists: true,
    globalAlerts: {
      dews: true,
      depeg: true,
      safety: false,
      launch: false,
      reserve: false,
      freeze: false,
      depegStepBps: 250,
    },
    quietHours: { enabled: false, startHourUtc: null, endHourUtc: null, timezone: "UTC" },
    snoozeUntilTs: null,
  },
  presets: [
    {
      id: "usd-top25",
      label: "USD Top 25",
      alertTypes: { dews: true, depeg: false, safety: false },
      depegStepBps: 250,
    },
  ],
  subscriptions: [],
  catalog: {
    recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }],
    searchableCoins: [],
  },
  health: {
    lastSuccessfulDeliveryAt: null,
    lastSuccessfulReplyAt: null,
    queuedAlerts: 0,
    recentFailureClass: null,
  },
};

afterEach(cleanup);

describe("PresetsPanel", () => {
  it("keeps the final enabled alert family on and directs the user to Unfollow", () => {
    const onMutate = vi.fn();
    const onUnfollowPreset = vi.fn();
    render(
      <PresetsPanel
        state={state}
        canMutate
        isMutating={false}
        pendingOperation={null}
        onMutate={onMutate}
        onUnfollowPreset={onUnfollowPreset}
      />,
    );

    const finalFamily = screen.getByRole("button", { name: "USD Top 25 DEWS" });
    expect(finalFamily.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Keep at least one alert family enabled. Use Unfollow to stop this preset.")).toBeTruthy();

    fireEvent.click(finalFamily);
    expect(onMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Unfollow USD Top 25" }));
    expect(onUnfollowPreset).toHaveBeenCalledWith(state.presets[0]);

    fireEvent.click(screen.getByRole("button", { name: "USD Top 25 Depeg" }));
    expect(onMutate).toHaveBeenCalledWith({
      kind: "follow-preset",
      presetId: "usd-top25",
      alertTypes: { dews: true, depeg: true, safety: false },
      depegStepBps: 250,
    });
  });
});
