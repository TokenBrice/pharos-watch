"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { DepegHistory as DepegHistoryComponent } from "@/components/depeg-history";
import { Skeleton } from "@/components/ui/skeleton";
import { useDepegResolverReview, useSafetyScoreHistory, useSafetyScoreHistoryV2 } from "@/hooks/api-hooks";
import { TAB_PANEL_REVEAL_EVENT } from "@/lib/anchor-reveal";
import { isDepegResolverEnabled, isDepegResolverReviewerEnabled } from "@/lib/feature-flags";
import { projectDdrTrackRecordSummary } from "@/lib/stablecoin-detail-ddr-track-record-client";
import { cn } from "@/lib/utils";

type DepegHistoryProps = Omit<
  ComponentProps<typeof DepegHistoryComponent>,
  "stablecoinId" | "embeddedPreview" | "onDisplayStateChange"
>;

type HistoryTabsProps = DepegHistoryProps & {
  stablecoinId: string;
  isNavToken: boolean;
  /** The route's History viewport gate; no live module mounts before it. */
  historyActive: boolean;
  /** Server-rendered retained-ledger preview for the pilot profiles, otherwise null. */
  depegHistoryPreview?: ReactNode;
  /** The view to select first; the route's loading and list-error branches open Depeg. */
  initialTab?: HistoryTabKey;
};

type HistoryTabKey = "grade" | "depeg" | "ddr";

interface HistoryTab {
  key: HistoryTabKey;
  label: string;
  /** Deep-link anchor owned by the panel, so a hash resolves even while the tab is inactive. */
  anchorId: string;
  content: ReactNode;
}

interface HistoryTabAvailability {
  grade: boolean;
  ddr: boolean;
}

const LiveSafetyScoreHistorySection = dynamic(
  () => import("@/components/stablecoin-detail/safety-score-history-section").then((mod) => mod.SafetyScoreHistorySection),
  { loading: () => <Skeleton className="h-40 w-full rounded-xl" /> },
);

const LiveDepegHistory = dynamic(
  () => import("@/components/depeg-history").then((mod) => mod.DepegHistory),
  { loading: () => <Skeleton className="h-40 w-full rounded-xl" /> },
);

// With a retained ledger preview the shell already fills the panel, so a
// chunk-load skeleton would stack a second loading surface under it.
const PreviewedLiveDepegHistory = dynamic(
  () => import("@/components/depeg-history").then((mod) => mod.DepegHistory),
  { loading: () => null },
);

const LiveDdrTrackRecordSection = dynamic(
  () => import("@/components/stablecoin-detail/ddr-track-record-section").then((mod) => mod.DdrTrackRecordSection),
  { loading: () => <Skeleton className="h-40 w-full rounded-xl" /> },
);

/**
 * Availability reads live behind the History viewport gate, not in the shell.
 * The initial grade tab is therefore a deterministic loading state instead of
 * an eager `useSafetyScoreHistory` query, and no DDR tab is speculated before
 * its source answers.
 */
function HistoryTabAvailabilityProbe({
  stablecoinId,
  isNavToken,
  onAvailabilityChange,
}: {
  stablecoinId: string;
  isNavToken: boolean;
  onAvailabilityChange: (availability: HistoryTabAvailability) => void;
}) {
  const legacyGrades = useSafetyScoreHistory(stablecoinId);
  const identityGrades = useSafetyScoreHistoryV2(stablecoinId);
  const ddrEnabled = !isNavToken && isDepegResolverEnabled() && isDepegResolverReviewerEnabled();
  const ddrQuery = useDepegResolverReview({ enabled: ddrEnabled });
  const ddrData = ddrQuery.data;

  const grade = legacyGrades.isLoading
    || identityGrades.isLoading
    || legacyGrades.error != null
    || identityGrades.error != null
    || (legacyGrades.data?.length ?? 0) > 0
    || (identityGrades.data?.history.length ?? 0) > 0;
  const ddr = ddrEnabled && (
    projectDdrTrackRecordSummary(ddrData, stablecoinId) != null
    || ddrQuery.error != null
    || ddrData?._meta?.degraded === true
    || (ddrData != null && ddrData.summary.byStablecoin == null)
  );

  useEffect(() => {
    onAvailabilityChange({ grade, ddr });
  }, [ddr, grade, onAvailabilityChange]);

  return null;
}

