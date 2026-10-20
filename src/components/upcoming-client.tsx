"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
  PEG_LABELS_SHORT,
} from "@shared/lib/classification";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { LaunchDriftBadge, LaunchPhaseBadge } from "@/components/pre-launch-badge";
import { UpcomingHorizonHero } from "@/components/upcoming-horizon-hero";
import { FeatureHeroSplit, HeroMetricRow } from "@/components/feature-hero-split";
import { UniverseChip } from "@/components/universe-chip";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LAUNCH_PHASE_LABELS } from "@shared/lib/classification/pre-launch";
import {
  PHASE_DOT,
  dateScore,
  formatFuzzyDate,
  getDriftStatus,
  resolveDriftDisplay,
  selectPreLaunchClockView,
  type DriftDisplayStatus,
  type PreLaunchClockView,
} from "@/lib/pre-launch";
import { stripTermMarkup } from "@/lib/term-markup";
import type { LaunchPhase, StablecoinMeta } from "@shared/types";
import { type UrlStateSchema } from "@/lib/url-state";
import { useUrlState } from "@/hooks/use-url-state";
import { getLogoSrc } from "@/lib/logos";
import { cn } from "@/lib/utils";

export type UpcomingCoin = Pick<
  StablecoinMeta,
  "id" | "name" | "symbol" | "launchPhase" | "expectedLaunchDate" | "announcedDate" | "dateHistory" | "milestones"
> & {
  flags: Pick<StablecoinMeta["flags"], "pegCurrency" | "backing" | "governance">;
};

// ---------------------------------------------------------------------------
// Filter and sort types
// ---------------------------------------------------------------------------

export type SortKey = "expected" | "alphabetical" | "phase" | "peg" | "backing" | "drift" | "milestones";
export type SortDirection = "asc" | "desc";

const SORT_KEYS: readonly SortKey[] = ["expected", "alphabetical", "phase", "peg", "backing", "drift", "milestones"];

/** First click on a column sorts in its reading direction; a second click flips it. */
const NATURAL_DIRECTION: Record<SortKey, SortDirection> = {
  expected: "asc",
  alphabetical: "asc",
  phase: "desc",
  peg: "asc",
  backing: "asc",
  drift: "desc",
  milestones: "desc",
};

const ALL_PHASES: LaunchPhase[] = ["announced", "testnet", "auditing", "beta", "launching-soon"];

/** Phase filter values: the authored phases plus coins Pharos has not phased yet. */
export type PhaseFilterValue = LaunchPhase | "unphased";
const PHASE_FILTER_VALUES: readonly PhaseFilterValue[] = [...ALL_PHASES, "unphased"];

export interface UpcomingUrlState {
  phase: readonly PhaseFilterValue[];
  peg: readonly string[];
  backing: readonly string[];
  sort: SortKey;
  dir: SortDirection;
}

