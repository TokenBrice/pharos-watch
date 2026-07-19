// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineModeSummary } from "@/lib/pipeline-workspace-model";
import { PipelineModeTabs } from "../pipeline-mode-tabs";

const MODES: PipelineModeSummary[] = [
  { id: "quality", label: "Quality", issueCount: 1, severity: "watch" },
  { id: "markets", label: "Markets", issueCount: 0, severity: "healthy" },
  { id: "reserves", label: "Reserves", issueCount: 2, severity: "critical" },
  { id: "yield", label: "Yield", issueCount: 0, severity: "healthy" },
  { id: "storage", label: "Storage", issueCount: 1, severity: "unknown" },
  { id: "integrity", label: "Integrity", issueCount: 3, severity: "critical" },
];

afterEach(cleanup);

describe("PipelineModeTabs", () => {
  it("contains the wide tab strip in a local horizontal scroller", () => {
    render(<PipelineModeTabs activeMode="quality" modes={MODES} onModeChange={vi.fn()} />);

    const tablist = screen.getByRole("tablist", { name: "Pipeline views" });
    expect(tablist.className).toContain("w-full");
    expect(tablist.className).toContain("min-w-0");
    expect(tablist.className).toContain("max-w-full");
    expect(tablist.className).toContain("overflow-x-auto");
    expect(tablist.firstElementChild?.className).toContain("min-w-max");
    expect(screen.getAllByRole("tab")).toHaveLength(MODES.length);
    expect(screen.getByRole("tab", { name: /Quality/ }).className).toContain("min-h-11");
    expect(screen.getByRole("tab", { name: /Quality/ }).className).toContain("min-w-[6.5rem]");
  });

  it("moves selection and focus with the shared roving-tab keyboard controls", () => {
    const onModeChange = vi.fn();
    render(<PipelineModeTabs activeMode="quality" modes={MODES} onModeChange={onModeChange} />);

    const qualityTab = screen.getByRole("tab", { name: /Quality/ });
    const marketsTab = screen.getByRole("tab", { name: /Markets/ });
    qualityTab.focus();
    fireEvent.keyDown(qualityTab, { key: "ArrowRight" });

    expect(onModeChange).toHaveBeenCalledWith("markets");
    expect(document.activeElement).toBe(marketsTab);
  });
});
