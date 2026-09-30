"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { useDependencyExposureMode, type DependencyExposureResult, type DependencyExposureRow } from "@/hooks/use-dependency-exposure-mode";
import { readDependencyExposureUrl, writeDependencyExposureUrl, type DependencyExposureUrlState } from "@/lib/dependency-exposure-url";
import { trackEvent } from "@/lib/analytics";
import { DependencyExposureControls, type ExposureRootOption } from "./dependency-exposure-controls";
import { DependencyExposureResults } from "./dependency-exposure-results";

export function useDependencyExposureWorkspace(publication: ReportCardsV9Response | undefined) {
  const [state, setState] = useState<DependencyExposureUrlState>({ mode: "explore", roots: [] });
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"setup" | "results" | "graph">("setup");
  const resultsTab = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const exposure = useDependencyExposureMode(publication, state.roots);
  useEffect(() => {
    const readUrl = () => { const next = readDependencyExposureUrl(window.location.search); setState(next); setTab(next.roots.length ? "results" : "setup"); setInspectedId(null); };
    readUrl();
    window.addEventListener("popstate", readUrl);
    return () => window.removeEventListener("popstate", readUrl);
  }, []);
  const update = (next: DependencyExposureUrlState) => {
    setState(next);
    setInspectedId(null);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${writeDependencyExposureUrl(window.location.search, next)}${window.location.hash}`);
  };
  const addRoot = (id: string) => {
    if (document.activeElement instanceof HTMLElement && (state.mode === "explore" || (!opener.current && !document.activeElement.closest("#exposure-panel-setup")))) opener.current = document.activeElement;
    update({ mode: "exposure", roots: [...new Set([...state.roots, id])] });
    setTab("results");
    requestAnimationFrame(() => { if (resultsTab.current?.offsetParent !== null) resultsTab.current?.focus(); });
    trackEvent("dependency_map_action", { action: "root_change", value: id });
    if (state.mode !== "exposure") trackEvent("dependency_map_action", { action: "mode_switch", value: "exposure" });
  };
  const overlay = useMemo(() => state.mode === "exposure" && state.roots.length > 0 && exposure.result ? {
    roots: state.roots, rows: new Map(exposure.result.rows.map(row => [row.id, row])),
    highlightedPaths: exposure.result.rows.find(row => row.id === inspectedId)?.paths ?? [],
  } : null, [state, exposure.result, inspectedId]);
  const switchMode = (mode: "explore" | "exposure") => {
    if (mode === "exposure") opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    update({ ...state, mode });
    if (mode === "explore") requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
      else document.querySelector<HTMLButtonElement>('[data-exposure-mode="explore"]')?.focus();
    });
    trackEvent("dependency_map_action", { action: "mode_switch", value: mode });
  };
  const modeControls = <div className="flex gap-2 p-3" aria-label="Dependency map mode">{(["explore", "exposure"] as const).map(mode => <button key={mode} data-exposure-mode={mode} type="button" aria-pressed={state.mode === mode} className={state.mode === mode ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active min-h-11 px-4 text-sm" : "pharos-focus-ring pharos-control-pill min-h-11 px-4 text-sm"} onClick={() => switchMode(mode)}>{mode === "explore" ? "Explore" : "Exposure"}</button>)}</div>;
  return { state, exposure, overlay, modeControls, addRoot, inspectedId, tab, setTab, resultsTab,
    removeRoot: (id: string) => { update({ ...state, roots: state.roots.filter(root => root !== id) }); trackEvent("dependency_map_action", { action: "root_change", value: id }); },
    reset: () => {
      update({ mode: "explore", roots: [] });
      if (state.mode !== "explore") trackEvent("dependency_map_action", { action: "mode_switch", value: "explore" });
      if (state.roots.length) trackEvent("dependency_map_action", { action: "root_change", value: "reset" });
      requestAnimationFrame(() => {
        if (opener.current?.isConnected) opener.current.focus();
        else document.querySelector<HTMLButtonElement>('[data-exposure-mode="explore"]')?.focus();
      });
    },
    share: () => { void navigator.clipboard?.writeText(window.location.href); trackEvent("dependency_map_action", { action: "share", value: "exposure" }); },
    inspect: (id: string) => { setInspectedId(id); trackEvent("dependency_map_action", { action: "inspect_path", value: id }); },
    close: () => switchMode("explore"),
  };
}

export interface DependencyExposureWorkspaceState {
  state: DependencyExposureUrlState;
  exposure: { result: DependencyExposureResult | null; publication: ReportCardsV9Response | undefined; networkUpdated: boolean; held: boolean };
  overlay: { roots: readonly string[]; rows: ReadonlyMap<string, DependencyExposureRow>; highlightedPaths: readonly (readonly string[])[] } | null;
  modeControls: ReactNode;
  addRoot: (id: string) => void;
  removeRoot: (id: string) => void;
  reset: () => void;
  share: () => void;
  inspect: (id: string) => void;
  close: () => void;
  inspectedId: string | null;
  tab: "setup" | "results" | "graph";
  setTab: (tab: "setup" | "results" | "graph") => void;
  resultsTab: RefObject<HTMLButtonElement | null>;
}

export function DependencyExposureWorkspace({ workspace, options, children }: {
  workspace: DependencyExposureWorkspaceState; options: readonly ExposureRootOption[]; children: ReactNode;
}) {
  const { state, exposure, tab, setTab } = workspace;
  return <div className="space-y-4">
    {state.mode === "exposure" && <div className="flex flex-wrap gap-2 md:hidden">
      <div role="tablist" aria-label="Exposure workspace" className="flex gap-2">
        {(["setup", "results", "graph"] as const).map((value, index, tabs) => <button type="button" key={value} ref={value === "results" ? workspace.resultsTab : undefined} role="tab" tabIndex={tab === value ? 0 : -1} id={`exposure-tab-${value}`} aria-controls={`exposure-panel-${value}`} aria-selected={tab === value} className="pharos-focus-ring min-h-11 rounded border border-border px-3 text-sm aria-selected:bg-muted" onClick={() => setTab(value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          const next = tabs[nextIndex]!;
          setTab(next);
          document.getElementById(`exposure-tab-${next}`)?.focus();
        }}>{value === "setup" ? "Setup" : value === "results" ? "Results" : "Graph"}</button>)}
      </div>
      <button type="button" className="pharos-focus-ring min-h-11 rounded px-3 text-sm" onClick={workspace.close}>Close exposure</button>
    </div>}
    <div className={state.mode === "exposure" ? "grid gap-4 md:grid-cols-[minmax(0,1fr)_19rem]" : "grid gap-4"}>
      <div id="exposure-panel-graph" role={state.mode === "exposure" ? "tabpanel" : undefined} aria-labelledby={state.mode === "exposure" ? "exposure-tab-graph" : undefined} className={state.mode === "exposure" && tab !== "graph" ? "hidden min-w-0 md:block" : "min-w-0 md:col-span-1"}>{children}</div>
      {state.mode === "exposure" && <div id="exposure-panel-setup" role="tabpanel" aria-labelledby="exposure-tab-setup" className={tab !== "setup" ? "hidden md:block" : "block"}><DependencyExposureControls roots={state.roots} options={options} onAdd={workspace.addRoot} onRemove={workspace.removeRoot} onReset={workspace.reset} onShare={workspace.share} /></div>}
    </div>
    {state.mode === "exposure" && exposure.result && exposure.publication && <div id="exposure-panel-results" role="tabpanel" aria-labelledby="exposure-tab-results" className={tab !== "results" ? "hidden md:block" : "block"}><DependencyExposureResults result={exposure.result} publication={exposure.publication} roots={state.roots} options={options} inspectedId={workspace.inspectedId} onInspect={workspace.inspect} networkUpdated={exposure.networkUpdated} held={exposure.held} /></div>}
  </div>;
}
