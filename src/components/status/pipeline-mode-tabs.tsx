"use client";

import { WorkspaceModeTabs } from "@/components/status/workspace-mode-tabs";
import type { PipelineMode, PipelineModeSummary } from "@/lib/pipeline-workspace-model";

export function getPipelineTabId(mode: PipelineMode): string {
  return `pipeline-tab-${mode}`;
}

export function getPipelinePanelId(mode: PipelineMode): string {
  return `pipeline-panel-${mode}`;
}

export function PipelineModeTabs({
  activeMode,
  modes,
  onModeChange,
}: {
  activeMode: PipelineMode;
  modes: PipelineModeSummary[];
  onModeChange: (mode: PipelineMode) => void;
}) {
  return (
    <WorkspaceModeTabs
      activeMode={activeMode}
      modes={modes}
      onModeChange={onModeChange}
      ariaLabel="Pipeline views"
      className="w-full"
      tabClassName="min-w-[6.5rem]"
      getTabId={getPipelineTabId}
      getPanelId={getPipelinePanelId}
    />
  );
}
