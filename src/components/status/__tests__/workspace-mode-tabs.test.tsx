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
  it("labels every mode tab with its issue load and wires the selected panel relationship", () => {
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

    expect(screen.getByRole("tablist", { name: "Pipeline views" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    const qualityTab = screen.getByRole("tab", { name: /Quality/ });
    expect(tabs).toHaveLength(MODES.length);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // Severity and issue count reach assistive tech, not only the pill colour.
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Quality1 issues, watch",
      "Markets0 issues, healthy",
      "Reserves2 issues, critical",
    ]);
    expect(qualityTab.id).toBe("pipeline-tab-quality");
    expect(qualityTab.getAttribute("aria-controls")).toBe("pipeline-panel-quality");
    // Unselected tabs own no panel, so no dangling aria-controls target exists.
    expect(tabs.slice(1).map((tab) => tab.hasAttribute("aria-controls"))).toEqual([false, false]);
  });

  it("keeps shared roving-tab keyboard controls under a second workspace prefix", () => {
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

    expect(screen.getByRole("tablist", { name: "Reliability views" })).toBeTruthy();
    const qualityTab = screen.getByRole("tab", { name: /Quality/ });
    const reservesTab = screen.getByRole("tab", { name: /Reserves/ });
    expect(qualityTab.tabIndex).toBe(0);
    expect(reservesTab.tabIndex).toBe(-1);
    expect(qualityTab.id).toBe("reliability-tab-quality");

    qualityTab.focus();
    fireEvent.keyDown(qualityTab, { key: "End" });
    expect(onModeChange).toHaveBeenCalledWith("reserves");
    expect(document.activeElement).toBe(reservesTab);
  });
});