export function createUpcomingUrlSchema(coins: readonly UpcomingCoin[]): UrlStateSchema<UpcomingUrlState> {
  const pegs = [...new Set(coins.map((coin) => coin.flags.pegCurrency))];
  const backings = [...new Set(coins.map((coin) => coin.flags.backing))];
  return {
    phase: {
      kind: "enumList",
      defaultValue: [],
      allowedValues: PHASE_FILTER_VALUES,
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
      allowedValues: SORT_KEYS,
    },
    dir: {
      kind: "enum",
      defaultValue: "asc",
      allowedValues: ["asc", "desc"],
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

function phaseOf(coin: UpcomingCoin): PhaseFilterValue {
  return coin.launchPhase ?? "unphased";
}

const PHASE_RANK: Record<PhaseFilterValue, number> = {
  unphased: -1,
  announced: 0,
  testnet: 1,
  auditing: 2,
  beta: 3,
  "launching-soon": 4,
};

const DRIFT_RANK: Record<DriftDisplayStatus, number> = {
  "on-track": 0,
  "no-current-target": 1,
  "pushed-once": 2,
  "pushed-multiple": 3,
  overdue: 4,
};

/** Compare with missing values (no target date) always last, whatever the direction. */
function compareWithMissingLast(a: number, b: number, dir: number): number {
  const aMissing = !Number.isFinite(a);
  const bMissing = !Number.isFinite(b);
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  return (a - b) * dir;
}

export function sortUpcomingCoins(
  coins: readonly UpcomingCoin[],
  sortKey: SortKey,
  direction: SortDirection,
  driftOf: (coin: UpcomingCoin) => DriftDisplayStatus,
): UpcomingCoin[] {
  const dir = direction === "asc" ? 1 : -1;
  const byName = (a: UpcomingCoin, b: UpcomingCoin) => a.name.localeCompare(b.name);
  const primary = (a: UpcomingCoin, b: UpcomingCoin): number => {
    switch (sortKey) {
      case "expected":
        return compareWithMissingLast(dateScore(a.expectedLaunchDate), dateScore(b.expectedLaunchDate), dir);
      case "alphabetical":
        return byName(a, b) * dir;
      case "phase":
        return (PHASE_RANK[phaseOf(a)] - PHASE_RANK[phaseOf(b)]) * dir;
      case "peg":
        return pegLabel(a).localeCompare(pegLabel(b)) * dir;
      case "backing":
        return backingLabel(a).localeCompare(backingLabel(b)) * dir;
      case "drift":
        return (DRIFT_RANK[driftOf(a)] - DRIFT_RANK[driftOf(b)]) * dir;
      case "milestones":
        return ((a.milestones?.length ?? 0) - (b.milestones?.length ?? 0)) * dir;
    }
  };
  // Ties fall back to the soonest target, then name, so equal groups read in launch order.
  return [...coins].sort(
    (a, b) =>
      primary(a, b) ||
      compareWithMissingLast(dateScore(a.expectedLaunchDate), dateScore(b.expectedLaunchDate), 1) ||
      byName(a, b),
  );
}

function pegLabel(coin: UpcomingCoin): string {
  return PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency;
}

function backingLabel(coin: UpcomingCoin): string {
  return BACKING_LABELS_SHORT[coin.flags.backing] ?? coin.flags.backing;
}

/**
 * The tracker's one visitor-clock read. Static export renders without a clock,
 * so Slipped, Soonest, the rings and the drift column all appear after mount
 * and recompute at the next target expiry without a fetch.
 */
function usePreLaunchClockView(coins: readonly UpcomingCoin[]): PreLaunchClockView<UpcomingCoin> | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const now = Date.now();
      setNowMs(now);
      const next = selectPreLaunchClockView(coins, now).nextDeadlineMs;
      if (next != null) timer = window.setTimeout(update, Math.min(next - now, 2_147_483_647));
    };
    update();
    return () => window.clearTimeout(timer);
  }, [coins]);
  return useMemo(() => (nowMs === null ? null : selectPreLaunchClockView(coins, nowMs)), [coins, nowMs]);
}

/* tw: min-h-11 sm:min-h-8 — keep literal for Tailwind scanner */
const FILTER_TOUCH = "min-h-11 sm:min-h-8";

function filterPillClass(active: boolean): string {
  return active
    ? `pharos-control-pill pharos-control-pill-active ${FILTER_TOUCH} gap-1.5`
    : `pharos-toggle-pill ${FILTER_TOUCH} gap-1.5`;
}

const SLIPPAGE_SWATCH_PUSHED = "inline-block h-2.5 w-2.5 rounded-full ring-[1.5px] ring-state-warn-solid/80 ring-offset-1 ring-offset-background";
const SLIPPAGE_SWATCH_OVERDUE = "inline-block h-2.5 w-2.5 rounded-full ring-[1.5px] ring-state-danger-solid/85 ring-offset-1 ring-offset-background";

const UPCOMING_COLUMNS: readonly DataTableColumn<SortKey>[] = [
  { id: "coin", label: "Coin", sortKey: "alphabetical", sortLabel: "Coin" },
  { id: "phase", label: "Phase", sortKey: "phase", className: "hidden sm:table-cell" },
  { id: "peg", label: "Peg", sortKey: "peg", className: "hidden md:table-cell" },
  { id: "backing", label: "Backing", sortKey: "backing", className: "hidden md:table-cell" },
  { id: "expected", label: "Expected", sortKey: "expected", title: "Current launch target, read as a whole UTC period" },
  { id: "drift", label: "Drift", sortKey: "drift", title: "How the current target has moved" },
  { id: "milestones", label: "Milestones", sortKey: "milestones", className: "hidden lg:table-cell text-right" },
  { id: "details", label: <span className="sr-only">Details</span>, className: "w-8 px-0 sm:w-10" },
];

