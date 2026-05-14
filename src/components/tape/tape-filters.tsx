"use client";

import { useCallback, useMemo } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FilterSearchInput } from "@/components/filter-search-input";
import { PEG_FILTER_OPTIONS } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { isUrlFilterClearValue } from "@/hooks/use-url-filters";
import { TAPE_FILTER_SEVERITY_VALUES } from "@/hooks/use-events";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";
import { TAPE_CLASSES } from "@/components/tape/tape-classes";

export type TapeWindowKey = "24h" | "7d" | "30d" | "90d" | "all";

const WINDOW_OPTIONS: { value: TapeWindowKey; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

const SEVERITY_LABELS: Record<TapeEventSeverity, string> = {
  info: "Info+",
  notice: "Notice+",
  warning: "Warning+",
  severe: "Severe+",
  critical: "Critical",
};

const CHAIN_OPTIONS = Object.entries(CHAIN_META)
  .map(([id, meta]) => ({ value: id, label: meta.name }))
  .sort((a, b) => a.label.localeCompare(b.label));

export interface TapeFilterState {
  /** Comma-joined or empty string — the URL representation. */
  typeRaw: string;
  type: string[];
  severity: TapeEventSeverity | null;
  coin: string;
  peg: string;
  chain: string;
  window: TapeWindowKey;
  q: string;
}

function parseTapeWindow(value: string): TapeWindowKey {
  if (value === "24h" || value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "7d";
}

export function tapeWindowSince(window: TapeWindowKey, nowMs: number = Date.now()): number | undefined {
  switch (window) {
    case "24h": return nowMs - 24 * 3600 * 1000;
    case "7d": return nowMs - 7 * 86400 * 1000;
    case "30d": return nowMs - 30 * 86400 * 1000;
    case "90d": return nowMs - 90 * 86400 * 1000;
    case "all": return undefined;
  }
}

function parseTapeTypes(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseSeverity(raw: string): TapeEventSeverity | null {
  if (!raw || isUrlFilterClearValue(raw)) return null;
  if ((TAPE_FILTER_SEVERITY_VALUES as readonly string[]).includes(raw)) {
    return raw as TapeEventSeverity;
  }
  return null;
}

export function readTapeFilterState(getParam: (key: string, defaultValue?: string) => string): TapeFilterState {
  const typeRaw = getParam("type", "");
  return {
    typeRaw,
    type: parseTapeTypes(typeRaw),
    severity: parseSeverity(getParam("severity", "")),
    coin: getParam("coin", ""),
    peg: getParam("peg", "all"),
    chain: getParam("chain", "all"),
    window: parseTapeWindow(getParam("window", "7d")),
    q: getParam("q", ""),
  };
}

interface TapeFiltersProps {
  state: TapeFilterState;
  setParam: (key: string, value: string) => void;
  /** Optional event source for the coin combo box (omitted in v1 — coin filter is URL-driven only). */
  eventsForCoinDirectory?: TapeEvent[];
}

export function TapeFilters({ state, setParam }: TapeFiltersProps) {
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

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-card/30 p-3">
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Filter by event type">
        {TAPE_CLASSES.map((cls) => {
          const slug = `${cls.slug}.*`;
          const active = activeClassSet.has(slug);
          return (
            <button
              key={cls.slug}
              type="button"
              onClick={() => onToggleClass(cls.slug)}
              aria-pressed={active}
              className={`pharos-focus-ring inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-border/60 bg-background/40 text-muted-foreground hover:text-foreground"
              }`}
            >
              {cls.label}
            </button>
          );
        })}
        {state.type.length > 0 ? (
          <button
            type="button"
            onClick={() => setParam("type", "")}
            className="pharos-focus-ring inline-flex items-center rounded-full border border-dashed border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear types
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          value={state.window}
          onValueChange={(v) => v && setParam("window", v)}
          aria-label="Filter by time window"
          className="flex gap-1"
        >
          {WINDOW_OPTIONS.map((opt) => (
            <ToggleGroupItem key={opt.value} value={opt.value} variant="outline" size="sm" className="text-xs">
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <ToggleGroup
          type="single"
          value={state.severity ?? "all"}
          onValueChange={(v) => setParam("severity", v && v !== "all" ? v : "")}
          aria-label="Filter by severity floor"
          className="flex gap-1"
        >
          <ToggleGroupItem value="all" variant="outline" size="sm" className="text-xs">
            Any
          </ToggleGroupItem>
          {TAPE_FILTER_SEVERITY_VALUES.map((sev) => (
            <ToggleGroupItem key={sev} value={sev} variant="outline" size="sm" className="text-xs">
              {SEVERITY_LABELS[sev]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span>Peg</span>
          <select
            value={state.peg}
            onChange={(e) => setParam("peg", e.target.value)}
            aria-label="Filter by peg currency"
            className="pharos-focus-ring h-8 rounded-md border border-border/60 bg-background/40 px-2 text-xs"
          >
            {PEG_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span>Chain</span>
          <select
            value={state.chain}
            onChange={(e) => setParam("chain", e.target.value)}
            aria-label="Filter by chain"
            className="pharos-focus-ring h-8 rounded-md border border-border/60 bg-background/40 px-2 text-xs"
          >
            <option value="all">All chains</option>
            {CHAIN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <FilterSearchInput
          value={state.q}
          onValueChange={(v) => setParam("q", v)}
          placeholder="Search events..."
          className="relative w-full sm:w-56"
          inputClassName="pl-8 h-8 text-xs"
          ariaLabel="Search events by title or summary"
        />
      </div>
    </div>
  );
}
