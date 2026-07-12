"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { FileText, Coins, Clock, Trash2, Search, X } from "lucide-react";
import { useLogos } from "@/hooks/use-logos";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { useWatchlist } from "@/hooks/use-watchlist";
import { STABLECOINS_QUERY_KEY } from "@shared/lib/query-keys";
import type { StablecoinListResponse } from "@shared/types";
import { groupCommandPaletteResults } from "@/components/command-palette-model";
import { clampCommandPaletteSelectedIndex } from "@/components/command-palette-actions";
import {
  PEG_STATUS_DOT,
  buildPopularStablecoinIds,
  buildStablecoinLiveMetadata,
  formatCommandPaletteMarketCap,
  getStablecoinHealthLabel,
} from "@/components/command-palette/live-metadata";
import { buildCommandPaletteSearchResults } from "@/components/command-palette/results";
import { useCommandPaletteVerbActions } from "@/components/command-palette/use-verb-actions";

// ── Component ────────────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isDark, toggleTheme } = useThemeToggle();
  const { data: logos } = useLogos();
  const stablecoinsData = queryClient.getQueryData<{
    data: StablecoinListResponse;
    meta: unknown;
  }>(STABLECOINS_QUERY_KEY)?.data;
  const { history, addToHistory, clearHistory } = useCommandPaletteHistory();
  const { ids: watchlistIds, add: addToWatchlist, remove: removeFromWatchlist, clear: clearWatchlist, count: watchlistCount } = useWatchlist();

  // Live metadata powers both ranking and row facts when a validated data
  // surface has already populated the canonical list cache.
  const stablecoinLiveMetadata = useMemo(
    () => buildStablecoinLiveMetadata(stablecoinsData),
    [stablecoinsData],
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

  // ── Restore focus on close and auto-focus input when open ────────────────────

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (!open) {
      const focusTarget = wasOpen ? lastFocusedElementRef.current : null;
      if (focusTarget) {
        focusTarget.focus();
      }
      lastFocusedElementRef.current = null;
      return;
    }

    if (!wasOpen) {
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

  // ── Build results ──────────────────────────────────────────────────────

  const results = useMemo(() => {
    return buildCommandPaletteSearchResults({
      query,
      history,
      isDark,
      watchlistCount,
      watchlistIds,
      stablecoinLiveMetadata,
      popularIds,
      logos,
      router,
      closePalette,
      addToHistory,
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
    stablecoinLiveMetadata,
    popularIds,
    logos,
    router,
    closePalette,
    addToHistory,
    toggleTheme,
    verbPreview,
    runVerb,
  ]);

  // ── Grouped results for rendering ──────────────────────────────────────

  const groupedResults = useMemo(() => {
    return groupCommandPaletteResults(results);
  }, [results]);

  // ── Flat list for keyboard navigation indexing ─────────────────────────

  const flatResults = useMemo(
    () => groupedResults.flatMap((g) => g.items),
    [groupedResults]
  );

  // ── Clamp selected index when results change ──────────────────────────

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((current) => clampCommandPaletteSelectedIndex(current, flatResults.length));
  }, [flatResults.length]);

  // ── Scroll selected item into view ─────────────────────────────────────

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector(
      '[data-selected="true"]'
    ) as HTMLElement | null;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // ── Keyboard navigation inside palette ─────────────────────────────────

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatResults.length === 0) return;
      setSelectedIndex((prev) =>
        prev < flatResults.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatResults.length === 0) return;
      setSelectedIndex((prev) =>
        prev > 0 ? prev - 1 : flatResults.length - 1
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatResults[selectedIndex]) {
        flatResults[selectedIndex].onSelect();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  }

  // ── Don't render until open ────────────────────────────────────────────

  if (!open) return null;

  // ── Track flat index across grouped rendering ──────────────────────────

  let flatIndex = 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="pharos-palette-spring-in inset-x-0 top-0 translate-x-0 translate-y-0 flex h-[100dvh] max-w-none flex-col rounded-none border-0 sm:inset-x-auto sm:top-[12vh] sm:left-[50%] sm:h-auto sm:max-h-none sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-0 sm:rounded-xl sm:border sm:border-border/75 z-[100] overflow-hidden bg-card p-0 shadow-[var(--elevation-raised)]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search stablecoins, pages, chains, recent depegs, and command verbs.
        </DialogDescription>
        {/* Search input */}
        <div className="relative shrink-0">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or type a verb (compare, screen, pin)…"
            className="h-14 w-full border-b border-border/70 bg-transparent pl-10 pr-14 text-base text-foreground placeholder:text-muted-foreground focus:outline-none sm:h-12 sm:pr-4"
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
            className="pharos-focus-ring absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground sm:hidden"
            aria-label="Close command palette"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:max-h-[60vh] sm:flex-initial sm:pb-2"
        >
          {query.trim() && flatResults.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">Nothing found for &ldquo;{query}&rdquo;. Try a ticker or chain name.</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Try searching by symbol (e.g., USDT) or browse by category
              </p>
            </div>
          )}

          {groupedResults.map((group) => (
            <div key={group.section}>
              <div className="flex items-center justify-between px-4 py-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.section}
                  {group.section === "Stablecoins" && (
                    <span className="ml-2 pharos-numeric text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                      {group.items.length}
                    </span>
                  )}
                </span>
                {group.section === "Recent" && history.length > 0 && (
                  <button type="button"
                    onClick={clearHistory}
                    className="pharos-focus-ring -mr-2 flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground sm:mr-0 sm:min-h-0 sm:px-0 sm:hover:bg-transparent"
                    title="Clear recent items"
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear
                  </button>
                )}
              </div>
              {group.items.map((item) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <button type="button"
                    key={item.id}
                    id={`cp-item-${item.id}`}
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected}
                    className={`pharos-focus-ring mx-2 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-2.5 text-left text-sm text-foreground transition-all duration-150 sm:min-h-0 ${
                      isSelected
                        ? "border-ring/55 bg-ring/10 shadow-sm"
                        : "border-transparent hover:border-border/55 hover:bg-muted/45"
                    }`}
                    style={{ width: "calc(100% - 16px)" }}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                  >
                    {/* Icon or logo */}
                    {item.logoUrl ? (
                      <Image
                        src={item.logoUrl}
                        alt=""
                        width={20}
                        height={20}
                        className="w-5 h-5 rounded-full shrink-0"
                        unoptimized
                      />
                    ) : item.imagePath ? (
                      <Image
                        src={item.imagePath}
                        alt=""
                        width={20}
                        height={20}
                        className={`w-5 h-5 ${item.imageSquare ? "rounded" : "rounded-full"} shrink-0 ${item.imageDarkInvert ? "dark:invert" : ""}`}
                        unoptimized
                      />
                    ) : item.icon ? (
                      <span className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                        {item.icon}
                      </span>
                    ) : item.section === "Recent" ? (
                      <span className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                        <Clock className="h-4 w-4" />
                      </span>
                    ) : item.section === "Stablecoins" ? (
                      <span className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                        <Coins className="h-4 w-4" />
                      </span>
                    ) : (
                      <span className="w-5 h-5 flex items-center justify-center shrink-0 text-muted-foreground">
                        <FileText className="h-4 w-4" />
                      </span>
                    )}

                    <div className="flex-1 min-w-0">
                      <span className="truncate block">
                        {item.label}
                        {item.frozen ? (
                          <span className="ml-2 rounded border border-zinc-500/30 px-1 text-[9px] uppercase tracking-wide text-zinc-500">
                            Frozen
                          </span>
                        ) : null}
                      </span>
                      {item.sublabel && (
                        <span className={`text-muted-foreground text-xs truncate block ${item.mono ? "font-mono" : ""}`}>
                          {item.sublabel}
                        </span>
                      )}
                    </div>
                    {typeof item.marketCap === "number" && item.marketCap > 0 ? (
                      <span className="shrink-0 pl-3 text-right pharos-numeric text-xs text-muted-foreground">
                        {formatCommandPaletteMarketCap(item.marketCap)}
                      </span>
                    ) : null}
                    {item.stablecoinHealth?.kind === "peg" ? (
                      <span className="ml-2 inline-flex shrink-0 items-center" title={getStablecoinHealthLabel(item.stablecoinHealth)}>
                        <span
                          className={`size-1.5 rounded-full ${PEG_STATUS_DOT[item.stablecoinHealth.status]}`}
                          aria-hidden="true"
                        />
                        <span className="sr-only">{getStablecoinHealthLabel(item.stablecoinHealth)}</span>
                      </span>
                    ) : item.stablecoinHealth?.kind === "nav" ? (
                      <span
                        className="ml-2 shrink-0 rounded border border-sky-500/30 px-1 py-0.5 font-mono text-[10px] leading-none text-sky-500"
                        title={getStablecoinHealthLabel(item.stablecoinHealth)}
                      >
                        NAV<span className="sr-only">-priced token</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 bg-muted/15 px-4 py-2 text-xs text-muted-foreground sm:hidden">
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
            <kbd className="rounded border border-border/70 bg-background/55 px-1 py-0.5 font-mono">&#8593;&#8595;</kbd> navigate
          </span>
          <span>
            <kbd className="rounded border border-border/70 bg-background/55 px-1 py-0.5 font-mono">&#9166;</kbd> select
          </span>
          <span>
            <kbd className="rounded border border-border/70 bg-background/55 px-1 py-0.5 font-mono">esc</kbd> close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
