"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Moon, Sun, FileText, Coins, Clock, Trash2, Search, Copy, BookOpen, Newspaper, KeyRound } from "lucide-react";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { buildStablecoinUrl } from "@/lib/urls";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useCommandPaletteHistory } from "@/hooks/use-command-palette-history";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/command-palette";
import { useThemeToggle } from "@/hooks/use-theme-toggle";
import {
  COMMAND_PALETTE_PAGES,
  buildCommandPaletteActionDefinitions,
  fuzzyMatch,
  groupCommandPaletteResults,
  type CommandPaletteActionIcon,
  type CommandPaletteActionId,
} from "@/components/command-palette-model";

// ── Ranking helper ───────────────────────────────────────────────────────────

/**
 * Pure ranking helper: sorts items by score descending and demotes entries
 * whose status is "frozen" on tied scores so live (non-frozen) results appear
 * first when relevance is otherwise equal.
 */
export function rankCommandPaletteResults<T extends { score: number; status?: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aFrozen = a.status === "frozen" ? 1 : 0;
    const bFrozen = b.status === "frozen" ? 1 : 0;
    return aFrozen - bFrozen;
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  label: string;
  sublabel?: string;
  section: "Recent" | "Stablecoins" | "Pages" | "Actions";
  logoUrl?: string;
  icon?: React.ReactNode;
  frozen?: boolean;
  onSelect: () => void;
  keywords?: string[];
}

// ── Component ────────────────────────────────────────────────────────────────

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
  }
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const { isDark, toggleTheme } = useThemeToggle();
  const { data: logos } = useLogos();
  const { history, addToHistory, clearHistory } = useCommandPaletteHistory();

  // ── Open/close handlers ──────────────────────────────────────────────────

  const openPalette = useCallback(() => {
    if (typeof document !== "undefined") {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        lastFocusedElementRef.current = activeElement;
      }
    }
    setOpen(true);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  // ── Global keyboard shortcut (Ctrl/Cmd+K) ─────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) {
          closePalette();
        } else {
          openPalette();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, openPalette, closePalette]);

  // ── Custom event listener (for sidebar/header search icons) ────────────

  useEffect(() => {
    const handler = () => openPalette();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handler);
  }, [openPalette]);

  // ── Restore focus on close and auto-focus input when open ────────────────────

  useEffect(() => {
    if (!open) {
      const focusTarget = lastFocusedElementRef.current;
      if (focusTarget) {
        focusTarget.focus();
      }
      lastFocusedElementRef.current = null;
      return;
    }

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [open]);

  // ── Build results ──────────────────────────────────────────────────────

  const results = useMemo((): SearchResult[] => {
    const q = query.trim();
    const items: SearchResult[] = [];

    // Recent items (only when no query)
    if (!q && history.length > 0) {
      for (const item of history) {
        items.push({
          id: `recent-${item.id}`,
          label: item.label,
          sublabel: item.sublabel,
          section: "Recent",
          logoUrl: item.type === "stablecoin" ? logos[item.id] : undefined,
          icon: item.type === "page" ? <FileText className="h-4 w-4" /> : undefined,
          onSelect: () => {
            router.push(item.href);
            closePalette();
          },
        });
      }
    }

    // Stablecoins
    if (q) {
      const matched: Array<{ coin: typeof TRACKED_STABLECOINS[number]; score: number; status: string }> = [];
      for (const coin of TRACKED_STABLECOINS) {
        const symbolMatch = fuzzyMatch(q, coin.symbol);
        const nameMatch = fuzzyMatch(q, coin.name);
        const idMatch = fuzzyMatch(q, coin.id);
        if (!symbolMatch && !nameMatch && !idMatch) continue;
        const score = (symbolMatch ? 3 : 0) + (nameMatch ? 2 : 0) + (idMatch ? 1 : 0);
        matched.push({ coin, score, status: coin.status ?? "active" });
      }
      const ranked = rankCommandPaletteResults(matched);
      for (const { coin } of ranked) {
        const logoUrl = logos[coin.id];
        const href = buildStablecoinUrl(coin.id);
        const sublabel =
          coin.status === "pre-launch"
            ? `${coin.symbol} · Pre-launch`
            : coin.status === "frozen"
              ? `${coin.symbol} · Frozen${coin.frozenAt ? ` ${coin.frozenAt}` : ""}`
              : coin.symbol;
        items.push({
          id: `coin-${coin.id}`,
          label: coin.name,
          sublabel,
          section: "Stablecoins",
          logoUrl,
          frozen: coin.status === "frozen",
          onSelect: () => {
            addToHistory(coin.id, "stablecoin", coin.name, coin.symbol, href);
            router.push(href);
            closePalette();
          },
        });
      }
    }

    // Pages
    if (q) {
      for (const page of COMMAND_PALETTE_PAGES) {
        if (
          fuzzyMatch(q, page.label) ||
          (page.description && fuzzyMatch(q, page.description))
        ) {
          const Icon = page.icon;
          items.push({
            id: `page-${page.href}`,
            label: page.label,
            sublabel: page.description,
            section: "Pages",
            icon: <Icon className="h-4 w-4" />,
            onSelect: () => {
              addToHistory(page.href, "page", page.label, page.description, page.href);
              router.push(page.href);
              closePalette();
            },
          });
        }
      }
    }

    // Actions
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
      }
    };

    for (const action of buildCommandPaletteActionDefinitions(isDark)) {
      if (!q || fuzzyMatch(q, action.label) || fuzzyMatch(q, action.keywords)) {
        items.push({
          id: action.id,
          label: action.label,
          sublabel: action.sublabel,
          section: "Actions",
          icon: getActionIcon(action.icon),
          onSelect: () => selectAction(action.actionId),
        });
      }
    }

    return items;
  }, [query, logos, isDark, toggleTheme, router, closePalette, history, addToHistory]);

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
      setSelectedIndex((prev) =>
        prev < flatResults.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="inset-x-0 top-0 translate-x-0 translate-y-0 flex h-[100dvh] max-w-none flex-col rounded-none border-0 sm:inset-x-auto sm:top-[50%] sm:left-[50%] sm:h-auto sm:max-h-none sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:mt-[18vh] sm:rounded-xl sm:border sm:border-border/75 z-[100] overflow-hidden bg-card p-0 shadow-[0_28px_50px_oklch(0_0_0_/0.35)]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {/* Search input */}
        <div className="relative shrink-0">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stablecoins, pages..."
            className="h-12 w-full border-b border-border/70 bg-transparent pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
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
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto py-2 sm:max-h-[60vh] sm:flex-initial"
        >
          {query.trim() && flatResults.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">No results found for &ldquo;{query}&rdquo;</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Try searching by symbol (e.g., USDT) or browse by category
              </p>
            </div>
          )}

          {!query.trim() && history.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Start typing to search stablecoins and pages
            </div>
          )}

          {groupedResults.map((group) => (
            <div key={group.section}>
              <div className="flex items-center justify-between px-4 py-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.section}
                </span>
                {group.section === "Recent" && history.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
                    className={`pharos-focus-ring mx-2 flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-2.5 text-left text-sm text-foreground transition-all duration-150 ${
                      isSelected
                        ? "border-border/70 bg-muted/55 shadow-sm"
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
                        <span className="text-muted-foreground text-xs truncate block">
                          {item.sublabel}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-4 border-t border-border/70 bg-muted/15 px-4 py-2 text-xs text-muted-foreground">
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
