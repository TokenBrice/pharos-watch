import { House } from "lucide-react";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { cn } from "@/lib/utils";
import {
  BRIDGE_TIER_CELL_CLASSES,
  BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES,
  BRIDGE_TIER_POLICY_ORDER,
  BRIDGE_TIER_UNKNOWN_CELL_CLASS,
  CONTROL_COMPONENT_ROLE_LABELS,
  type ControlComponentRole,
} from "@shared/lib/classification";
import type { BridgeRouteRiskTier } from "@shared/types";

export type DeploymentCellRole = Extract<ControlComponentRole, "limiting" | "eligible" | "diagnostic">;

export interface DeploymentStripCell {
  key: string;
  /** Chain or route name ("Ethereum", "Plasma OFT"). */
  label: string;
  /** Bridge route tier key (`BridgeRouteRiskTier`); an unrecognised key draws as unknown. */
  tierKey: string;
  tierLabel: string;
  /**
   * Relation to the Control minimum. Only `limiting` is outlined;
   * `diagnostic` (outside the eligible set) is dashed in its tier's hue;
   * absent makes no claim.
   */
  role?: DeploymentCellRole;
  home?: boolean;
  /** Tier not established for this deployment: hatched, whatever `tierKey` says. */
  unknown?: boolean;
  /** Relative supply weight. Widths follow weights only when every cell has one. */
  weight?: number | null;
}

export interface DeploymentStripBracket {
  key: string;
  /** Shared failure domain, already deduped by the caller ("LayerZero V2 ×3"). */
  label: string;
  cellKeys: readonly string[];
  /** Quantified share ("10.8%", or a lower bound "≥21%"); absent reads "share unquantified", never a percent. */
  shareLabel?: string;
  /** Qualifies `shareLabel` ("1 unquantified" when part of the domain has no share); ignored without it. */
  shareNote?: string;
}

export interface DeploymentStripProps {
  cells: readonly DeploymentStripCell[];
  brackets?: readonly DeploymentStripBracket[];
  /** Names the strip ("USDe deployments by bridge tier"). */
  ariaLabel: string;
  /**
   * Inventory total per tier label, for cells that are a sample of a larger
   * inventory. The legend then counts every route, not the drawn cells; it
   * falls back to cell counts unless every legend label has a total.
   */
  legendTotals?: Readonly<Record<string, number>>;
  /**
   * Caller caveats ("40 of 88 routes drawn…"), set on the strip's one caveat
   * line before its own equal-width note. Lower-case fragments; the line
   * capitalises its first letter.
   */
  caveats?: readonly string[];
  /**
   * Caption of a limiting input (plan §6) that no single cell carries, such
   * as the engine's unverified-bridge fallback ("Bridge controls
   * unverified"). The whole cell band takes the limiting outline and the
   * legend's limiting key carries the caption, so tier fills never read as
   * safe beside a limiting score.
   */
  bandLimiting?: string;
  className?: string;
}

/** Up to this many cells, every wide-enough cell carries its own name. */
const INLINE_LABEL_LIMIT = 6;
/** A weighted cell narrower than this share of the strip drops its inline name. */
const MIN_INLINE_LABEL_SHARE = 0.12;
/** Past this many cells the gutters shrink to a hairline so the strip stays one band. */
const DENSE_CELL_COUNT = 16;

const SPLIT_CAVEAT = "equal widths, supply split unavailable";
const SWATCH_CLASS = "h-3 w-3 shrink-0 rounded-[2px]";
/** The §6 limiting outline, shared by a limiting cell, the whole band and the legend key. */
const LIMITING_OUTLINE_CLASS = "outline-2 outline-offset-1 outline-foreground";

/** The cell's reviewed tier; null when it is not established or not a published tier. */
function resolveTier(cell: DeploymentStripCell): BridgeRouteRiskTier | null {
  return !cell.unknown && Object.hasOwn(BRIDGE_TIER_CELL_CLASSES, cell.tierKey)
    ? (cell.tierKey as BridgeRouteRiskTier)
    : null;
}

/** The tier's own fill, whatever the cell's role: the legend keys hue by it. */
function resolveTierFillClass(cell: DeploymentStripCell): string {
  const tier = resolveTier(cell);
  return tier === null ? BRIDGE_TIER_UNKNOWN_CELL_CLASS : BRIDGE_TIER_CELL_CLASSES[tier];
}

