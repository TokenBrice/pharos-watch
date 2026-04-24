"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { buildStablecoinUrl } from "@/lib/urls";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  LAUNCH_PHASE_LABELS,
  PHASE_BADGE,
  DRIFT_STATUS_BADGE,
  DRIFT_STATUS_LABEL,
  getDriftStatus,
  dateScore,
  formatFuzzyDate,
} from "@/lib/pre-launch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LaunchPhase } from "@shared/types";
import aiSummaries from "../../data/ai-summaries.json";
import { logosById } from "@/lib/logos";

const typedLogos = logosById;
const typedSummaries = aiSummaries as Record<
  string,
  { title?: string; text?: string; updatedAt?: string }
>;

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

type SortKey = "expected" | "announced" | "alphabetical";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "expected", label: "Expected Launch" },
  { key: "announced", label: "Announced Date" },
  { key: "alphabetical", label: "Name" },
];

const ALL_PHASES: LaunchPhase[] = ["announced", "testnet", "auditing", "beta", "launching-soon"];

// Derive filter options from actual data
const ALL_PEGS = [...new Set(PRE_LAUNCH_STABLECOINS.map((c) => c.flags.pegCurrency))];
const ALL_BACKINGS = [...new Set(PRE_LAUNCH_STABLECOINS.map((c) => c.flags.backing))];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/* tw: min-h-11 sm:min-h-9 — keep literal for Tailwind scanner */
const FILTER_TOUCH = "min-h-11 sm:min-h-9";

function neutralToggleClass(active: boolean): string {
  return active ? `pharos-control-pill pharos-control-pill-active ${FILTER_TOUCH}` : `pharos-toggle-pill ${FILTER_TOUCH}`;
}

