"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FilterSearchInput } from "@/components/filter-search-input";
import { FilterCombobox } from "@/components/filter-combobox";
import { PEG_FILTER_OPTIONS } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";

import { TAPE_FILTER_SEVERITY_VALUES } from "@/hooks/use-events";
import {
  SEVERITY_LABEL_INCLUSIVE,
  type TapeEventSeverity,
} from "@shared/types/tape-event";
import { TAPE_CLASSES } from "@/components/tape/tape-classes";

export type TapeWindowKey = "24h" | "7d" | "30d" | "90d" | "all";

const WINDOW_OPTIONS: { value: TapeWindowKey; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

// `useUrlFilters` treats the literal string "all" as a sentinel "clear" value,
// which would delete the param and silently revert to the 7d default. Use a
// distinct URL token for the all-time window so the click writes through.
const WINDOW_URL_VALUE: Record<TapeWindowKey, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "alltime",
};

// `notice` is the page-level default. Routine info-tier bookkeeping (e.g.
// USDT issuer freeze.unblocked actions) drowns the feed otherwise; users
// can drop the floor by clicking the "Info+" chip.
const DEFAULT_SEVERITY: TapeEventSeverity = "notice";

const CHAIN_OPTIONS = Object.entries(CHAIN_META)
  .map(([id, meta]) => ({ value: id, label: meta.name }))
  .sort((a, b) => a.label.localeCompare(b.label));

export interface TapeFilterState {
  /** Comma-joined or empty string — the URL representation. */
  typeRaw: string;
  type: string[];
  /** Always set; defaults to `notice`. Use `info` to drop the floor entirely. */
  severity: TapeEventSeverity;
  coin: string;
  peg: string;
  chain: string;
  window: TapeWindowKey;
  q: string;
}

export { DEFAULT_SEVERITY as TAPE_DEFAULT_SEVERITY };

export function tapeWindowSince(window: TapeWindowKey, nowMs: number = Date.now()): number | undefined {
  switch (window) {
    case "24h": return nowMs - 24 * 3600 * 1000;
    case "7d": return nowMs - 7 * 86400 * 1000;
    case "30d": return nowMs - 30 * 86400 * 1000;
    case "90d": return nowMs - 90 * 86400 * 1000;
    case "all": return undefined;
  }
}

interface TapeFiltersProps {
  state: TapeFilterState;
  setParam: (key: string, value: string) => void;
  /** Active coin filter value to render as a chip; cleared via `onClearCoin`. */
  coin?: string;
  onClearCoin?: () => void;
}

// Wire-service chip primitives (see docs/tape-page.md Aesthetic Lock).
// Square borders, mono uppercase, active state via foreground color.
const CHIP_BASE =
  "pharos-focus-ring inline-flex min-h-11 items-center border px-3 py-2 text-xs uppercase tracking-wide transition-colors sm:min-h-0 sm:px-2 sm:py-0.5";
const CHIP_INACTIVE = "border-border/50 text-muted-foreground hover:border-foreground/40 hover:text-foreground";
const CHIP_ACTIVE = "border-foreground bg-foreground/10 text-foreground";

const COMBOBOX_TRIGGER =
  "min-h-11 border border-border/50 px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground hover:border-foreground/40 hover:text-foreground sm:min-h-0 sm:px-2 sm:py-0.5";

// `q` is server-driven (`/api/events?q=`) so each keystroke would refetch.
// Debounce 200ms locally and only push to the URL after the user stops
// typing. The parent reads from URL state so the local-vs-URL drift heals
// itself when the timer fires.
function DebouncedSearchInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    const id = setTimeout(() => onCommit(local), 200);
    return () => clearTimeout(id);
  }, [local, value, onCommit]);
  return (
    <FilterSearchInput
      value={local}
      onValueChange={setLocal}
      placeholder="Search events..."
      className="relative w-full sm:w-56"
      inputClassName="h-11 pl-8 text-sm sm:h-8 sm:text-xs"
      ariaLabel="Search events by title or summary"
    />
  );
}