/**
 * Grade history, depeg history and the DDR record share one tabbed module:
 * three stacked cards cost ~1,400px for what readers scan one at a time.
 *
 * The shell itself is synchronous for pilots so the retained-ledger depeg
 * preview is in the initial HTML even while its panel is inactive; every other
 * profile keeps the lazy wrapper in `detail-lazy-sections.tsx`. Every live
 * module (and every availability query) stays behind the route's History
 * viewport gate and the active-tab gate; inactive panels keep their anchor id
 * and reveal on a hash jump.
 */
export function HistoryTabs({
  stablecoinId,
  isNavToken,
  historyActive,
  depegHistoryPreview = null,
  initialTab,
  ...depegProps
}: HistoryTabsProps) {
  const [selected, setSelected] = useState<HistoryTabKey | null>(null);
  const [availability, setAvailability] = useState<HistoryTabAvailability | null>(null);
  const [liveHistoryDisplayed, setLiveHistoryDisplayed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleAvailabilityChange = useCallback((next: HistoryTabAvailability) => {
    setAvailability((previous) =>
      previous && previous.grade === next.grade && previous.ddr === next.ddr ? previous : next,
    );
  }, []);

  const previousStablecoinId = useRef(stablecoinId);
  useEffect(() => {
    if (previousStablecoinId.current === stablecoinId) return;
    previousStablecoinId.current = stablecoinId;
    setAvailability(null);
    setLiveHistoryDisplayed(false);
  }, [stablecoinId]);

  const tabs: HistoryTab[] = [];
  if (availability == null || availability.grade) {
    tabs.push({
      key: "grade",
      label: "Grade",
      anchorId: "grade-history",
      content: <LiveSafetyScoreHistorySection stablecoinId={stablecoinId} />,
    });
  }
  if (!isNavToken) {
    tabs.push({
      key: "depeg",
      label: "Depeg",
      anchorId: "depeg-history",
      content: depegHistoryPreview ? (
        <PreviewedLiveDepegHistory
          stablecoinId={stablecoinId}
          {...depegProps}
          embeddedPreview
          onDisplayStateChange={setLiveHistoryDisplayed}
        />
      ) : (
        <LiveDepegHistory stablecoinId={stablecoinId} {...depegProps} />
      ),
    });
  }
  if (availability?.ddr) {
    tabs.push({
      key: "ddr",
      label: "DDR record",
      anchorId: "ddr-track-record",
      content: <LiveDdrTrackRecordSection stablecoinId={stablecoinId} />,
    });
  }
  const active = tabs.find((tab) => tab.key === selected)
    ?? tabs.find((tab) => tab.key === initialTab)
    ?? tabs[0];

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
    <div
      ref={rootRef}
      className="space-y-3"
      // The removed LazySection reserved 390px until mount; keep that reserve
      // while the live portion is still gated so the page does not jump.
      style={historyActive ? undefined : { minHeight: 390 }}
    >
      {historyActive ? (
        <HistoryTabAvailabilityProbe
          stablecoinId={stablecoinId}
          isNavToken={isNavToken}
          onAvailabilityChange={handleAvailabilityChange}
        />
      ) : null}
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
      {tabs.map((tab) => {
        const showLive = historyActive && tab.key === active.key;
        return (
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
            {tab.key === "depeg" && depegHistoryPreview ? (
              <div hidden={liveHistoryDisplayed}>{depegHistoryPreview}</div>
            ) : null}
            {showLive ? tab.content : null}
          </div>
        );
      })}
    </div>
  );
}
