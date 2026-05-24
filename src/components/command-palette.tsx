"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  Moon,
  Sun,
  FileText,
  Coins,
  Clock,
  Trash2,
  Search,
  Copy,
  BookOpen,
  Newspaper,
  KeyRound,
  X,
  GitCompare,
  Terminal,
  Network,
  Globe2,
  Layers,
  Activity,
  PlayCircle,
} from "lucide-react";
import { useLogos } from "@/hooks/use-logos";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { getCirculatingRaw } from "@shared/lib/supply";
import { formatCompactUsd } from "@shared/lib/format";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { deriveDeviationBps } from "@/lib/stablecoin-detail-derive";
import { DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  buildCommandPaletteResultDescriptors,
  buildPopularStablecoinDescriptors,
  groupCommandPaletteResults,
  type CommandPaletteActionIcon,
  type CommandPaletteActionId,
  type CommandPalettePegStatus,
  type CommandPaletteResultDescriptor,
  type CommandPaletteSection,
  type CommandPaletteStablecoinHealth,
  type CommandPaletteStablecoinLiveMetadata,
} from "@/components/command-palette-model";
import {
  buildCompareHrefFromCoinIds,
  parsePaletteInput,
} from "@/lib/command-palette-verbs";
import {
  buildVerbPreview,
  clampCommandPaletteSelectedIndex,
  executeParsedVerb,
} from "@/components/command-palette-actions";

// Empty-state "Popular" jump list size (ranked live by market cap).
const POPULAR_STABLECOIN_COUNT = 6;

const PEG_STATUS_DOT: Record<CommandPalettePegStatus, string> = {
  calm: "bg-emerald-500",
  watch: "bg-amber-500",
  alert: "bg-red-500",
};

const PEG_STATUS_LABEL: Record<CommandPalettePegStatus, string> = {
  calm: "At peg",
  watch: "Peg watch",
  alert: "Off peg",
};

function getStablecoinHealthLabel(health: CommandPaletteStablecoinHealth): string {
  if (health.kind === "nav") return "NAV-priced token";
  return PEG_STATUS_LABEL[health.status];
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  label: string;
  sublabel?: string;
  section: CommandPaletteSection;
  logoUrl?: string;
  imagePath?: string;
  imageSquare?: boolean;
  imageDarkInvert?: boolean;
  icon?: React.ReactNode;
  frozen?: boolean;
  /** Live USD market cap, shown right-aligned on stablecoin rows. */
  marketCap?: number;
  /** Live peg/NAV health state, shown on stablecoin rows. */
  stablecoinHealth?: CommandPaletteStablecoinHealth;
  /** Render the sublabel in the mono face (tickers, dates — data, not prose). */
  mono?: boolean;
  onSelect: () => void;
  keywords?: string[];
}

// ── Component ────────────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getActionIcon(icon: CommandPaletteActionIcon): React.ReactNode {
  switch (icon) {
    case "theme-light":
      return <Sun className="h-4 w-4" />;
    case "theme-dark":
      return <Moon className="h-4 w-4" />;
    case "copy":
      return <Copy className="h-4 w-4" />;
    case "digest":
      return <Newspaper className="h-4 w-4" />;
    case "methodology":
      return <BookOpen className="h-4 w-4" />;
    case "api-docs":
      return <KeyRound className="h-4 w-4" />;
    case "compare-watchlist":
      return <GitCompare className="h-4 w-4" />;
    case "verb-hint":
      return <Terminal className="h-4 w-4" />;
    case "run-command":
      return <PlayCircle className="h-4 w-4" />;
  }
}

function getKindIcon(kind: CommandPaletteResultDescriptor["kind"]): React.ReactNode {
  switch (kind) {
    case "chain":
      return <Network className="h-4 w-4" />;
    case "peg":
      return <Globe2 className="h-4 w-4" />;
    case "mechanism":
      return <Layers className="h-4 w-4" />;
    case "depeg-event":
      return <Activity className="h-4 w-4" />;
    case "verb-hint":
      return <Terminal className="h-4 w-4" />;
    case "verb-run":
      return <PlayCircle className="h-4 w-4" />;
    default:
      return null;
  }
}

