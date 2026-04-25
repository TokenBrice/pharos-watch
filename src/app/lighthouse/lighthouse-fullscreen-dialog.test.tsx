// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLighthouseCinematicModel } from "./cinematic-model";
import { LighthouseFullscreenDialog } from "./lighthouse-fullscreen-dialog";

afterEach(() => cleanup());

function makeModel() {
  return buildLighthouseCinematicModel({
    chains: [],
    totalUsd: 0,
    stabilityIndex: null,
    stressSignals: null,
    stablecoins: [],
    selectedHarborId: null,
  });
}

describe("LighthouseFullscreenDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <LighthouseFullscreenDialog
        open={false}
        model={makeModel()}
        onOpenChange={() => {}}
        onModeChange={() => {}}
        onSelectHarbor={() => {}}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("lighthouse-stage-svg")).toBeNull();
  });

  it("renders a labeled fullscreen stage when open", () => {
    render(
      <LighthouseFullscreenDialog
        open={true}
        model={makeModel()}
        onOpenChange={() => {}}
        onModeChange={() => {}}
        onSelectHarbor={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /pharos lighthouse/i });
    expect(dialog.className).toContain("sm:max-w-none");
    expect(screen.getByTestId("lighthouse-stage-svg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Expand lighthouse" })).toBeNull();
  });

  it("closes from the toolbar close button", () => {
    const onOpenChange = vi.fn();
    render(
      <LighthouseFullscreenDialog
        open={true}
        model={makeModel()}
        onOpenChange={onOpenChange}
        onModeChange={() => {}}
        onSelectHarbor={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /close lighthouse/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps mode callbacks live inside fullscreen", () => {
    const onModeChange = vi.fn();
    render(
      <LighthouseFullscreenDialog
        open={true}
        model={makeModel()}
        onOpenChange={() => {}}
        onModeChange={onModeChange}
        onSelectHarbor={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Atlas mode" }));
    expect(onModeChange).toHaveBeenCalledWith("atlas");
  });
});
