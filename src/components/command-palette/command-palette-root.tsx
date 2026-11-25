"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image";
import { FileText, Coins, Clock, Trash2, Search, X } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { logosById } from "@/lib/logos";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";
import { useReportCardsV9, useReportCardsV9Table, useSafetyGrades } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useCoinStates } from "@/hooks/use-coin-states";
import { CoinStateChip } from "@/components/coin-state-chip";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import {
  CLIENT_ACTIVE_TOKENIZED_FUND_IDS,
  isClientTokenizedFundId,
} from "@shared/lib/stablecoins/aggregate-client-registry";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import { groupCommandPaletteResults } from "@/components/command-palette/command-palette-model";
import { clampCommandPaletteSelectedIndex } from "@/components/command-palette/command-palette-actions";
import {
  buildPopularStablecoinIds,
  buildStablecoinLiveMetadata,
  formatCommandPaletteMarketCap,
} from "@/components/command-palette/live-metadata";
import { buildCommandPaletteSearchResults } from "@/components/command-palette/results";
import { useCommandPaletteVerbActions } from "@/components/command-palette/use-verb-actions";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { formatDataHealthTimestamp } from "@/lib/data-health";
import { dismissChromeOverlays, openKeyboardShortcuts, subscribeChromeDismiss } from "@/lib/chrome-popover";

/**
 * Result-row logo. Some coin assets are wide wordmarks that crop to an empty
 * or stray-colored disc at 20px, and a failed load leaves a blank slot; both
 * fall back to a monogram of the row label.
 */
function PaletteLogo({ src, label }: { src: string; label: string }) {
  const [unusable, setUnusable] = useState(false);
  if (unusable) {
    return (
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-3xs font-bold text-muted-foreground"
        aria-hidden="true"
      >
        {label.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <Image
      src={resolveCompactLogoSrc(src, 20)!}
      alt=""
      width={20}
      height={20}
      className="w-5 h-5 rounded-full shrink-0"
      unoptimized
      onError={() => setUnusable(true)}
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalHeight > 0 && img.naturalWidth / img.naturalHeight > 1.5) setUnusable(true);
      }}
    />
  );
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EMPTY_STATE_CHIPS: { label: string; href: string }[] = [
  { label: "Stablecoin Directory", href: "/stablecoins/" },
  { label: "Chains", href: "/chains/" },
  { label: "Case Studies", href: "/learn/case-studies/" },
  { label: "Screener", href: "/screener/" },
];