export function TapeFilters({ state, setParam, coin, onClearCoin }: TapeFiltersProps) {
  const onToggleClass = useCallback(
    (slug: string) => {
      const current = new Set(state.type);
      if (current.has(`${slug}.*`)) {
        current.delete(`${slug}.*`);
      } else {
        current.add(`${slug}.*`);
      }
      const next = Array.from(current).sort();
      setParam("type", next.join(","));
    },
    [state.type, setParam],
  );

  const activeClassSet = useMemo(() => new Set(state.type), [state.type]);
  const activeClassCount = state.type.length;

  // Mobile-only disclosure for the class chip row. Desktop renders the chips
  // unconditionally via `hidden sm:block`. Initial state reflects the URL so a
  // shared link with active classes opens expanded; manual collapse sticks.
  const [mobileClassesOpen, setMobileClassesOpen] = useState(activeClassCount > 0);

  const classChips = (
    <div className="flex flex-wrap items-center gap-2 sm:gap-1" aria-label="Filter by event type">
      {TAPE_CLASSES.map((cls) => {
        const slug = `${cls.slug}.*`;
        const active = activeClassSet.has(slug);
        return (
          <button
            key={cls.slug}
            type="button"
            onClick={() => onToggleClass(cls.slug)}
            aria-pressed={active}
            className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
          >
            {cls.label}
          </button>
        );
      })}
      {state.type.length > 0 ? (
        <button
          type="button"
          onClick={() => setParam("type", "")}
          className={`${CHIP_BASE} border-dashed ${CHIP_INACTIVE}`}
        >
          Clear classes
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="sticky top-0 z-0 space-y-3 border-y border-border/60 bg-background/90 px-3 py-3 font-mono tabular-nums text-xs backdrop-blur supports-[backdrop-filter]:bg-background/75">
      {coin && onClearCoin ? (
        <div className="flex flex-wrap items-center gap-2 sm:gap-1" aria-label="Active coin filter">
          <button
            type="button"
            onClick={onClearCoin}
            aria-label={`Clear filter: Coin ${coin}`}
            className={`${CHIP_BASE} ${CHIP_ACTIVE}`}
          >
            <span>Coin: <span className="font-semibold">{coin}</span></span>
            <span aria-hidden="true" className="ml-1.5">×</span>
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setMobileClassesOpen((v) => !v)}
        aria-expanded={mobileClassesOpen}
        aria-controls="tape-class-chips-mobile"
        className="pharos-focus-ring inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground sm:hidden"
      >
        <span className={`inline-block transition-transform ${mobileClassesOpen ? "rotate-90" : ""}`} aria-hidden="true">▸</span>
        {activeClassCount > 0 ? `Filter by class · ${activeClassCount} active` : `Filter by class`}
      </button>

      {mobileClassesOpen ? (
        <div id="tape-class-chips-mobile" className="sm:hidden">
          {classChips}
        </div>
      ) : null}

      <div className="hidden sm:block">{classChips}</div>

      <div className="flex flex-wrap items-center gap-2 sm:gap-x-3 sm:gap-y-2">
        <div role="radiogroup" aria-label="Filter by time window" className="inline-flex flex-wrap gap-2 sm:gap-1">
          {WINDOW_OPTIONS.map((opt) => {
            const active = state.window === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setParam("window", WINDOW_URL_VALUE[opt.value])}
                className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div role="radiogroup" aria-label="Filter by severity floor" className="inline-flex flex-wrap gap-2 sm:gap-1">
                {TAPE_FILTER_SEVERITY_VALUES.map((sev) => {
                  const active = state.severity === sev;
                  return (
                    <button
                      key={sev}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setParam("severity", sev === DEFAULT_SEVERITY ? "" : sev)}
                      className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                    >
                      {SEVERITY_LABEL_INCLUSIVE[sev]}
                    </button>
                  );
                })}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              info → notice → warning → severe → critical. The selected tier and above are shown.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <FilterCombobox
          label="Peg"
          searchable={false}
          value={state.peg}
          onValueChange={(v) => setParam("peg", v)}
          options={PEG_FILTER_OPTIONS}
          triggerClassName={COMBOBOX_TRIGGER}
        />

        <FilterCombobox
          label="Chain"
          value={state.chain}
          onValueChange={(v) => setParam("chain", v)}
          options={[{ value: "all", label: "All chains" }, ...CHAIN_OPTIONS]}
          triggerClassName={COMBOBOX_TRIGGER}
        />

        <DebouncedSearchInput
          value={state.q}
          onCommit={(v) => setParam("q", v)}
        />
      </div>
    </div>
  );
}
