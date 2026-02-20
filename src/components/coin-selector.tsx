"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StablecoinLogo } from "@/components/stablecoin-logo";

export interface CoinOption {
  id: string;
  name: string;
  symbol: string;
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    },
    [],
  );

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
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Remove ${selected.name}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // Filter coins by search
  const query = search.toLowerCase();
  const filtered = query
    ? coins.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.symbol.toLowerCase().includes(query),
      )
    : coins;

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <Button
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
              placeholder="Search by name or symbol..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <ul
            role="listbox"
            className="max-h-56 overflow-y-auto px-1 pb-1"
          >
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground text-center">
                No stablecoin found.
              </li>
            )}
            {filtered.map((coin) => {
              const disabled = disabledIds?.has(coin.id);
              return (
                <li
                  key={coin.id}
                  role="option"
                  aria-selected={false}
                  aria-disabled={disabled}
                  className={
                    disabled
                      ? "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm opacity-40 cursor-not-allowed"
                      : "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-accent"
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
