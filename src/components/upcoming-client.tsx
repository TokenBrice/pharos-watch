"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { UpcomingHorizonHero } from "@/components/upcoming-horizon-hero";
import {
  LAUNCH_PHASE_LABELS,
  PHASE_BADGE,
  DRIFT_STATUS_BADGE,
  DRIFT_STATUS_LABEL,
  getDriftStatus,
  dateScore,
  formatFuzzyDate,
} from "@/lib/pre-launch";
import { stripTermMarkup } from "@/lib/term-markup";
import type { LaunchPhase, StablecoinMeta } from "@shared/types";
import { decodeState, encodeState, type UrlStateSchema } from "@/lib/url-state";
import { useUrlFilters } from "@/hooks/use-url-filters";

export type UpcomingCoin = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "launchPhase" | "expectedLaunchDate" | "announcedDate" | "dateHistory" | "milestones"
> & {
  flags: Pick<StablecoinMeta["flags"], "pegCurrency" | "backing" | "governance">;
};

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

export type SortKey = "expected" | "announced" | "alphabetical";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "expected", label: "Expected Launch" },
  { key: "announced", label: "Announced Date" },
  { key: "alphabetical", label: "Name" },
];

const ALL_PHASES: LaunchPhase[] = ["announced", "testnet", "auditing", "beta", "launching-soon"];

export interface UpcomingUrlState {
  phase: readonly LaunchPhase[];
  peg: readonly string[];
  backing: readonly string[];
  sort: SortKey;
}