const TOP_VERB_CHIPS: ReadonlyArray<{ label: string; prefill: string; title: string }> = [
  { label: "compare", prefill: "compare ", title: "Compare stablecoins side by side (e.g. compare USDC USDT)" },
  { label: "portfolio", prefill: "portfolio ", title: "Open stablecoins in Portfolio (e.g. portfolio USDC USDS)" },
  { label: "reserves", prefill: "reserves ", title: "Jump to a coin's reserves section (e.g. reserves USDC)" },
  { label: "depeg", prefill: "depeg ", title: "Jump to a coin's depeg history (e.g. depeg USDC)" },
];

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [rawSelectedIndex, setSelectedIndex] = useState(0);
  const [selectionQuery, setSelectionQuery] = useState(query);
  if (selectionQuery !== query) {
    setSelectionQuery(query);
    setSelectedIndex(0);
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const navigatingCloseRef = useRef(false);
  const router = useRouter();
  const pathname = usePathname();
  const { isDark, toggleTheme } = useThemeToggle();
  const logos = logosById;
  const { data: stablecoinsData, meta, dataUpdatedAt, error } = useStablecoins({ enabled: open });
  // Cache-only grade reads: reuse any already-populated safety-score query
  // without issuing unsolicited network requests on static/editorial routes.
  const { data: reportCardsTableData } = useReportCardsV9Table({ enabled: false });
  const { data: reportCardsFullData } = useReportCardsV9({ enabled: false });
  const { data: safetyGradesData } = useSafetyGrades({ enabled: false });
  const { history, addToHistory, clearHistory } = useCommandPaletteHistory();
  const { ids: watchlistIds, add: addToWatchlist, remove: removeFromWatchlist, clear: clearWatchlist, count: watchlistCount } = useWatchlist();
  // The one exceptional-state ladder; its live reads run only while the palette is open.
  const { byId: coinStates } = useCoinStates({ enabled: open });

  const cachedSafetyGrades = useMemo(() => {
    const map = new Map<string, ReportCardGrade>();
    if (safetyGradesData?.grades) {
      for (const row of safetyGradesData.grades) {
        if (row.grade && !isClientTokenizedFundId(row.id)) map.set(row.id, row.grade);
      }
    }
    if (reportCardsFullData?.cards) {
      for (const card of reportCardsFullData.cards) {
        if (card.grade && !isClientTokenizedFundId(card.id)) map.set(card.id, card.grade);
      }
    }
    if (reportCardsTableData?.cards) {
      for (const card of reportCardsTableData.cards) {
        if (card.grade && !isClientTokenizedFundId(card.id)) map.set(card.id, card.grade);
      }
    }
    return map;
  }, [reportCardsTableData, reportCardsFullData, safetyGradesData]);
  const freshnessNow = useFreshnessBoundary([{
    ...DATA_HEALTH_PRESETS.stablecoins,
    dataUpdatedAt,
    hasData: stablecoinsData != null,
    error,
    meta: meta ?? { updatedAt: null, ageSeconds: null, status: "unknown", reason: "producer-timestamp-unavailable" },
  }], open);

  // Live metadata powers both ranking and row facts as the canonical observer
  // resolves; static registry search remains available while it is pending.
  const stablecoinLiveMetadata = useMemo(
    () => buildStablecoinLiveMetadata(stablecoinsData, { meta, dataUpdatedAt, error }, freshnessNow ?? dataUpdatedAt),
    [stablecoinsData, meta, dataUpdatedAt, error, freshnessNow],
  );
  const popularIds = useMemo(
    () => buildPopularStablecoinIds(stablecoinsData, stablecoinLiveMetadata),
    [stablecoinsData, stablecoinLiveMetadata],
  );

  const closePalette = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const { verbPreview, runVerb } = useCommandPaletteVerbActions({
    query,
    router,
    closePalette,
    addToWatchlist,
    removeFromWatchlist,
    clearWatchlist,
  });

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (!open) {
      const shouldRestoreFocus = wasOpen && !navigatingCloseRef.current;
      navigatingCloseRef.current = false;
      const focusTarget = shouldRestoreFocus ? lastFocusedElementRef.current : null;
      if (focusTarget?.isConnected) {
        focusTarget.focus();
      }
      lastFocusedElementRef.current = null;
      return;
    }

    if (!wasOpen) {
      navigatingCloseRef.current = false;
      dismissChromeOverlays("command-palette");
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        lastFocusedElementRef.current = activeElement;
      }
      setQuery("");
      setSelectedIndex(0);
    }

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return subscribeChromeDismiss("command-palette", () => {
      navigatingCloseRef.current = true;
      closePalette();
    });
  }, [open, closePalette]);

  const results = useMemo(() => {
    return buildCommandPaletteSearchResults({
      query,
      history,
      isDark,
      watchlistCount,
      watchlistIds,
      pathname,
      stablecoinLiveMetadata,
      popularIds,
      logos,
      router,
      closePalette,
      addToHistory,
      addToWatchlist,
      removeFromWatchlist,
      toggleTheme,
      setQuery,
      verbPreview,
      runVerb,
    });
  }, [
    query,
    history,
    isDark,
    watchlistCount,
    watchlistIds,
    pathname,
    stablecoinLiveMetadata,
    popularIds,
    logos,
    router,
    closePalette,
    addToHistory,
    addToWatchlist,
    removeFromWatchlist,
    toggleTheme,
    verbPreview,
    runVerb,
  ]);

  const groupedResults = useMemo(() => {
    return groupCommandPaletteResults(results);
  }, [results]);

  const flatResults = useMemo(
    () => groupedResults.flatMap((g) => g.items),
    [groupedResults]
  );

  const selectedIndex = clampCommandPaletteSelectedIndex(rawSelectedIndex, flatResults.length);

  // Single selection path for keyboard Enter and pointer clicks: fires the
  // bounded `palette_selected` payload, then dispatches. Raw query text is
  // never sent — only its length and the item's kind/section/rank.
  const selectResult = (index: number) => {
    const item = flatResults[index];
    if (!item) return;
    if (item.navigates) {
      navigatingCloseRef.current = true;
    }
    trackEvent("palette_selected", {
      query_length: query.trim().length,
      selected_kind: item.kind ?? "unknown",
      selected_section: item.section,
      selected_rank: index,
    });
    item.onSelect();
  };

  // Debounced zero-results signal, mirroring `trackSearch`: fires once the
  // user has stopped typing on an empty result set; cancelled on close, on
  // new results, and on unmount.
  const zeroResultsTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !query.trim() || flatResults.length > 0) {
      if (zeroResultsTimerRef.current != null) {
        window.clearTimeout(zeroResultsTimerRef.current);
        zeroResultsTimerRef.current = null;
      }
      return;
    }
    const queryLength = query.trim().length;
    zeroResultsTimerRef.current = window.setTimeout(() => {
      zeroResultsTimerRef.current = null;
      trackEvent("palette_zero_results", { query_length: queryLength });
    }, 1000);
    return () => {
      if (zeroResultsTimerRef.current != null) {
        window.clearTimeout(zeroResultsTimerRef.current);
        zeroResultsTimerRef.current = null;
      }
    };
  }, [open, query, flatResults.length]);

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector(
      '[data-selected="true"]'
    ) as HTMLElement | null;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    const activeEl = document.activeElement;
    const isNonOptionButtonFocused =
      (activeEl instanceof HTMLButtonElement && activeEl.getAttribute("role") !== "option")
      || (e.target instanceof HTMLButtonElement && e.target.getAttribute("role") !== "option");

    if (e.key === "ArrowDown") {
      if (isNonOptionButtonFocused) return;
      e.preventDefault();
      if (flatResults.length === 0) return;
      setSelectedIndex(selectedIndex < flatResults.length - 1 ? selectedIndex + 1 : 0);
    } else if (e.key === "ArrowUp") {
      if (isNonOptionButtonFocused) return;
      e.preventDefault();
      if (flatResults.length === 0) return;
      setSelectedIndex(selectedIndex > 0 ? selectedIndex - 1 : flatResults.length - 1);
    } else if (e.key === "Enter") {
      if (isNonOptionButtonFocused) return;
      if (flatResults[selectedIndex]) {
        e.preventDefault();
        selectResult(selectedIndex);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  }

  // ── Don't render until open ────────────────────────────────────────────

  if (!open) return null;

  const hasRecentGroup = history.length > 0 && groupedResults.some((group) => group.section === "Recent");
  const recentIsFirst = hasRecentGroup && groupedResults[0]?.section === "Recent";
  let flatIndex = 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="pharos-palette-spring-in inset-x-0 top-0 translate-x-0 translate-y-0 flex h-[100dvh] max-w-none flex-col gap-0 rounded-none border-0 sm:inset-x-auto sm:top-[12vh] sm:left-[50%] sm:h-auto sm:max-h-none sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-0 sm:rounded-xl sm:border sm:border-border/75 z-modal overflow-hidden bg-card p-0 shadow-[shadow:var(--elevation-raised)]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onCloseAutoFocus={(event) => {
          if (navigatingCloseRef.current) event.preventDefault();
        }}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search stablecoins, pages, chains, recent depegs, and command verbs.
        </DialogDescription>
        <div className="relative shrink-0">
          <Search aria-hidden="true" className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or type a verb (compare, portfolio, reserves, screen)..."
            className="h-14 w-full border-b border-border/70 bg-transparent pl-10 pr-14 text-base text-foreground placeholder:text-muted-foreground focus:outline-none sm:h-12 lg:pr-4"
            aria-label="Search"
            role="combobox"
            aria-expanded={flatResults.length > 0}
            aria-controls="command-palette-results"
            aria-activedescendant={
              flatResults[selectedIndex]
                ? `cp-item-${flatResults[selectedIndex].id}`
                : undefined
            }
          />
          <button
            type="button"
            onClick={closePalette}
            className="pharos-focus-ring absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground lg:hidden"
            aria-label="Close command palette"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <div
          role="group"
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/50 bg-muted/15 px-4 py-1.5"
          aria-label="Quick command verbs"
        >
          <span className="pharos-label mr-1 text-muted-foreground/80">Commands</span>
          {TOP_VERB_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              title={chip.title}
              onClick={() => {
                setQuery(chip.prefill);
                inputRef.current?.focus();
              }}
              className="pharos-focus-ring inline-flex min-h-11 lg:min-h-7 items-center rounded-full border border-border/60 bg-background/80 px-2.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground"
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:max-h-[60vh] sm:flex-initial sm:pb-2"
        >
          {query.trim() && flatResults.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">Nothing found for &ldquo;{query}&rdquo;. Try a ticker, chain name, or one of these:</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {EMPTY_STATE_CHIPS.map((chip) => (
                  <button
                    key={chip.href}
                    type="button"
                    onClick={() => {
                      navigatingCloseRef.current = true;
                      router.push(chip.href);
                      closePalette();
                    }}
                    className="pharos-focus-ring min-h-11 rounded-full border border-border/70 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-border hover:bg-muted/45 lg:min-h-0"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {recentIsFirst && (
            <div className="flex items-center justify-between px-4 py-1.5">
              <span id="cp-section-recent" className="pharos-label">
                Recent
              </span>
              <button
                type="button"
                onClick={clearHistory}
                className="pharos-focus-ring -mr-2 flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground lg:mr-0 lg:min-h-0 lg:px-0 lg:hover:bg-transparent"
                title="Clear recent items"
              >
                <Trash2 aria-hidden="true" className="h-3 w-3" />
                Clear
              </button>
            </div>
          )}

          <div
            id="command-palette-results"
            role="listbox"
            aria-label="Search results"
          >
            {groupedResults.map((group) => {
              const sectionId = `cp-section-${group.section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
              const hideInlineHeader = recentIsFirst && group.section === "Recent";
              return (
                <div key={group.section} role="group" aria-labelledby={sectionId}>
                  {!hideInlineHeader && (
                    <div role="presentation" className="flex items-center justify-between px-4 py-1.5">
                      <span id={sectionId} className="pharos-label">
                        {group.section}
                        {group.section === "Stablecoins" && (
                          <span className="ml-2 pharos-numeric text-3xs font-normal text-muted-foreground/70">
                            {group.items.length}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {group.items.map((item) => {
                    const currentIndex = flatIndex++;
                    const isSelected = currentIndex === selectedIndex;
                    const coinState = item.coinId ? coinStates.get(item.coinId)?.[0] : undefined;
                    const isTokenizedFund = item.coinId ? CLIENT_ACTIVE_TOKENIZED_FUND_IDS.has(item.coinId) : false;
                    const safetyGrade = item.coinId ? cachedSafetyGrades.get(item.coinId) : undefined;

                    return (
                      <button type="button"
                        key={item.id}
                        id={`cp-item-${item.id}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={isSelected}
                        data-selected={isSelected}
                        className={`pharos-focus-ring mx-2 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-2.5 text-left text-sm text-foreground transition-all duration-150 lg:min-h-0 ${
                          isSelected
                            ? "border-ring/55 bg-ring/10 shadow-sm"
                            : "border-transparent hover:border-border/55 hover:bg-muted/45"
                        }`}
                        style={{ width: "calc(100% - 16px)" }}
                        onClick={() => selectResult(currentIndex)}
                        onMouseEnter={() => setSelectedIndex(currentIndex)}
                      >
                        {item.logoUrl ? (
                          <PaletteLogo src={item.logoUrl} label={item.label} />
                        ) : item.imagePath ? (
                          <Image
                            src={resolveCompactLogoSrc(item.imagePath, 20)!}
                            alt=""
                            width={20}
                            height={20}
                            className={`w-5 h-5 ${item.imageSquare ? "rounded-sm" : "rounded-full"} shrink-0 ${item.imageDarkInvert ? "dark:invert" : ""}`}
                            unoptimized
                          />
                        ) : item.icon ? (
                          <span aria-hidden="true" className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                            {item.icon}
                          </span>
                        ) : item.section === "Recent" ? (
                          <span aria-hidden="true" className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                            <Clock aria-hidden="true" className="h-4 w-4" />
                          </span>
                        ) : item.section === "Stablecoins" ? (
                          <span aria-hidden="true" className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                            <Coins aria-hidden="true" className="h-4 w-4" />
                          </span>
                        ) : (
                          <span aria-hidden="true" className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                            <FileText aria-hidden="true" className="h-4 w-4" />
                          </span>
                        )}

                        <div className="flex-1 min-w-0">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{item.label}</span>
                            {coinState ? <CoinStateChip state={coinState} className="shrink-0" /> : null}
                          </span>
                          {item.sublabel && (
                            <span className={`text-muted-foreground text-xs truncate block ${item.mono ? "font-mono" : ""}`}>
                              {item.sublabel}
                            </span>
                          )}
                        </div>
                        {isTokenizedFund ? (
                          <span
                            className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-3xs font-medium leading-tight text-muted-foreground"
                            title="Tokenized fund — not graded on Safety Score"
                          >
                            Not graded
                          </span>
                        ) : safetyGrade ? (
                          <SafetyGradeBadge
                            grade={safetyGrade}
                            size="xs"
                            className="shrink-0 px-1.5 py-0 font-mono text-3xs leading-tight"
                          />
                        ) : null}
                        {typeof item.marketCap === "number" ? (
                          <span className="shrink-0 pl-3 text-right pharos-numeric text-xs text-muted-foreground">
                            {formatCommandPaletteMarketCap(item.marketCap)}
                            {item.marketCapAsOf != null ? (
                              <span className="block text-3xs">
                                As of {formatDataHealthTimestamp(item.marketCapAsOf * 1000, "en-US", "UTC")}
                              </span>
                            ) : null}
                          </span>
                        ) : item.section === "Stablecoins" ? (
                          <span className="shrink-0 pl-3 text-right pharos-numeric text-xs text-muted-foreground" title="Supply unavailable">—</span>
                        ) : null}
                        {item.stablecoinHealth?.kind === "nav" ? (
                          <span
                            className="ml-2 shrink-0 rounded-sm border border-state-info px-1 py-0.5 font-mono text-3xs leading-none text-state-info"
                            title="NAV-priced token"
                          >
                            NAV<span className="sr-only">-priced token</span>
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 bg-muted/15 px-4 py-2 text-xs text-muted-foreground sm:hidden">
          {hasRecentGroup && !recentIsFirst && (
            <button
              type="button"
              onClick={clearHistory}
              className="pharos-focus-ring mr-auto inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground"
              title="Clear recent items"
            >
              <Trash2 aria-hidden="true" className="h-3 w-3" />
              Clear recent
            </button>
          )}
          <button
            type="button"
            onClick={closePalette}
            className="pharos-focus-ring min-h-11 rounded-md px-3 text-foreground transition-colors hover:bg-muted/45"
          >
            Close
          </button>
        </div>
        <div className="hidden shrink-0 items-center gap-4 border-t border-border/70 bg-muted/15 px-4 py-2 text-xs text-muted-foreground sm:flex">
          <span>
            <kbd className="rounded-sm border border-border/70 bg-background/55 px-1 py-0.5 font-mono">&#8593;&#8595;</kbd> navigate
          </span>
          <span>
            <kbd className="rounded-sm border border-border/70 bg-background/55 px-1 py-0.5 font-mono">&#9166;</kbd> select
          </span>
          <span>
            <kbd className="rounded-sm border border-border/70 bg-background/55 px-1 py-0.5 font-mono">esc</kbd> close
          </span>
          {hasRecentGroup && !recentIsFirst && (
            <button
              type="button"
              onClick={clearHistory}
              className="pharos-focus-ring inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground lg:min-h-0 lg:px-1.5 lg:py-0.5"
              title="Clear recent items"
            >
              <Trash2 aria-hidden="true" className="h-3 w-3" />
              Clear recent
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              navigatingCloseRef.current = true;
              closePalette();
              openKeyboardShortcuts();
            }}
            className="ml-auto pharos-focus-ring inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-sm px-2.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground lg:min-h-0 lg:px-1.5 lg:py-0.5"
          >
            Keyboard shortcuts
            <kbd className="rounded-sm border border-border/70 bg-background/55 px-1 py-0.5 font-mono">?</kbd>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
