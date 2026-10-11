"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { DepegHistory } from "@/components/depeg-history";
import { DdrTrackRecordSection } from "@/components/stablecoin-detail/ddr-track-record-section";
import { SafetyScoreHistorySection } from "@/components/stablecoin-detail/safety-score-history-section";
import { useDepegResolverReview, useSafetyScoreHistory, useSafetyScoreHistoryV2 } from "@/hooks/api-hooks";
import { TAB_PANEL_REVEAL_EVENT } from "@/lib/anchor-reveal";
import { isDepegResolverEnabled, isDepegResolverReviewerEnabled } from "@/lib/feature-flags";
import { projectDdrTrackRecordSummary } from "@/lib/stablecoin-detail-ddr-track-record-client";
import { cn } from "@/lib/utils";

type HistoryTabsProps = Omit<ComponentProps<typeof DepegHistory>, "stablecoinId"> & {
  stablecoinId: string;
  isNavToken: boolean;
};

type HistoryTabKey = "grade" | "depeg" | "ddr";

interface HistoryTab {
  key: HistoryTabKey;
  label: string;
  /** Deep-link anchor owned by the panel, so a hash resolves even while the tab is inactive. */
  anchorId: string;
  content: ReactNode;
}

/**
 * Grade history, depeg history and the DDR record share one tabbed module:
 * three stacked cards cost ~1,400px for what readers scan one at a time.
 * A tab renders only when its module would: Grade while its history loads or
 * once any point (or an error) is published; Depeg for non-NAV coins (its own
 * empty and limited-coverage states stay stated inside); DDR when a record
 * exists or its source is unavailable, mirroring `DdrTrackRecordSection`.
 * Inactive panels keep their anchor id and reveal on a hash jump.
 */
export function HistoryTabs({ stablecoinId, isNavToken, ...depegProps }: HistoryTabsProps) {
  const legacyGrades = useSafetyScoreHistory(stablecoinId);
  const identityGrades = useSafetyScoreHistoryV2(stablecoinId);
  const ddrEnabled = !isNavToken && isDepegResolverEnabled() && isDepegResolverReviewerEnabled();
  const ddrQuery = useDepegResolverReview({ enabled: ddrEnabled });
  const [selected, setSelected] = useState<HistoryTabKey | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const gradesLoading = legacyGrades.isLoading || identityGrades.isLoading;
  const hasGrades = gradesLoading
    || legacyGrades.error != null
    || identityGrades.error != null
    || (legacyGrades.data?.length ?? 0) > 0
    || (identityGrades.data?.history.length ?? 0) > 0;
  const ddrData = ddrQuery.data;
  const hasDdr = ddrEnabled && (
    projectDdrTrackRecordSummary(ddrData, stablecoinId) != null
    || ddrQuery.error != null
    || ddrData?._meta?.degraded === true
    || (ddrData != null && ddrData.summary.byStablecoin == null)
  );

  const tabs: HistoryTab[] = [];
  if (hasGrades) {
    tabs.push({ key: "grade", label: "Grade", anchorId: "grade-history", content: <SafetyScoreHistorySection stablecoinId={stablecoinId} /> });
  }
  if (!isNavToken) {
    tabs.push({
      key: "depeg",
      label: "Depeg",
      anchorId: "depeg-history",
      content: (
        <DepegHistory stablecoinId={stablecoinId} {...depegProps} />
      ),
    });
  }
  if (hasDdr) {
    tabs.push({ key: "ddr", label: "DDR record", anchorId: "ddr-track-record", content: <DdrTrackRecordSection stablecoinId={stablecoinId} /> });
  }
  const active = tabs.find((tab) => tab.key === selected) ?? tabs[0];

  // A hash naming a panel (or anything inside it) selects that tab: on load,
  // on `hashchange`, and synchronously when `revealAnchorId` asks before scrolling.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const selectFor = (target: Element | null) => {
      const panel = target?.closest<HTMLElement>("[data-history-tab]");
      if (panel && root.contains(panel)) setSelected(panel.dataset.historyTab as HistoryTabKey);
    };
    const onHash = () => {
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      } catch {
        return;
      }
      if (id) selectFor(document.getElementById(id));
    };
    const onReveal = (event: Event) => {
      const panel = (event.target as HTMLElement).dataset.historyTab as HistoryTabKey | undefined;
      if (panel) flushSync(() => setSelected(panel));
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    root.addEventListener(TAB_PANEL_REVEAL_EVENT, onReveal);
    return () => {
      window.removeEventListener("hashchange", onHash);
      root.removeEventListener(TAB_PANEL_REVEAL_EVENT, onReveal);
    };
  }, []);

  if (!active) return null;

  return (
    <div ref={rootRef} className="space-y-3">
      {tabs.length > 1 ? (
        <div role="tablist" aria-label="History views" className="flex flex-wrap gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`history-tab-${tab.key}`}
              aria-selected={tab.key === active.key}
              aria-controls={tab.anchorId}
              onClick={() => setSelected(tab.key)}
              className={cn(
                "pharos-focus-ring pharos-control-pill shrink-0 px-3 sm:px-2.5 sm:py-1",
                tab.key === active.key && "pharos-control-pill-active",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={tab.anchorId}
          role={tabs.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={tabs.length > 1 ? `history-tab-${tab.key}` : undefined}
          data-history-tab={tab.key}
          data-tab-panel=""
          hidden={tab.key !== active.key}
          className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6"
        >
          {tab.key === active.key ? tab.content : null}
        </div>
      ))}
    </div>
  );
}
