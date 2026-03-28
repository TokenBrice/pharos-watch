"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { X, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { CoinOption } from "@/lib/compare-types";

interface CoinSelectorProps {
  coins: CoinOption[];
  selected: CoinOption | null;
  logos?: Record<string, string>;
  disabledIds?: Set<string>;
  onSelect: (coin: CoinOption) => void;
  onRemove: () => void;
}

export function CoinSelector({
  coins,
  selected,
  logos,
  disabledIds,
  onSelect,
  onRemove,
}: CoinSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Filter coins by search (must be above early return so keyboard handler can reference it)
  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    return query
      ? coins.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.symbol.toLowerCase().includes(query),
        )
      : coins;
  }, [coins, search]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return;
      switch (e.key) {
        case "Escape":
          setOpen(false);
          setSearch("");
          setFocusedIndex(-1);
          buttonRef.current?.focus();
          e.preventDefault();
          break;
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((prev) => {
            const nextIdx = prev + 1;
            return nextIdx >= filtered.length ? 0 : nextIdx;
          });
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((prev) => {
            const nextIdx = prev - 1;
            return nextIdx < 0 ? filtered.length - 1 : nextIdx;
          });
          break;
        case "Enter": {
          e.preventDefault();
          const target = filtered[focusedIndex];
          if (target && !disabledIds?.has(target.id)) {
            onSelect(target);
            setOpen(false);
            setSearch("");
            setFocusedIndex(-1);
          }
          break;
        }
        case "Tab":
          setOpen(false);
          setSearch("");
          setFocusedIndex(-1);
          break;
      }
    },
    [open, filtered, focusedIndex, disabledIds, onSelect],
  );

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex >= 0 && filtered[focusedIndex]) {
      const el = document.getElementById(
        `coin-option-${filtered[focusedIndex].id}`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIndex, filtered]);

  // Focus input when dropdown opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Selected state: show chip with remove button
  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2 bg-accent/30">
        <StablecoinLogo
          src={logos?.[selected.id]}
          name={selected.name}
          size={20}
        />
        <span className="text-sm font-medium truncate">{selected.name}</span>
        <span className="text-xs text-muted-foreground">
          {selected.symbol}
        </span>
        <button
          onClick={onRemove}
          className="pharos-focus-ring ml-auto flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded sm:min-h-9 sm:min-w-9"
          aria-label={`Remove ${selected.name}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <Button
        ref={buttonRef}
        variant="outline"
        className="w-full justify-between text-muted-foreground font-normal"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        Add stablecoin...
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="p-2">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="Search coins"
              aria-expanded={open}
              aria-controls="coin-selector-listbox"
              aria-autocomplete="list"
              aria-activedescendant={
                focusedIndex >= 0
                  ? `coin-option-${filtered[focusedIndex]?.id}`
                  : undefined
              }
              placeholder="Search by name or symbol..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setFocusedIndex(-1);
              }}
              className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <ul
            id="coin-selector-listbox"
            role="listbox"
            className="max-h-56 overflow-y-auto px-1 pb-1"
          >
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground text-center">
                No stablecoin found.
              </li>
            )}
            {filtered.map((coin, idx) => {
              const disabled = disabledIds?.has(coin.id);
              const focused = idx === focusedIndex;
              return (
                <li
                  key={coin.id}
                  id={`coin-option-${coin.id}`}
                  role="option"
                  aria-selected={focused}
                  aria-disabled={disabled}
                  className={
                    disabled
                      ? "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm opacity-40 cursor-not-allowed"
                      : `flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-accent transition-colors ${focused ? "bg-accent" : ""}`
                  }
                  onClick={() => {
                    if (!disabled) {
                      onSelect(coin);
                      setOpen(false);
                      setSearch("");
                    }
                  }}
                >
                  <StablecoinLogo
                    src={logos?.[coin.id]}
                    name={coin.name}
                    size={18}
                  />
                  <span className="truncate">{coin.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {coin.symbol}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
