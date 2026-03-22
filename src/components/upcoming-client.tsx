"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
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
  truncateTeaser,
} from "@/lib/pre-launch";
import type { LaunchPhase } from "@shared/types";
import logos from "../../data/logos.json";
import aiSummaries from "../../data/ai-summaries.json";

const typedLogos = logos as Record<string, string>;
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
    <div className="space-y-5">
      {/* ── KPI bar ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">{PRE_LAUNCH_STABLECOINS.length}</span>{" "}
          tracked
        </span>
        {ALL_PHASES.map(
          (phase) =>
            phaseCounts[phase] && (
              <span key={phase}>
                <span className="font-semibold text-foreground">{phaseCounts[phase]}</span>{" "}
                {LAUNCH_PHASE_LABELS[phase].toLowerCase()}
              </span>
            ),
        )}
      </div>

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="space-y-3">
        {/* Phase */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Phase</span>
          {ALL_PHASES.map((phase) => (
            <button
              key={phase}
              onClick={() => setPhaseFilter(toggleSet(phaseFilter, phase))}
              className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                phaseFilter.has(phase)
                  ? PHASE_BADGE[phase]
                  : "border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {LAUNCH_PHASE_LABELS[phase]}
            </button>
          ))}
        </div>

        {/* Peg & Backing (only show if >1 option) */}
        {ALL_PEGS.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Peg</span>
            {ALL_PEGS.map((peg) => (
              <button
                key={peg}
                onClick={() => setPegFilter(toggleSet(pegFilter, peg))}
                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  pegFilter.has(peg)
                    ? "border-foreground/20 bg-foreground/5 text-foreground"
                    : "border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {PEG_LABELS_SHORT[peg] ?? peg}
              </button>
            ))}
          </div>
        )}

        {ALL_BACKINGS.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Backing</span>
            {ALL_BACKINGS.map((backing) => (
              <button
                key={backing}
                onClick={() => setBackingFilter(toggleSet(backingFilter, backing))}
                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  backingFilter.has(backing)
                    ? "border-foreground/20 bg-foreground/5 text-foreground"
                    : "border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {BACKING_LABELS_SHORT[backing] ?? backing}
              </button>
            ))}
          </div>
        )}

        {/* Sort */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Sort</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortKey(opt.key)}
              className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                sortKey === opt.key
                  ? "border-foreground/20 bg-foreground/5 text-foreground"
                  : "border-border/50 bg-transparent text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={() => {
              setPhaseFilter(new Set());
              setPegFilter(new Set());
              setBackingFilter(new Set());
            }}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Card grid ────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No pre-launch stablecoins match the current filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((coin) => {
            const teaser = typedSummaries[coin.id]?.text;
            const drift = getDriftStatus(coin.dateHistory, coin.expectedLaunchDate);

            return (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                className="pharos-focus-ring pharos-interactive-card group flex flex-col rounded-xl border border-border/60 bg-card/50 p-4 transition-colors"
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
                      className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${PHASE_BADGE[coin.launchPhase]}`}
                    >
                      {LAUNCH_PHASE_LABELS[coin.launchPhase]}
                    </span>
                  )}
                  <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {PEG_LABELS_SHORT[coin.flags.pegCurrency]}
                  </span>
                  <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {BACKING_LABELS_SHORT[coin.flags.backing]}
                  </span>
                  <span className="inline-flex rounded-full border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {GOVERNANCE_LABELS_SHORT[coin.flags.governance]}
                  </span>
                </div>

                {/* Teaser */}
                {teaser && (
                  <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {truncateTeaser(teaser, 100)}
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