function buildSearchResult(
  descriptor: CommandPaletteResultDescriptor,
  {
    logos,
    router,
    closePalette,
    addToHistory,
    toggleTheme,
    watchlistIds,
    setQuery,
  }: {
    logos: Record<string, string>;
    router: ReturnType<typeof useRouter>;
    closePalette: () => void;
    addToHistory: (
      id: string,
      type: "stablecoin" | "page",
      label: string,
      sublabel: string | undefined,
      href: string,
    ) => void;
    toggleTheme: () => void;
    watchlistIds: readonly string[];
    setQuery: (next: string) => void;
  },
): SearchResult {
  const selectAction = (actionId: CommandPaletteActionId) => {
    switch (actionId) {
      case "theme":
        toggleTheme();
        closePalette();
        return;
      case "copy-url":
        if (typeof window !== "undefined" && navigator.clipboard) {
          void navigator.clipboard.writeText(window.location.href);
        }
        closePalette();
        return;
      case "open-digest":
        router.push("/digest/");
        closePalette();
        return;
      case "open-methodology":
        router.push("/methodology/");
        closePalette();
        return;
      case "open-api-docs":
        router.push("/about/api/");
        closePalette();
        return;
      case "compare-watchlist": {
        if (watchlistIds.length < 2) return;
        router.push(buildCompareHrefFromCoinIds(watchlistIds));
        closePalette();
        return;
      }
    }
  };

  const PageIcon = descriptor.pageIcon;
  const onSelect = () => {
    // Verb hints prefill the input rather than navigating away.
    if (descriptor.kind === "verb-hint" && descriptor.prefill) {
      setQuery(descriptor.prefill);
      return;
    }
    if (descriptor.actionId) {
      selectAction(descriptor.actionId);
      return;
    }
    if (!descriptor.href) return;
    if (descriptor.external) {
      window.open(descriptor.href, "_blank", "noopener,noreferrer");
      closePalette();
      return;
    }
    if (descriptor.history) {
      addToHistory(
        descriptor.history.id,
        descriptor.history.type,
        descriptor.history.label,
        descriptor.history.sublabel,
        descriptor.history.href,
      );
    }
    router.push(descriptor.href);
    closePalette();
  };

  const kindIcon = getKindIcon(descriptor.kind);

  return {
    id: descriptor.id,
    label: descriptor.label,
    sublabel: descriptor.sublabel,
    section: descriptor.section,
    logoUrl: descriptor.logoId ? logos[descriptor.logoId] : undefined,
    imagePath: descriptor.imagePath,
    imageSquare: descriptor.imageSquare,
    imageDarkInvert: descriptor.imageDarkInvert,
    icon: descriptor.actionIcon
      ? getActionIcon(descriptor.actionIcon)
      : PageIcon
        ? <PageIcon className="h-4 w-4" />
        : kindIcon
          ? kindIcon
          : descriptor.kind === "recent" && !descriptor.logoId
            ? <FileText className="h-4 w-4" />
            : undefined,
    frozen: descriptor.frozen,
    marketCap:
      descriptor.kind === "stablecoin"
        ? descriptor.marketCapUsd
        : undefined,
    stablecoinHealth:
      descriptor.kind === "stablecoin"
        ? descriptor.stablecoinHealth
        : undefined,
    mono: descriptor.kind === "stablecoin" || descriptor.kind === "depeg-event",
    onSelect,
  };
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const router = useRouter();
  const { isDark, toggleTheme } = useThemeToggle();
  const { data: logos } = useLogos();
  const { data: stablecoinsData } = useStablecoins();
  const { history, addToHistory, clearHistory } = useCommandPaletteHistory();
  const { ids: watchlistIds, add: addToWatchlist, remove: removeFromWatchlist, clear: clearWatchlist, count: watchlistCount } = useWatchlist();

  // Live metadata powers both ranking and row facts. The list query is already
  // cached by data surfaces; the palette only mounts after first open.
  const peggedAssets = stablecoinsData?.peggedAssets;
  const stablecoinLiveMetadata = useMemo(() => {
    const map = new Map<string, CommandPaletteStablecoinLiveMetadata>();
    if (!peggedAssets) return map;
    const { rates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, stablecoinsData?.fxFallbackRates);
    for (const asset of peggedAssets) {
      const marketCapUsd = getCirculatingRaw(asset);
      const meta = TRACKED_META_BY_ID.get(asset.id);
      const peg = asset.pegType;
      let health: CommandPaletteStablecoinHealth | undefined;
      if (meta?.flags.navToken) {
        health = { kind: "nav" };
      } else if (peg && asset.price != null) {
        const reference = getPegReference(peg, rates, meta?.commodityOunces);
        const bps = Math.abs(deriveDeviationBps(asset.price, reference));
        const threshold = peg === "peggedUSD" ? DEPEG_THRESHOLD_BPS : DEPEG_THRESHOLD_BPS_NON_USD;
        health = { kind: "peg", status: bps >= threshold ? "alert" : bps >= threshold / 2 ? "watch" : "calm" };
      }
      if (marketCapUsd > 0 || health) {
        map.set(asset.id, {
          ...(marketCapUsd > 0 ? { marketCapUsd } : {}),
          ...(health ? { health } : {}),
        });
      }
    }
    return map;
  }, [peggedAssets, stablecoinsData?.fxFallbackRates]);
  const popularIds = useMemo(() => {
    if (!peggedAssets) return [];
    return [...peggedAssets]
      .filter((asset) => !asset.frozen)
      .sort((a, b) => {
        const aMarketCap = stablecoinLiveMetadata.get(a.id)?.marketCapUsd ?? 0;
        const bMarketCap = stablecoinLiveMetadata.get(b.id)?.marketCapUsd ?? 0;
        return bMarketCap - aMarketCap;
      })
      .slice(0, POPULAR_STABLECOIN_COUNT)
      .map((asset) => asset.id);
  }, [peggedAssets, stablecoinLiveMetadata]);

  const closePalette = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // ── Parse verb from the current input ──────────────────────────────────────

  const parsedVerb = useMemo(() => parsePaletteInput(query), [query]);

  /**
   * Execute the active verb. Returns true if the verb produced a side-effect
   * (navigation or watchlist mutation). Falsy values mean "no-op", leaving
   * the user in the palette to refine input.
   */
  const runVerb = useCallback((): boolean => {
    return executeParsedVerb(parsedVerb, {
      push: router.push,
      closePalette,
      addToWatchlist,
      removeFromWatchlist,
      clearWatchlist,
    });
  }, [parsedVerb, router, closePalette, addToWatchlist, removeFromWatchlist, clearWatchlist]);

  /** Human-readable preview of the verb result. */
  const verbPreview = useMemo<
    { label: string; sublabel: string; runnable: boolean } | null
  >(() => buildVerbPreview(parsedVerb), [parsedVerb]);

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

  const results = useMemo((): SearchResult[] => {
    const ctx = {
      logos,
      router,
      closePalette,
      addToHistory,
      toggleTheme,
      watchlistIds,
      setQuery,
    };

    const built = buildCommandPaletteResultDescriptors({
      query,
      history,
      isDark,
      watchlistCount,
      stablecoinLiveMetadata,
    }).map((descriptor) => buildSearchResult(descriptor, ctx));

    // Empty state: surface a live, market-cap-ranked "Popular" jump list so the
    // prime real estate teaches the interface instead of restating the prompt.
    const popular = query.trim()
      ? []
      : buildPopularStablecoinDescriptors(popularIds, stablecoinLiveMetadata).map((descriptor) =>
          buildSearchResult(descriptor, ctx),
        );

    // Prepend a "Run command" row when the input parses to a verb. Clicking
    // it (or pressing Enter while it's selected) runs the side-effect.
    if (verbPreview) {
      const verbRow: SearchResult = {
        id: "verb-run",
        label: verbPreview.label,
        sublabel: verbPreview.sublabel,
        section: "Run command",
        icon: <PlayCircle className="h-4 w-4" />,
        onSelect: () => {
          if (verbPreview.runnable) runVerb();
        },
      };
      return [verbRow, ...popular, ...built];
    }
    return [...popular, ...built];
  }, [
    query,
    logos,
    isDark,
    toggleTheme,
    router,
    closePalette,
    history,
    addToHistory,
    watchlistCount,
    watchlistIds,
    verbPreview,
    runVerb,
    stablecoinLiveMetadata,
    popularIds,
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
        className="pharos-palette-spring-in inset-x-0 top-0 translate-x-0 translate-y-0 flex h-[100dvh] max-w-none flex-col rounded-none border-0 sm:inset-x-auto sm:top-[12vh] sm:left-[50%] sm:h-auto sm:max-h-none sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-0 sm:rounded-xl sm:border sm:border-border/75 z-[100] overflow-hidden bg-card p-0 shadow-[0_28px_50px_oklch(0_0_0_/0.35)]"
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
                    <span className="ml-2 font-mono text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                      {group.items.length}
                    </span>
                  )}
                </span>
                {group.section === "Recent" && history.length > 0 && (
                  <button
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
                  <button
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
                      <span className="shrink-0 pl-3 text-right font-mono text-xs text-muted-foreground">
                        {formatCompactUsd(item.marketCap)}
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
