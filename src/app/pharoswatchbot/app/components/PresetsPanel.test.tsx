// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMiniAppState } from "../mini-app-test-fixtures";
import { PresetsPanel } from "./PresetsPanel";

const state = makeMiniAppState({
  presets: [{ id: "usd-top25", label: "USD Top 25", alertTypes: { dews: true, depeg: false, safety: false }, depegStepBps: 250 }],
  subscriptions: [],
  catalog: { recommendedPresets: [{ id: "usd-top25", label: "USD Top 25" }], searchableCoins: [] },
});

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