/** What the cell draws: a diagnostic takes the dashed treatment of its tier's hue. */
function resolveCellClass(cell: DeploymentStripCell): string {
  if (cell.role !== "diagnostic") return resolveTierFillClass(cell);
  return BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES[resolveTier(cell) ?? "opaque-or-unknown"];
}

function formatShare(share: number): string {
  const pct = share * 100;
  return pct > 0 && pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

interface ResolvedBracket {
  bracket: DeploymentStripBracket;
  memberCount: number;
  /** Contiguous column runs as [first, last] cell indices. */
  runs: [number, number][];
}

function resolveBrackets(
  brackets: readonly DeploymentStripBracket[],
  indexByKey: ReadonlyMap<string, number>,
): ResolvedBracket[] {
  const resolved: ResolvedBracket[] = [];
  for (const bracket of brackets) {
    const indices = [...new Set(bracket.cellKeys.flatMap((key) => {
      const index = indexByKey.get(key);
      return index === undefined ? [] : [index];
    }))].sort((a, b) => a - b);
    if (indices.length === 0) continue;
    const runs: [number, number][] = [];
    for (const index of indices) {
      const last = runs.at(-1);
      if (last && index === last[1] + 1) last[1] = index;
      else runs.push([index, index]);
    }
    resolved.push({ bracket, memberCount: indices.length, runs });
  }
  // Earlier spans first; at the same start, the wider bracket sits higher.
  return resolved.sort((a, b) => {
    const spanA = a.runs.at(-1)![1] - a.runs[0]![0];
    const spanB = b.runs.at(-1)![1] - b.runs[0]![0];
    return a.runs[0]![0] - b.runs[0]![0] || spanB - spanA;
  });
}

interface LegendEntry {
  swatchClass: string;
  labels: string[];
  count: number;
}

interface NameSlot {
  index: number;
  gridColumn: string;
  align: "start" | "end" | "center";
  named: boolean;
}

const NAME_SLOT_ALIGN_CLASS: Record<NameSlot["align"], string> = {
  start: "justify-start",
  end: "justify-end",
  center: "justify-center",
};

/**
 * One cell per chain or route, filled by bridge tier in published
 * `bridgeTierQuality` order. An opaque or unestablished tier is hatched; only
 * a route at the Control minimum (`role: "limiting"`) is outlined, and a
 * route outside the eligible set is drawn dashed in its tier's hue. A
 * limiting input no cell carries (`bandLimiting`) outlines the whole band.
 * Shared failure domains bracket the cells they span; an unquantified share
 * reads "share unquantified".
 *
 * The legend keys hue by tier (solid swatches, inventory totals when the
 * caller passes them) and keys the role channels with the cells' own
 * treatment: the outline for limiting (captioned for a band), the dashed
 * tier fill for diagnostics.
 *
 * Widths follow supply weights only when every cell carries one; otherwise
 * cells are equal and the caveat line says the split is unavailable. One
 * band from 1 to 40 cells: names inline up to six cells, then only the home
 * chain; the full roster is the screen-reader list.
 */
export function DeploymentStrip({
  cells,
  brackets = [],
  ariaLabel,
  legendTotals,
  caveats = [],
  bandLimiting,
  className,
}: DeploymentStripProps) {
  if (cells.length === 0) return null;

  const weightTotal = cells.reduce((sum, cell) => sum + (cell.weight ?? 0), 0);
  const splitKnown = weightTotal > 0
    && cells.every((cell) => typeof cell.weight === "number" && Number.isFinite(cell.weight) && cell.weight >= 0);
  const shares = cells.map((cell) => (splitKnown ? cell.weight! / weightTotal : 1 / cells.length));

  const indexByKey = new Map(cells.map((cell, index) => [cell.key, index]));
  const resolvedBrackets = resolveBrackets(brackets, indexByKey);
  const cellRow = resolvedBrackets.length + 1;
  const homeIndices = cells.flatMap((cell, index) => (cell.home ? [index] : []));
  const inlineLabels = cells.length <= INLINE_LABEL_LIMIT;

  // Legend in policy order; unrecognised tiers, then unestablished ones, last.
  const policyOrder: readonly string[] = BRIDGE_TIER_POLICY_ORDER;
  const legend = new Map<string, LegendEntry>();
  const legendOrder = cells
    .map((cell) => {
      const policyIndex = policyOrder.indexOf(cell.tierKey);
      return { cell, rank: cell.unknown ? policyOrder.length + 1 : policyIndex === -1 ? policyOrder.length : policyIndex };
    })
    .sort((a, b) => a.rank - b.rank);
  for (const { cell } of legendOrder) {
    const swatchClass = resolveTierFillClass(cell);
    const entry = legend.get(swatchClass) ?? { swatchClass, labels: [], count: 0 };
    if (!entry.labels.includes(cell.tierLabel)) entry.labels.push(cell.tierLabel);
    entry.count += 1;
    legend.set(swatchClass, entry);
  }
  const totals = legendTotals ?? null;
  const countsAreTotals = totals !== null
    && [...legend.values()].every((entry) => entry.labels.every((label) => Object.hasOwn(totals, label)));
  const hasLimiting = bandLimiting !== undefined || cells.some((cell) => cell.role === "limiting");
  const firstDiagnostic = cells.find((cell) => cell.role === "diagnostic");

  const caveatLine = [...caveats, !splitKnown && cells.length > 1 ? SPLIT_CAVEAT : null]
    .filter((part): part is string => part !== null && part !== "");

  const gridStyle = {
    gridTemplateColumns: splitKnown
      ? cells.map((cell) => `minmax(3px,${cell.weight}fr)`).join(" ")
      : `repeat(${cells.length},minmax(0,1fr))`,
  };

  // Name row: every wide-enough cell up to six cells; past that only the home
  // chain, named when there is one and glyph-only when there are several.
  const nameSlots: NameSlot[] = inlineLabels
    ? cells.flatMap((cell, index) =>
        cell.home || shares[index]! >= MIN_INLINE_LABEL_SHARE
          ? [{ index, gridColumn: `${index + 1}`, align: "start" as const, named: true }]
          : [],
      )
    : homeIndices.length === 1
      ? [
          homeIndices[0]! < cells.length / 2
            ? { index: homeIndices[0]!, gridColumn: `${homeIndices[0]! + 1} / -1`, align: "start", named: true }
            : { index: homeIndices[0]!, gridColumn: `1 / ${homeIndices[0]! + 2}`, align: "end", named: true },
        ]
      : homeIndices.map((index) => ({ index, gridColumn: `${index + 1}`, align: "center" as const, named: false }));

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-widths={splitKnown ? "weighted" : "equal"}
      className={cn("min-w-0 space-y-2", className)}
    >
      <div aria-hidden="true" className="space-y-2.5">
        <div
          className={cn("grid gap-y-1", cells.length > DENSE_CELL_COUNT ? "gap-x-px" : "gap-x-0.5")}
          style={gridStyle}
        >
          {resolvedBrackets.flatMap(({ bracket, runs }, lane) =>
            runs.map(([first, last], runIndex) => (
              <div
                key={`${bracket.key}:${first}`}
                data-bracket={bracket.key}
                style={{ gridColumn: `${first + 1} / ${last + 2}`, gridRow: lane + 1 }}
                className={cn(
                  "flex min-w-0 flex-col justify-end gap-0.5",
                  first + 1 > cells.length / 2 ? "items-end" : "items-start",
                )}
              >
                {runIndex === 0 ? (
                  <span className="whitespace-nowrap text-[11px] leading-[14px] text-muted-foreground">
                    {bracket.label}{" "}
                    {bracket.shareLabel ? (
                      <span data-bracket-share="">
                        <span className="font-mono tabular-nums text-foreground">{bracket.shareLabel}</span>
                        {bracket.shareNote ? ` · ${bracket.shareNote}` : null}
                      </span>
                    ) : (
                      <span data-bracket-share="">share unquantified</span>
                    )}
                  </span>
                ) : null}
                <span className="h-1.5 w-full rounded-t-[3px] border-x border-t border-foreground/45" />
              </div>
            )),
          )}
          {cells.map((cell, index) => {
            const tier = resolveTier(cell);
            return (
              <span
                key={cell.key}
                data-cell={cell.key}
                data-role={cell.role}
                data-outlined={cell.role === "limiting" ? "" : undefined}
                data-hatched={tier === null || tier === "opaque-or-unknown" ? "" : undefined}
                title={`${cell.label} · ${cell.tierLabel}${cell.role ? ` · ${CONTROL_COMPONENT_ROLE_LABELS[cell.role]}` : ""}`}
                style={{ gridColumn: index + 1, gridRow: cellRow }}
                className={cn(
                  "h-4 min-w-0 rounded-[3px]",
                  resolveCellClass(cell),
                  cell.role === "limiting" && cn("relative z-10", LIMITING_OUTLINE_CLASS),
                )}
              />
            );
          })}
          {bandLimiting !== undefined ? (
            <span
              data-band-outlined=""
              style={{ gridColumn: "1 / -1", gridRow: cellRow }}
              className={cn("pointer-events-none relative z-10 h-4 rounded-[3px]", LIMITING_OUTLINE_CLASS)}
            />
          ) : null}
          {nameSlots.map((slot) => {
            const cell = cells[slot.index]!;
            return (
              <span
                key={cell.key}
                style={{ gridColumn: slot.gridColumn, gridRow: cellRow + 1 }}
                className={cn(
                  "flex min-w-0 items-center gap-1 text-[11px] leading-[14px]",
                  cell.home ? "text-foreground" : "text-muted-foreground",
                  NAME_SLOT_ALIGN_CLASS[slot.align],
                )}
              >
                {cell.home ? <House data-home-glyph="" className="h-3 w-3 shrink-0" /> : null}
                {slot.named ? <span className="truncate">{cell.label}</span> : null}
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] leading-4 text-muted-foreground">
          {[...legend.values()].map((entry) => (
            <span key={entry.swatchClass} data-legend-entry="" className="inline-flex items-center gap-1.5">
              <span className={cn(SWATCH_CLASS, entry.swatchClass)} />
              <span className="text-foreground">{entry.labels.join(" / ")}</span>
              {cells.length > 1 ? (
                <span data-legend-count="" className="font-mono tabular-nums">
                  {countsAreTotals
                    ? entry.labels.reduce((sum, label) => sum + (totals?.[label] ?? 0), 0)
                    : entry.count}
                </span>
              ) : null}
            </span>
          ))}
          {hasLimiting ? (
            <span data-legend-role="limiting" className="inline-flex items-center gap-1.5">
              <span className={cn(SWATCH_CLASS, LIMITING_OUTLINE_CLASS)} />
              <ControlRoleTag role="limiting" size="compact" />
              {bandLimiting !== undefined ? <span className="text-foreground">{bandLimiting}</span> : null}
            </span>
          ) : null}
          {firstDiagnostic ? (
            <span data-legend-role="diagnostic" className="inline-flex items-center gap-1.5">
              <span className={cn(SWATCH_CLASS, resolveCellClass(firstDiagnostic))} />
              <ControlRoleTag role="diagnostic" size="compact" />
            </span>
          ) : null}
          {homeIndices.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <House className="h-3 w-3 shrink-0 text-foreground" />
              Home chain
            </span>
          ) : null}
        </div>
      </div>
      {caveatLine.length > 0 ? (
        <p data-strip-caveats="" className="text-[11px] leading-snug text-muted-foreground">
          {caveatLine.map((part, index) => (
            <span key={part} data-split-caption={part === SPLIT_CAVEAT ? "" : undefined}>
              {index > 0 ? " · " : null}
              {index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part}
            </span>
          ))}
        </p>
      ) : null}
      {bandLimiting !== undefined ? (
        <p className="sr-only">{`${bandLimiting}: ${CONTROL_COMPONENT_ROLE_LABELS.limiting}, across every deployment`}</p>
      ) : null}
      <ul className="sr-only">
        {cells.map((cell, index) => (
          <li key={cell.key}>
            {[
              `${cell.label}: ${cell.tierLabel}`,
              cell.unknown ? "tier not established" : null,
              cell.role ? CONTROL_COMPONENT_ROLE_LABELS[cell.role] : null,
              cell.home ? "home chain" : null,
              splitKnown ? `${formatShare(shares[index]!)} of supply` : null,
            ]
              .filter((part): part is string => part != null)
              .join(", ")}
          </li>
        ))}
      </ul>
      {resolvedBrackets.length > 0 ? (
        <ul className="sr-only" aria-label="Shared failure domains">
          {resolvedBrackets.map(({ bracket, memberCount }) => (
            <li key={bracket.key}>
              {`${bracket.label}: spans ${memberCount === 1 ? "1 deployment" : `${memberCount} deployments`}, ${
                bracket.shareLabel ? `share ${bracket.shareLabel}${bracket.shareNote ? `, ${bracket.shareNote}` : ""}` : "share unquantified"
              }`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