/**
 * Slipped's split doubles as the ring legend. A non-zero part carries its count
 * only when both parts are non-zero; otherwise it would repeat the Slipped figure.
 */
function SlippedSplit({ pushed, overdue }: { pushed: number; overdue: number }): React.JSX.Element {
  const both = pushed > 0 && overdue > 0;
  const part = (count: number, swatch: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={swatch} />
      {count === 0 || both ? <span className="pharos-numeric">{count}</span> : null}
      {label}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-2.5 font-sans">
      {part(pushed, SLIPPAGE_SWATCH_PUSHED, "pushed")}
      {part(overdue, SLIPPAGE_SWATCH_OVERDUE, "overdue")}
    </span>
  );
}

function ClockPending(): React.JSX.Element {
  return <span aria-hidden="true" className="inline-block h-3.5 w-12 animate-pulse rounded bg-muted align-middle" />;
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
  const schema = useMemo(() => createUpcomingUrlSchema(coins), [coins]);
  const { state: filters, patchState: writeFilters } = useUrlState(schema);
  const phaseFilter = useMemo(() => new Set(filters.phase), [filters.phase]);
  const pegFilter = useMemo(() => new Set(filters.peg), [filters.peg]);
  const backingFilter = useMemo(() => new Set(filters.backing), [filters.backing]);
  const clock = usePreLaunchClockView(coins);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const togglePhase = useCallback((phase: PhaseFilterValue) => {
    writeFilters({ phase: Array.from(toggleSet(phaseFilter, phase)) });
  }, [phaseFilter, writeFilters]);

  const togglePeg = useCallback((peg: string) => {
    writeFilters({ peg: Array.from(toggleSet(pegFilter, peg)) });
  }, [pegFilter, writeFilters]);

  const toggleBacking = useCallback((backing: string) => {
    writeFilters({ backing: Array.from(toggleSet(backingFilter, backing)) });
  }, [backingFilter, writeFilters]);

  const clearFilters = useCallback(() => writeFilters({ phase: [], peg: [], backing: [] }), [writeFilters]);

  const countBy = useCallback(
    <K extends string>(key: (coin: UpcomingCoin) => K) => {
      const counts = new Map<K, number>();
      for (const coin of coins) counts.set(key(coin), (counts.get(key(coin)) ?? 0) + 1);
      return counts;
    },
    [coins],
  );
  const phaseCounts = useMemo(() => countBy(phaseOf), [countBy]);
  const pegCounts = useMemo(() => countBy((coin) => coin.flags.pegCurrency), [countBy]);
  const backingCounts = useMemo(() => countBy((coin) => coin.flags.backing), [countBy]);
  const phaseOptions = useMemo(
    () => PHASE_FILTER_VALUES.filter((phase) => phase !== "unphased" || (phaseCounts.get(phase) ?? 0) > 0),
    [phaseCounts],
  );
  const allPegs = useMemo(
    () => [...pegCounts.keys()].sort((a, b) => (pegCounts.get(b) ?? 0) - (pegCounts.get(a) ?? 0)),
    [pegCounts],
  );
  const allBackings = useMemo(() => [...backingCounts.keys()], [backingCounts]);
  const noTargetCount = useMemo(() => coins.filter((coin) => !coin.expectedLaunchDate).length, [coins]);

  const sortKey = filters.sort;
  const sortDirection = filters.dir;
  const toggleSort = useCallback(
    (key: SortKey) => {
      const dir = key === sortKey ? (sortDirection === "asc" ? "desc" : "asc") : NATURAL_DIRECTION[key];
      writeFilters({ sort: key, dir });
    },
    [sortDirection, sortKey, writeFilters],
  );
  const getAriaSortValue = useCallback(
    (key: SortKey) => (key !== sortKey ? "none" : sortDirection === "asc" ? "ascending" : "descending"),
    [sortDirection, sortKey],
  );

  // Before mount there is no visitor clock: drift falls back to revision
  // history only (never "overdue"), and the drift cells render nothing.
  const driftOf = useCallback(
    (coin: UpcomingCoin): DriftDisplayStatus =>
      clock?.driftById.get(coin.id) ??
      resolveDriftDisplay(getDriftStatus(coin.dateHistory, undefined, 0), coin.expectedLaunchDate),
    [clock],
  );

  const filtered = useMemo(() => {
    const filteredCoins = coins.filter(
      (coin) =>
        (phaseFilter.size === 0 || phaseFilter.has(phaseOf(coin))) &&
        (pegFilter.size === 0 || pegFilter.has(coin.flags.pegCurrency)) &&
        (backingFilter.size === 0 || backingFilter.has(coin.flags.backing)),
    );
    return sortUpcomingCoins(filteredCoins, sortKey, sortDirection, driftOf);
  }, [backingFilter, coins, driftOf, pegFilter, phaseFilter, sortDirection, sortKey]);

  const activeFilterCount = phaseFilter.size + pegFilter.size + backingFilter.size;
  const hasActiveFilters = activeFilterCount > 0;

  const soonest = clock?.soonest ?? null;

  const toolbar = (
    <div className="pharos-table-toolbar gap-2.5">
      <div className="flex items-center justify-between gap-3 sm:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={filtersOpen}
          aria-controls="upcoming-filters"
          onClick={() => setFiltersOpen((open) => !open)}
          className="min-h-11 rounded-md border-border/70"
        >
          <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          Filters
          {hasActiveFilters ? <span className="pharos-numeric text-muted-foreground">({activeFilterCount})</span> : null}
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", filtersOpen ? "rotate-180" : "")}
          />
        </Button>
        <p className="pharos-meta pharos-numeric" aria-live="polite">
          {filtered.length} of {coins.length}
        </p>
      </div>
      <div
        id="upcoming-filters"
        className={cn(
          "flex-col gap-3 sm:flex sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2.5",
          filtersOpen ? "flex" : "hidden",
        )}
      >
        <div role="group" aria-label="Phase" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Phase</span>
          {phaseOptions.map((phase) => (
            <button
              type="button"
              key={phase}
              aria-pressed={phaseFilter.has(phase)}
              onClick={() => togglePhase(phase)}
              className={filterPillClass(phaseFilter.has(phase))}
            >
              {phase === "unphased" ? "Unphased" : LAUNCH_PHASE_LABELS[phase]}
              <span className="pharos-numeric text-muted-foreground">{phaseCounts.get(phase) ?? 0}</span>
            </button>
          ))}
        </div>
        {allPegs.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 self-start rounded-md border-border/70 sm:min-h-8 sm:self-auto"
              >
                Peg
                {pegFilter.size > 0 ? (
                  <span className="pharos-numeric text-muted-foreground">({pegFilter.size})</span>
                ) : null}
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-52 overflow-y-auto">
              {allPegs.map((peg) => (
                <DropdownMenuCheckboxItem
                  key={peg}
                  checked={pegFilter.has(peg)}
                  onCheckedChange={() => togglePeg(peg)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex-1">{PEG_LABELS_SHORT[peg] ?? peg}</span>
                  <span className="pharos-numeric text-xs text-muted-foreground">{pegCounts.get(peg) ?? 0}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {allBackings.length > 1 ? (
          <div role="group" aria-label="Backing" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Backing</span>
            {allBackings.map((backing) => (
              <button
                type="button"
                key={backing}
                aria-pressed={backingFilter.has(backing)}
                onClick={() => toggleBacking(backing)}
                className={filterPillClass(backingFilter.has(backing))}
              >
                {BACKING_LABELS_SHORT[backing] ?? backing}
                <span className="pharos-numeric text-muted-foreground">{backingCounts.get(backing) ?? 0}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center gap-3 sm:ml-auto">
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="pharos-focus-ring min-h-11 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-0"
            >
              Clear filters
            </button>
          ) : null}
          <p className="pharos-meta pharos-numeric hidden sm:block" aria-live="polite">
            {filtered.length} of {coins.length}
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <FeatureHeroSplit
        ariaLabel="Pre-launch stablecoin readiness"
        layout="stacked"
        beamLabel="Tracked launches"
        beamValue={coins.length}
        universe={<UniverseChip universe="preLaunch" value="not yet live" />}
        sub={
          <div className="divide-y divide-border/50">
            <HeroMetricRow
              label="Soonest open target"
              value={
                clock === null ? (
                  <ClockPending />
                ) : soonest?.expectedLaunchDate ? (
                  <Link
                    href={buildStablecoinUrl(soonest.id)}
                    className="pharos-focus-ring rounded-sm font-sans hover:underline hover:underline-offset-4"
                  >
                    {soonest.name}
                  </Link>
                ) : (
                  "—"
                )
              }
              detail={soonest?.expectedLaunchDate ? formatFuzzyDate(soonest.expectedLaunchDate) : undefined}
            />
            <HeroMetricRow
              label="Slipped"
              value={clock === null ? <ClockPending /> : clock.slipped}
              detail={clock === null ? undefined : <SlippedSplit pushed={clock.pushed} overdue={clock.overdue} />}
            />
            <HeroMetricRow label="No target date" value={noTargetCount} />
          </div>
        }
      >
        <UpcomingHorizonHero driftById={clock?.driftById} />
      </FeatureHeroSplit>

      <section id="data" aria-label="Pre-launch stablecoins" tabIndex={-1} className="space-y-4 outline-none">
        <DataTableShell
          tableId="upcoming-table"
          testId="upcoming-table"
          columns={UPCOMING_COLUMNS}
          sort={{ sortKey, sortDirection, toggleSort, getAriaSortValue }}
          topSlot={toolbar}
          mobileScrollHint={false}
          tableClassName="w-full"
        >
          {filtered.length === 0 ? (
            <DataTableEmptyRow colSpan={UPCOMING_COLUMNS.length}>
              <span className="flex flex-col items-center gap-3">
                No pre-launch coins match. Drop a filter or two.
                <button
                  type="button"
                  onClick={clearFilters}
                  className="pharos-focus-ring rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear filters
                </button>
              </span>
            </DataTableEmptyRow>
          ) : (
            filtered.map((coin) => (
              <UpcomingRow
                key={coin.id}
                coin={coin}
                logoSrc={getLogoSrc(logos, coin.id)}
                teaser={teasers[coin.id]}
                drift={clock ? driftOf(coin) : null}
                expanded={expandedId === coin.id}
                onToggle={() => setExpandedId((current) => (current === coin.id ? null : coin.id))}
              />
            ))
          )}
        </DataTableShell>

        <ModuleDisclosure label="How targets and drift are read">
          <div className="mt-2 max-w-3xl space-y-2 text-sm leading-relaxed text-muted-foreground">
            <p>
              A target is the launch window the issuer has stated. A year, half, quarter, month or day covers that
              whole UTC period; Pharos never reads it as a precise launch date. Coins with no stated target show “—”.
            </p>
            <p>
              A target expires at the UTC midnight after its period ends. Drift compares the current target with its
              revision history: <span className="text-foreground">Pushed once</span> means it replaced one earlier
              target, <span className="text-foreground">Delayed</span> two or more, and{" "}
              <span className="text-foreground">Overdue</span> means the period ended without a launch. A coin whose
              earlier target was retired and none set shows <span className="text-foreground">No current target</span>:
              with nothing to slip against, it is not counted as slipped.
            </p>
            <p>
              Slipped counts coins with a current target that was pushed, delayed or is overdue. On the constellation an amber ring marks a moved target
              and a red ring an expired one; coins folded into a “+N” marker are tallied on it. Drift is read on your
              device clock, so it updates at the next expiry without a refresh.
            </p>
            <p>Unphased coins are tracked before Pharos has assigned them a launch phase.</p>
          </div>
        </ModuleDisclosure>
      </section>
    </div>
  );
}

function UpcomingRow({
  coin,
  logoSrc,
  teaser,
  drift,
  expanded,
  onToggle,
}: {
  coin: UpcomingCoin;
  logoSrc: string | undefined;
  teaser: string | undefined;
  /** Null until the visitor clock is read. */
  drift: DriftDisplayStatus | null;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const href = buildStablecoinUrl(coin.id);
  const detailsId = `upcoming-details-${coin.id}`;
  const milestoneCount = coin.milestones?.length ?? 0;
  const teaserText = teaser ? stripTermMarkup(teaser) : null;

  return (
    <Fragment>
      <TableRow
        className={cn("group cursor-pointer", expanded ? "bg-muted/40" : "")}
        onClick={(event) => {
          // Links and the toggle handle their own clicks; a tap elsewhere on the
          // row is a convenience over the chevron.
          if ((event.target as HTMLElement).closest("a, button")) return;
          onToggle();
        }}
      >
        <TableCell className="max-w-[8.5rem] sm:max-w-none">
          <div className="flex min-w-0 items-center gap-2.5">
            <StablecoinLogo src={logoSrc} name={coin.name} size={20} />
            <div className="min-w-0">
              <Link
                href={href}
                className="pharos-focus-ring block truncate rounded-sm text-sm font-medium text-foreground hover:underline hover:underline-offset-4"
              >
                {coin.name}
              </Link>
              <span className="flex items-center gap-1.5 font-mono text-3xs text-muted-foreground">
                {coin.launchPhase ? (
                  <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-[2px] sm:hidden ${PHASE_DOT[coin.launchPhase]}`} />
                ) : null}
                {coin.symbol}
              </span>
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          {coin.launchPhase ? (
            <LaunchPhaseBadge phase={coin.launchPhase} />
          ) : (
            <span className="text-xs text-muted-foreground">Unphased</span>
          )}
        </TableCell>
        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
          {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
        </TableCell>
        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
          {BACKING_LABELS_SHORT[coin.flags.backing] ?? coin.flags.backing}
        </TableCell>
        <TableCell className="pharos-numeric whitespace-nowrap text-xs text-foreground">
          {coin.expectedLaunchDate ? (
            formatFuzzyDate(coin.expectedLaunchDate)
          ) : (
            <span className="text-muted-foreground" title="No stated launch target">—</span>
          )}
        </TableCell>
        {/* Phones let the longest badge ("No current target") wrap so the chevron stays on screen. */}
        <TableCell className="max-w-[5.75rem] whitespace-normal sm:max-w-none sm:whitespace-nowrap">
          {drift === null ? null : drift === "on-track" ? (
            <span className="text-2xs text-muted-foreground/80">{coin.expectedLaunchDate ? "On track" : "—"}</span>
          ) : (
            <LaunchDriftBadge status={drift} />
          )}
        </TableCell>
        <TableCell className="pharos-numeric hidden text-right text-xs text-muted-foreground lg:table-cell">
          {milestoneCount > 0 ? milestoneCount : "—"}
        </TableCell>
        <TableCell className="w-8 px-0 text-right sm:w-10 sm:pr-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? "Hide" : "Show"} details for ${coin.name}`}
            onClick={onToggle}
            className="pharos-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", expanded ? "rotate-180" : "")}
            />
          </button>
        </TableCell>
      </TableRow>
      {/* Always mounted (hidden when collapsed) so the chevron's aria-controls resolves. */}
      <TableRow rowIntent="static" id={detailsId} hidden={!expanded} className="bg-muted/20 hover:bg-muted/20">
        <TableCell colSpan={UPCOMING_COLUMNS.length} className="whitespace-normal px-4 py-3 sm:pl-12">
          <div className="max-w-3xl space-y-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {teaserText ?? "No summary written yet; the dossier carries the sourced milestones."}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
              {coin.launchPhase ? <LaunchPhaseBadge phase={coin.launchPhase} /> : <span>Unphased</span>}
              <span>{PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}</span>
              <span aria-hidden="true">·</span>
              <span>{BACKING_LABELS_SHORT[coin.flags.backing] ?? coin.flags.backing}</span>
              <span aria-hidden="true">·</span>
              <span>{GOVERNANCE_LABELS_SHORT[coin.flags.governance] ?? coin.flags.governance}</span>
              {coin.announcedDate ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Announced <span className="pharos-numeric">{formatFuzzyDate(coin.announcedDate)}</span>
                  </span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              <span>
                <span className="pharos-numeric">{milestoneCount}</span> milestone{milestoneCount === 1 ? "" : "s"}
              </span>
            </p>
            <Link
              href={href}
              className="pharos-focus-ring inline-flex rounded-sm text-xs font-medium text-foreground underline-offset-4 hover:underline"
            >
              Open the pre-launch dossier &rarr;
            </Link>
          </div>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}
