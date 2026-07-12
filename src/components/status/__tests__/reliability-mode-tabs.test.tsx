// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReliabilityModeSummary } from "@/lib/reliability-workspace-model";
import { ReliabilityModeTabs } from "../reliability-mode-tabs";

const MODES: ReliabilityModeSummary[] = [
  { id: "impact", label: "Impact", issueCount: 1, severity: "critical" },
  { id: "endpoints", label: "Endpoints", issueCount: 0, severity: "healthy" },
  { id: "dependencies", label: "Dependencies", issueCount: 2, severity: "watch" },
];

afterEach(cleanup);

describe("ReliabilityModeTabs", () => {
  it("preserves reliability labels, sizing, IDs, and keyboard navigation", () => {
    const onModeChange = vi.fn();
    render(<ReliabilityModeTabs activeMode="impact" modes={MODES} onModeChange={onModeChange} />);

    const tablist = screen.getByRole("tablist", { name: "Reliability views" });
    const impactTab = screen.getByRole("tab", { name: /Impact/ });
    const dependenciesTab = screen.getByRole("tab", { name: /Dependencies/ });

    expect(tablist.className.split(/\s+/)).not.toContain("w-full");
    expect(impactTab.className).toContain("min-w-[7.5rem]");
    expect(impactTab.id).toBe("reliability-tab-impact");
    expect(impactTab.getAttribute("aria-controls")).toBe("reliability-panel-impact");

    impactTab.focus();
    fireEvent.keyDown(impactTab, { key: "End" });
    expect(onModeChange).toHaveBeenCalledWith("dependencies");
    expect(document.activeElement).toBe(dependenciesTab);
  });
});