function phaseToggleClass(phase: LaunchPhase, active: boolean): string {
  if (!active) return `pharos-toggle-pill ${FILTER_TOUCH}`;

  switch (phase) {
    case "announced":
      return `pharos-toggle-pill ${FILTER_TOUCH} border-amber-500/30 bg-amber-500/12 text-amber-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(245,158,11,0.12)] dark:border-amber-400/20 dark:text-amber-300`;
    case "testnet":
      return `pharos-toggle-pill ${FILTER_TOUCH} border-indigo-500/30 bg-indigo-500/12 text-indigo-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(99,102,241,0.12)] dark:border-indigo-400/20 dark:text-indigo-300`;
    case "auditing":
      return `pharos-toggle-pill ${FILTER_TOUCH} border-violet-500/30 bg-violet-500/12 text-violet-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(139,92,246,0.12)] dark:border-violet-400/20 dark:text-violet-300`;
    case "beta":
      return `pharos-toggle-pill ${FILTER_TOUCH} border-emerald-500/30 bg-emerald-500/12 text-emerald-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(16,185,129,0.12)] dark:border-emerald-400/20 dark:text-emerald-300`;
    case "launching-soon":
      return `pharos-toggle-pill ${FILTER_TOUCH} border-sky-500/30 bg-sky-500/12 text-sky-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_rgba(14,165,233,0.12)] dark:border-sky-400/20 dark:text-sky-300`;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UpcomingClient() {
  const [phaseFilter, setPhaseFilter] = useState<Set<LaunchPhase>>(new Set());
  const [pegFilter, setPegFilter] = useState<Set<string>>(new Set());
  const [backingFilter, setBackingFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("expected");

  const filtered = useMemo(() => {
    let coins = [...PRE_LAUNCH_STABLECOINS];

    if (phaseFilter.size > 0) {
      coins = coins.filter((c) => c.launchPhase && phaseFilter.has(c.launchPhase));
    }
    if (pegFilter.size > 0) {
      coins = coins.filter((c) => pegFilter.has(c.flags.pegCurrency));
    }
    if (backingFilter.size > 0) {
      coins = coins.filter((c) => backingFilter.has(c.flags.backing));
    }

    switch (sortKey) {
      case "expected":
        coins.sort((a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate));
        break;
      case "announced":
        coins.sort((a, b) => dateScore(a.announcedDate) - dateScore(b.announcedDate));
        break;
      case "alphabetical":
        coins.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    return coins;
  }, [phaseFilter, pegFilter, backingFilter, sortKey]);

  // KPI counts
  const phaseCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of PRE_LAUNCH_STABLECOINS) {
      if (c.launchPhase) counts[c.launchPhase] = (counts[c.launchPhase] ?? 0) + 1;
    }
    return counts;
  }, []);

  const hasActiveFilters = phaseFilter.size > 0 || pegFilter.size > 0 || backingFilter.size > 0;

  return (
    <div className="space-y-6">
      {/* ── KPI bar ──────────────────────────────────────────────── */}
      <div className="pharos-subtle-band">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="pharos-kicker">Pre-Launch Universe</p>
            <p className="pharos-meta">Track announced, testing, and launch-approaching stablecoins without mixing them into the live market table.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="pharos-control-pill">{PRE_LAUNCH_STABLECOINS.length} tracked</span>
            {ALL_PHASES.map(
              (phase) =>
                phaseCounts[phase] ? (
                  <span
                    key={phase}
                    className={`inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium ${PHASE_BADGE[phase]}`}
                  >
                    {phaseCounts[phase]} {LAUNCH_PHASE_LABELS[phase].toLowerCase()}
                  </span>
                ) : null,
            )}
          </div>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="pharos-kicker">Filters</p>
            <p className="pharos-meta">Narrow the tracked pre-launch set by launch phase, peg, backing, and sort order.</p>
          </div>
          {hasActiveFilters ? (
            <button
              onClick={() => {
                setPhaseFilter(new Set());
                setPegFilter(new Set());
                setBackingFilter(new Set());
              }}
              className="pharos-focus-ring min-h-11 self-start rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground sm:min-h-8 sm:self-auto"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1.05fr)_minmax(0,1fr)_minmax(0,1.45fr)] xl:items-start">
          <div className="min-w-0 space-y-2">
            <p className="pharos-kicker">Phase</p>
            <div className="flex flex-wrap gap-2">
              {ALL_PHASES.map((phase) => (
                <button
                  key={phase}
                  aria-pressed={phaseFilter.has(phase)}
                  onClick={() => setPhaseFilter(toggleSet(phaseFilter, phase))}
                  className={phaseToggleClass(phase, phaseFilter.has(phase))}
                >
                  {LAUNCH_PHASE_LABELS[phase]}
                </button>
              ))}
            </div>
          </div>

          {ALL_PEGS.length > 1 && (
            <div className="min-w-0 space-y-2">
              <p className="pharos-kicker">Peg</p>
              <div className="flex flex-wrap gap-2">
                {ALL_PEGS.map((peg) => (
                  <button
                    key={peg}
                    aria-pressed={pegFilter.has(peg)}
                    onClick={() => setPegFilter(toggleSet(pegFilter, peg))}
                    className={neutralToggleClass(pegFilter.has(peg))}
                  >
                    {PEG_LABELS_SHORT[peg] ?? peg}
                  </button>
                ))}
              </div>
            </div>
          )}

          {ALL_BACKINGS.length > 1 && (
            <div className="min-w-0 space-y-2">
              <p className="pharos-kicker">Backing</p>
              <div className="flex flex-wrap gap-2">
                {ALL_BACKINGS.map((backing) => (
                  <button
                    key={backing}
                    aria-pressed={backingFilter.has(backing)}
                    onClick={() => setBackingFilter(toggleSet(backingFilter, backing))}
                    className={neutralToggleClass(backingFilter.has(backing))}
                  >
                    {BACKING_LABELS_SHORT[backing] ?? backing}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="min-w-0 space-y-2">
            <p className="pharos-kicker">Sort By</p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="pharos-focus-ring pharos-toggle-pill inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-3 sm:min-h-9">
                  <span className="truncate">{SORT_OPTIONS.find((opt) => opt.key === sortKey)?.label}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[14rem]">
                <DropdownMenuRadioGroup value={sortKey} onValueChange={(value) => setSortKey(value as SortKey)}>
                  {SORT_OPTIONS.map((opt) => (
                    <DropdownMenuRadioItem key={opt.key} value={opt.key}>
                      {opt.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* ── Card grid ────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="pharos-empty-note flex flex-col items-center gap-3 py-12 text-center">
          <p>No pre-launch stablecoins match the current filters.</p>
          <button
            onClick={() => {
              setPhaseFilter(new Set());
              setPegFilter(new Set());
              setBackingFilter(new Set());
            }}
            className="pharos-focus-ring rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((coin) => {
            const teaser = typedSummaries[coin.id]?.text;
            const drift = getDriftStatus(coin.dateHistory, coin.expectedLaunchDate);

            return (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                className="pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col p-4"
              >
                {/* Header */}
                <div className="flex items-center gap-3">
                  <StablecoinLogo src={typedLogos[coin.id]} name={coin.name} size={36} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground group-hover:text-foreground/80">
                      {coin.name}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">{coin.symbol}</p>
                  </div>
                </div>

                {/* Badges */}
                <div className="mt-3 flex flex-wrap gap-1">
                  {coin.launchPhase && (
                    <span
                      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-medium leading-none ${PHASE_BADGE[coin.launchPhase]}`}
                    >
                      {LAUNCH_PHASE_LABELS[coin.launchPhase]}
                    </span>
                  )}
                  <span className="inline-flex rounded-full border border-border/50 bg-muted/40 px-2 py-1 text-[10px] leading-none text-muted-foreground">
                    {PEG_LABELS_SHORT[coin.flags.pegCurrency]}
                  </span>
                  <span className="inline-flex rounded-full border border-border/50 bg-muted/40 px-2 py-1 text-[10px] leading-none text-muted-foreground">
                    {BACKING_LABELS_SHORT[coin.flags.backing]}
                  </span>
                  <span className="inline-flex rounded-full border border-border/50 bg-muted/40 px-2 py-1 text-[10px] leading-none text-muted-foreground">
                    {GOVERNANCE_LABELS_SHORT[coin.flags.governance]}
                  </span>
                </div>

                {/* Teaser */}
                {teaser && (
                  <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {teaser}
                  </p>
                )}

                {/* Footer: date + drift + milestones */}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
                  {coin.expectedLaunchDate && (
                    <span className="font-mono text-[10px] text-muted-foreground/50">
                      Expected {formatFuzzyDate(coin.expectedLaunchDate)}
                    </span>
                  )}
                  {drift !== "on-track" && (
                    <span
                      className={`inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none ${DRIFT_STATUS_BADGE[drift]}`}
                    >
                      {DRIFT_STATUS_LABEL[drift]}
                    </span>
                  )}
                  {coin.milestones && coin.milestones.length > 0 && (
                    <span className="text-[10px] text-muted-foreground/50">
                      {coin.milestones.length} milestone{coin.milestones.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