export function createUpcomingUrlSchema(coins: readonly UpcomingCoin[]): UrlStateSchema<UpcomingUrlState> {
  const pegs = [...new Set(coins.map((coin) => coin.flags.pegCurrency))];
  const backings = [...new Set(coins.map((coin) => coin.flags.backing))];
  return {
    phase: {
      kind: "enumList",
      defaultValue: [],
      allowedValues: ALL_PHASES,
    },
    peg: {
      kind: "enumList",
      defaultValue: [],
      allowedValues: pegs,
    },
    backing: {
      kind: "enumList",
      defaultValue: [],
      allowedValues: backings,
    },
    sort: {
      kind: "enum",
      defaultValue: "expected",
      allowedValues: SORT_OPTIONS.map((option) => option.key),
    },
  };
}

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Teasers and the pre-launch projection are selected server-side in
// src/app/upcoming/page.tsx — the client receives only the fields rendered
// here instead of importing the full registry and logo map.
export function UpcomingClient({
  coins,
  logos,
  teasers,
}: {
  coins: readonly UpcomingCoin[];
  logos: Readonly<Record<string, string | undefined>>;
  teasers: Record<string, string>;
}) {
  const { searchParams, replaceParams } = useUrlFilters();
  const schema = useMemo(() => createUpcomingUrlSchema(coins), [coins]);
  const filters = useMemo(() => decodeState(searchParams, schema), [schema, searchParams]);
  const phaseFilter = useMemo(() => new Set(filters.phase), [filters.phase]);
  const pegFilter = useMemo(() => new Set(filters.peg), [filters.peg]);
  const backingFilter = useMemo(() => new Set(filters.backing), [filters.backing]);

  const writeFilters = useCallback(
    (next: UpcomingUrlState) => {
      const encoded = encodeState(next, schema);
      replaceParams((params) => {
        for (const key of Object.keys(schema)) params.delete(key);
        for (const [key, value] of new URLSearchParams(encoded)) params.set(key, value);
      });
    },
    [replaceParams, schema],
  );

  const togglePhase = useCallback(
    (phase: LaunchPhase) => {
      writeFilters({ ...filters, phase: Array.from(toggleSet(phaseFilter, phase)) });
    },
    [filters, phaseFilter, writeFilters],
  );

  const togglePeg = useCallback(
    (peg: string) => {
      writeFilters({ ...filters, peg: Array.from(toggleSet(pegFilter, peg)) });
    },
    [filters, pegFilter, writeFilters],
  );

  const toggleBacking = useCallback(
    (backing: string) => {
      writeFilters({ ...filters, backing: Array.from(toggleSet(backingFilter, backing)) });
    },
    [backingFilter, filters, writeFilters],
  );

  const clearFilters = useCallback(() => {
    writeFilters({ ...filters, phase: [], peg: [], backing: [] });
  }, [filters, writeFilters]);

  const allPegs = useMemo(() => [...new Set(coins.map((coin) => coin.flags.pegCurrency))], [coins]);
  const allBackings = useMemo(() => [...new Set(coins.map((coin) => coin.flags.backing))], [coins]);
  const nearestLaunch = useMemo(
    () => coins
      .filter((coin) => coin.expectedLaunchDate)
      .sort((a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate))[0] ?? null,
    [coins],
  );
  const sortKey = filters.sort;

  const filtered = useMemo(() => {
    let filteredCoins = [...coins];

    if (phaseFilter.size > 0) {
      filteredCoins = filteredCoins.filter((coin) => coin.launchPhase && phaseFilter.has(coin.launchPhase));
    }
    if (pegFilter.size > 0) {
      filteredCoins = filteredCoins.filter((coin) => pegFilter.has(coin.flags.pegCurrency));
    }
    if (backingFilter.size > 0) {
      filteredCoins = filteredCoins.filter((coin) => backingFilter.has(coin.flags.backing));
    }

    switch (sortKey) {
      case "expected":
        filteredCoins.sort((a, b) => dateScore(a.expectedLaunchDate) - dateScore(b.expectedLaunchDate));
        break;
      case "announced":
        filteredCoins.sort((a, b) => dateScore(a.announcedDate) - dateScore(b.announcedDate));
        break;
      case "alphabetical":
        filteredCoins.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    return filteredCoins;
  }, [backingFilter, coins, pegFilter, phaseFilter, sortKey]);

  const hasActiveFilters = phaseFilter.size > 0 || pegFilter.size > 0 || backingFilter.size > 0;

  return (
    <div className="space-y-6">
      {/* ── Hero: full-width pre-launch readiness constellation ───────────
          Header carries the frost launch-count "One Beam" + the soonest launch;
          the constellation spans the full card width below it (its per-circle
          count labels are the legend, so the old left-column count list is gone). */}
      <section aria-label="Pre-launch stablecoin readiness" className="pharos-card-shell overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border/50 p-5 sm:p-6">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Tracked Launches</p>
            <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
              {coins.length}
            </p>
          </div>
          {nearestLaunch?.expectedLaunchDate ? (
            <div className="flex items-baseline gap-2 font-mono text-xs">
              <span className="text-muted-foreground">Soonest</span>
              <Link
                href={buildStablecoinUrl(nearestLaunch.id)}
                className="pharos-focus-ring flex min-w-0 items-baseline gap-1.5 text-foreground hover:text-foreground/80"
              >
                <span className="truncate">{nearestLaunch.name}</span>
                <span aria-hidden="true" className="text-muted-foreground/50">·</span>
                <span className="pharos-numeric shrink-0">{formatFuzzyDate(nearestLaunch.expectedLaunchDate)}</span>
              </Link>
            </div>
          ) : null}
        </div>
        <UpcomingHorizonHero />
      </section>

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="pharos-kicker">Filters</p>
            <p className="pharos-meta">Narrow the tracked pre-launch set by launch phase, peg, backing, and sort order.</p>
          </div>
          {hasActiveFilters ? (
            <button type="button"
              onClick={() => {
                clearFilters();
              }}
              className="pharos-focus-ring min-h-11 self-start rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground sm:min-h-8 sm:self-auto"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,2.5fr)_minmax(0,0.725fr)] xl:gap-0 xl:divide-x xl:divide-border/50">
          <div className="min-w-0 space-y-4 xl:pr-5">
            <div className="space-y-2">
              <p className="pharos-kicker">Phase</p>
              <div className="flex flex-wrap gap-2">
                {ALL_PHASES.map((phase) => (
                  <button type="button"
                    key={phase}
                    aria-pressed={phaseFilter.has(phase)}
                    onClick={() => togglePhase(phase)}
                    className={neutralToggleClass(phaseFilter.has(phase))}
                  >
                    {LAUNCH_PHASE_LABELS[phase]}
                  </button>
                ))}
              </div>
            </div>

            {allBackings.length > 1 && (
              <div className="space-y-2">
                <p className="pharos-kicker">Backing</p>
                <div className="flex flex-wrap gap-2">
                  {allBackings.map((backing) => (
                    <button type="button"
                      key={backing}
                      aria-pressed={backingFilter.has(backing)}
                      onClick={() => toggleBacking(backing)}
                      className={neutralToggleClass(backingFilter.has(backing))}
                    >
                      {BACKING_LABELS_SHORT[backing] ?? backing}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {allPegs.length > 1 && (
            <div className="min-w-0 space-y-2 xl:px-5">
              <p className="pharos-kicker">Peg</p>
              <div className="flex flex-wrap gap-2">
                {allPegs.map((peg) => (
                  <button type="button"
                    key={peg}
                    aria-pressed={pegFilter.has(peg)}
                    onClick={() => togglePeg(peg)}
                    className={neutralToggleClass(pegFilter.has(peg))}
                  >
                    {PEG_LABELS_SHORT[peg] ?? peg}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="min-w-0 space-y-2 xl:pl-5">
            <p className="pharos-kicker">Sort By</p>
            <div className="flex flex-wrap gap-2">
              {SORT_OPTIONS.map((opt) => (
                <button type="button"
                  key={opt.key}
                  aria-pressed={sortKey === opt.key}
                  onClick={() => writeFilters({ ...filters, sort: opt.key })}
                  className={neutralToggleClass(sortKey === opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Card grid ────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="pharos-empty-note flex flex-col items-center gap-3 py-12 text-center">
          <p>No pre-launch coins match. Drop a filter or two.</p>
          <button type="button"
            onClick={() => {
              clearFilters();
            }}
            className="pharos-focus-ring rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((coin) => {
            const teaserText = teasers[coin.id];
            const teaser = teaserText ? stripTermMarkup(teaserText) : null;
            const drift = getDriftStatus(coin.dateHistory, coin.expectedLaunchDate);

            return (
              <Link
                key={coin.id}
                href={buildStablecoinUrl(coin.id)}
                className="pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col p-4"
              >
                {/* Header */}
                <div className="flex items-center gap-3">
                  <StablecoinLogo src={logos[coin.id]} name={coin.name} size={36} />
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
                    <span className="pharos-numeric text-[10px] text-muted-foreground/70">
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
                    <span className="text-[10px] text-muted-foreground/70">
                      <span className="pharos-numeric">{coin.milestones.length}</span> milestone{coin.milestones.length !== 1 ? "s" : ""}
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
