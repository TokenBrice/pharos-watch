"use client";

import { WorkspaceModeTabs } from "@/components/status/workspace-mode-tabs";
import type { ReliabilityMode, ReliabilityModeSummary } from "@/lib/reliability-workspace-model";

export function getReliabilityTabId(mode: ReliabilityMode): string {
  return `reliability-tab-${mode}`;
}

export function getReliabilityPanelId(mode: ReliabilityMode): string {
  return `reliability-panel-${mode}`;
}

export function ReliabilityModeTabs({
  activeMode,
  modes,
  onModeChange,
}: {
  activeMode: ReliabilityMode;
  modes: ReliabilityModeSummary[];
  onModeChange: (mode: ReliabilityMode) => void;
}) {
  return (
    <WorkspaceModeTabs
      activeMode={activeMode}
      modes={modes}
      onModeChange={onModeChange}
      ariaLabel="Reliability views"
      tabClassName="min-w-[7.5rem]"
      getTabId={getReliabilityTabId}
      getPanelId={getReliabilityPanelId}
    />
  );
}
