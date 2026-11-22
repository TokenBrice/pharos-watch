"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { CoinSelector } from "@/components/coin-selector";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { CoinOption } from "@/lib/compare-types";

interface CompareCoinSlotProps {
  coins: CoinOption[];
  selected: CoinOption | null;
  logos?: Record<string, string>;
  disabledIds?: Set<string>;
  disabled?: boolean;
  onSelect: (coin: CoinOption) => void;
  onRemove: () => void;
}

/**
 * Compare-specific coin slot: delegates empty slots to shared `CoinSelector`
 * and adds in-place click-to-swap on filled pills without altering shared chrome.
 */
export function CompareCoinSlot({
  coins,
  selected,
  logos,
  disabledIds,
  disabled = false,
  onSelect,
  onRemove,
}: CompareCoinSlotProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionIdPrefix = `${listboxId}-option`;

  const dismiss = useCallback(() => {
    setOpen(false);
    setSearch("");
    setFocusedIndex(-1);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        dismiss();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, dismiss]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? coins.filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.symbol.toLowerCase().includes(query),
        )
      : coins;
  }, [coins, search]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open || disabled) return;
      switch (e.key) {
        case "Escape":
          dismiss();
          triggerRef.current?.focus();
          e.preventDefault();
          break;
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((prev) => {
            if (filtered.length === 0) return -1;
            const nextIdx = prev + 1;
            return nextIdx >= filtered.length ? 0 : nextIdx;
          });
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((prev) => {
            if (filtered.length === 0) return -1;
            const nextIdx = prev - 1;
            return nextIdx < 0 ? filtered.length - 1 : nextIdx;
          });
          break;
        case "Enter": {
          e.preventDefault();
          const target = filtered[focusedIndex];
          if (target && !disabledIds?.has(target.id)) {
            onSelect(target);
            dismiss();
          }
          break;
        }
        case "Tab":
          dismiss();
          break;
      }
    },
    [disabled, open, filtered, focusedIndex, disabledIds, onSelect, dismiss],
  );

  useEffect(() => {
    if (focusedIndex >= 0 && filtered[focusedIndex]) {
      document.getElementById(`${optionIdPrefix}-${filtered[focusedIndex].id}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIndex, filtered, optionIdPrefix]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  if (!selected) {
    return (
      <CoinSelector
        coins={coins}
        selected={null}
        logos={logos}
        disabledIds={disabledIds}
        disabled={disabled}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    );
  }

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <div className="flex min-h-11 items-center gap-1 rounded-lg border border-border bg-accent/30 pr-1 sm:min-h-9">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`Swap ${selected.name} (${selected.symbol})`}
          title={`Click to swap ${selected.name}`}
          onClick={() => {
            if (open) dismiss();
            else setOpen(true);
          }}
          className="pharos-focus-ring group flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-l-lg pl-3 pr-1.5 text-left transition-colors hover:bg-accent/60 sm:min-h-9"
        >
          <StablecoinLogo src={logos?.[selected.id]} name={selected.name} size={20} />
          <span className="truncate text-sm font-medium text-foreground">{selected.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{selected.symbol}</span>
          <ArrowLeftRight
            aria-hidden="true"
            className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
          />
        </button>
        <button
          type="button"
          onClick={() => {
            dismiss();
            onRemove();
          }}
          disabled={disabled}
          className="pharos-focus-ring flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground sm:min-h-8 sm:min-w-8"
          aria-label={`Remove ${selected.name}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div className="absolute z-modal mt-1 w-full min-w-56 rounded-md border border-border bg-popover shadow-md">
          <div className="p-2">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={`Replace ${selected.name}`}
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                filtered[focusedIndex] ? `${optionIdPrefix}-${filtered[focusedIndex].id}` : undefined
              }
              placeholder={`Swap ${selected.symbol} with...`}
              value={search}
              disabled={disabled}
              onChange={(e) => {
                setSearch(e.target.value);
                setFocusedIndex(-1);
              }}
              className="min-h-11 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:py-1.5"
            />
          </div>
          <ul id={listboxId} role="listbox" className="max-h-56 overflow-y-auto px-1 pb-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-center text-sm text-muted-foreground">No stablecoin found.</li>
            )}
            {filtered.map((coin, idx) => {
              const isCurrent = coin.id === selected.id;
              const coinDisabled = disabled || disabledIds?.has(coin.id);
              const focused = idx === focusedIndex;
              return (
                <li
                  key={coin.id}
                  id={`${optionIdPrefix}-${coin.id}`}
                  role="option"
                  aria-selected={isCurrent}
                  aria-disabled={coinDisabled}
                  className={
                    coinDisabled
                      ? "flex min-h-11 cursor-not-allowed items-center gap-2 rounded-sm px-2 py-2 text-sm opacity-45 sm:min-h-8 sm:py-1.5"
                      : `flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm transition-colors hover:bg-accent sm:min-h-8 sm:py-1.5 ${focused ? "bg-accent" : ""}`
                  }
                  onClick={() => {
                    if (!coinDisabled) {
                      onSelect(coin);
                      dismiss();
                    }
                  }}
                >
                  <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={18} />
                  <span className="truncate">{coin.name}</span>
                  <span className="text-xs text-muted-foreground">{coin.symbol}</span>
                  {isCurrent ? <span className="ml-auto text-3xs text-muted-foreground">Selected</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
