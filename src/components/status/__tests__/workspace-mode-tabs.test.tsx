// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceModeIds,
  WorkspaceModeTabs,
  type WorkspaceModeSummary,
} from "../workspace-mode-tabs";

type TestMode = "quality" | "markets" | "reserves";

const MODES: WorkspaceModeSummary<TestMode>[] = [
  { id: "quality", label: "Quality", issueCount: 1, severity: "watch" },
  { id: "markets", label: "Markets", issueCount: 0, severity: "healthy" },
  { id: "reserves", label: "Reserves", issueCount: 2, severity: "critical" },
];


describe("WorkspaceModeTabs", () => {
  it("applies workspace configuration to the shared tab strip", () => {
    const ids = createWorkspaceModeIds("pipeline");
    render(
      <WorkspaceModeTabs
        activeMode="quality"
        modes={MODES}
        onModeChange={vi.fn()}
        ariaLabel="Pipeline views"
        className="w-full"
        tabClassName="min-w-[6.5rem]"
        {...ids}
      />,
    );

    const tablist = screen.getByRole("tablist", { name: "Pipeline views" });
    const qualityTab = screen.getByRole("tab", { name: /Quality/ });
    expect(tablist.className).toContain("w-full");
    expect(tablist.className).toContain("min-w-0");
    expect(tablist.className).toContain("max-w-full");
    expect(tablist.className).toContain("overflow-x-auto");
    expect(tablist.firstElementChild?.className).toContain("min-w-max");
    expect(screen.getAllByRole("tab")).toHaveLength(MODES.length);
    expect(qualityTab.className).toContain("min-h-11");
    expect(qualityTab.className).toContain("min-w-[6.5rem]");
    expect(qualityTab.id).toBe("pipeline-tab-quality");
    expect(qualityTab.getAttribute("aria-controls")).toBe("pipeline-panel-quality");
  });

  it("preserves reliability sizing and shared roving-tab keyboard controls", () => {
    const onModeChange = vi.fn();
    render(
      <WorkspaceModeTabs
        activeMode="quality"
        modes={MODES}
        onModeChange={onModeChange}
        ariaLabel="Reliability views"
        tabClassName="min-w-[7.5rem]"
        {...createWorkspaceModeIds("reliability")}
      />,
    );

    const tablist = screen.getByRole("tablist", { name: "Reliability views" });
    const qualityTab = screen.getByRole("tab", { name: /Quality/ });
    const reservesTab = screen.getByRole("tab", { name: /Reserves/ });
    expect(tablist.className.split(/\s+/)).not.toContain("w-full");
    expect(qualityTab.className).toContain("min-w-[7.5rem]");
    expect(qualityTab.id).toBe("reliability-tab-quality");

    qualityTab.focus();
    fireEvent.keyDown(qualityTab, { key: "End" });
    expect(onModeChange).toHaveBeenCalledWith("reserves");
    expect(document.activeElement).toBe(reservesTab);
  });
});
