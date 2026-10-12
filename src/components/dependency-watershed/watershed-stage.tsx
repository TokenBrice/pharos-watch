"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatCurrency } from "@shared/lib/format";
import { DEPENDENCY_TYPE_PRESENTATION } from "@/components/contagion-graph-model";
import { ChartTooltipSurface } from "@/components/pharos-chart-tooltip";
import type { WatershedDelta, WatershedModel, WatershedNode, WatershedRibbon } from "@/lib/dependency-watershed/model";
import styles from "./watershed.module.css";

export type WatershedReadyModel = Extract<WatershedModel, { ok: true }>;
export type WatershedRelationshipFilter = "all" | "collateral" | "wrapper";

const WRAPPER_FORM_LABELS: Record<string, string> = {
  "strategy-vault": "Strategy vault",
  "native-staked": "Native staked",
  pure: "Pure wrapper",
};

function watershedDeltaChip(delta: WatershedDelta): string {
  const count = `${delta.leafIds.length}${delta.remainder ? " more" : ""} folded ${delta.leafIds.length === 1 ? "leaf" : "leaves"}`;
  const known = delta.leafIds.length > delta.unknownCount ? ` · ${formatCurrency(delta.knownUsd, 2)}` : " · USD unknown";
  return `${count}${known}${delta.unknownCount > 0 && delta.leafIds.length > delta.unknownCount ? ` (+${delta.unknownCount} unknown)` : ""}`;
}

function watershedRibbonSummary(ribbon: WatershedRibbon, labelOf: (id: string) => string): string {
  const usd = ribbon.usd === null ? "USD unknown" : formatCurrency(ribbon.usd, 2);
  return `${labelOf(ribbon.to)} supply mapped to ${labelOf(ribbon.from)}: ${usd}`;
}

function hubName(node: WatershedNode, known: boolean, labelOf: (id: string) => string): string {
  const exposure = node.exposure!;
  return `${labelOf(node.id)}: ${known ? `${formatCurrency(exposure.direct.knownUsd, 2)}${exposure.direct.complete ? "" : " (known only)"} direct mapped dependent supply` : "direct USD unavailable"} across ${exposure.dependentCount} direct ${exposure.dependentCount === 1 ? "dependent" : "dependents"}`;
}

type HoverRibbon = { ribbon: WatershedRibbon; x: number; y: number };

function markClass(lit: ReadonlyMap<string, number> | null, litNow: boolean): string {
  return `${styles.mark} ${lit && !litNow ? styles.dimmed : ""} ${lit && litNow ? styles.lit : ""}`;
}

const RibbonLayer = memo(function RibbonLayer({ model, lit, relationship, onHover }: {
  model: WatershedReadyModel;
  lit: ReadonlyMap<string, number> | null;
  relationship: WatershedRelationshipFilter;
  onHover: (hover: HoverRibbon | null) => void;
}) {
  const hop = (id: string) => lit?.get(id);
  return (
    <g aria-hidden="true">
      {model.ribbons.map(ribbon => {
        const litNow = hop(ribbon.from) !== undefined && hop(ribbon.to) !== undefined;
        const className = `${markClass(lit, litNow)} ${relationship !== "all" && ribbon.relationship !== relationship ? styles.filteredOut : ""}`;
        const line = ribbon.width <= 1.5;
        const shapeClass = ribbon.unknown ? styles.lineUnknown : line ? ribbon.relationship === "wrapper" ? styles.lineWrapper : styles.lineCollateral : ribbon.relationship === "wrapper" ? styles.ribbonWrapper : styles.ribbonCollateral;
        return (
          <g key={ribbon.key} className={className} style={{ ["--hop" as string]: hop(ribbon.to) ?? 0 }}
            onPointerMove={event => { const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect(); onHover({ ribbon, x: event.clientX - box.left, y: event.clientY - box.top }); }}
            onPointerLeave={() => onHover(null)}>
            <path d={line || ribbon.unknown ? ribbon.centerline : ribbon.path} className={`${shapeClass} ${litNow && lit ? styles.lit : ""}`} strokeWidth={line || ribbon.unknown ? 1 : undefined} />
            {(line || ribbon.unknown) && <path d={ribbon.centerline} stroke="transparent" strokeWidth={8} fill="none" />}
            {ribbon.unknown && <text x={ribbon.end.x - 7} y={ribbon.end.y - 2} className={styles.unknownCap}>?</text>}
          </g>
        );
      })}
      {model.deltas.map(delta => (
        <path key={delta.hubId} d={delta.path} className={`${styles.delta} ${markClass(lit, hop(delta.hubId) !== undefined)}`} style={{ ["--hop" as string]: (hop(delta.hubId) ?? 0) + 1 }} />
      ))}
    </g>
  );
});

/** Labels sit above every link on a card-coloured halo; the hub's hit area handles pointer input. */
const LabelLayer = memo(function LabelLayer({ model, lit, labelOf }: {
  model: WatershedReadyModel;
  lit: ReadonlyMap<string, number> | null;
  labelOf: (id: string) => string;
}) {
  const { layout } = model;
  const deltaByHub = useMemo(() => new Map(model.deltas.map(delta => [delta.hubId, delta])), [model]);
  return (
    <g aria-hidden="true" pointerEvents="none">
      {model.nodes.map(node => {
        const delta = deltaByHub.get(node.id);
        const litNow = lit?.get(node.id) !== undefined;
        return (
          <g key={node.id} className={markClass(lit, litNow)} style={{ ["--hop" as string]: lit?.get(node.id) ?? 0 }}>
            <text x={node.x + layout.barWidth + 5} y={node.y + 10} className={node.kind === "hub" ? styles.label : styles.leafLabel}>
              {labelOf(node.id)}
              {node.showFigure && <tspan className={styles.figure} dx={5}>{node.exposure!.direct.complete ? "" : "≥"}{formatCurrency(node.exposure!.direct.knownUsd, 2)}</tspan>}
            </text>
            {delta && (
              <text x={node.x + layout.barWidth + layout.deltaStub + 4} y={Math.max(delta.top + delta.width / 2 + 3.5, node.y + 22)} className={styles.chip}>
                {watershedDeltaChip(delta)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

export function WatershedStage({ model, lit, roots, relationship, labelOf, previewTooltip, onPreview, onCommit, onClear }: {
  model: WatershedReadyModel;
  /** Minimum hop per reached coin (roots are hop 0); null when nothing is selected. */
  lit: ReadonlyMap<string, number> | null;
  roots: ReadonlySet<string>;
  relationship: WatershedRelationshipFilter;
  labelOf: (id: string) => string;
  previewTooltip: ReactNode;
  onPreview: (id: string | null) => void;
  onCommit: (id: string) => void;
  /** Escape: drop the in-place pin. */
  onClear?: () => void;
}) {
  const { layout } = model;
  const hubs = useMemo(() => model.nodes.filter(node => node.kind === "hub"), [model]);
  const nodeById = useMemo(() => new Map(model.nodes.map(node => [node.id, node])), [model]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [hoverRibbon, setHoverRibbon] = useState<HoverRibbon | null>(null);
  // Pointer moves coalesce to one tooltip update per frame; the memoized layers do not re-render.
  const frame = useRef<number | null>(null);
  const pending = useRef<HoverRibbon | null>(null);
  const onRibbonHover = useCallback((hover: HoverRibbon | null) => {
    pending.current = hover;
    if (hover === null) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setHoverRibbon(null);
      return;
    }
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; setHoverRibbon(pending.current); });
  }, []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const [hoverLeaf, setHoverLeaf] = useState<WatershedNode | null>(null);
  const tabStop = focusId !== null && nodeById.has(focusId) ? focusId : hubs[0]?.id ?? null;
  const hop = (id: string) => lit?.get(id);

  const preview = (id: string | null) => { setAnchorId(id); onPreview(id); };
  const moveFocus = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    preview(id);
    document.querySelector<SVGGElement>(`[data-watershed-hub="${CSS.escape(id)}"]`)?.focus();
  };
  const strongest = (id: string, direction: "up" | "down") => model.ribbons
    .filter(ribbon => direction === "up" ? ribbon.to === id && nodeById.get(ribbon.from)?.kind === "hub" : ribbon.from === id && nodeById.get(ribbon.to)?.kind === "hub")
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.key.localeCompare(b.key))[0];
  const onKeyDown = (event: KeyboardEvent<SVGGElement>, node: WatershedNode) => {
    const column = hubs.filter(hub => hub.column === node.column);
    const index = column.findIndex(hub => hub.id === node.id);
    if (event.key === "ArrowDown") moveFocus(column[index + 1]?.id);
    else if (event.key === "ArrowUp") moveFocus(column[index - 1]?.id);
    else if (event.key === "ArrowLeft") moveFocus(strongest(node.id, "up")?.from);
    else if (event.key === "ArrowRight") moveFocus(strongest(node.id, "down")?.to);
    else if (event.key === "Enter" || event.key === " ") onCommit(node.id);
    else if (event.key === "Escape") { preview(null); onClear?.(); }
    else return;
    event.preventDefault();
  };

  const anchor = anchorId ? nodeById.get(anchorId) : undefined;
  return (
    <div className={styles.stage} style={{ ["--ws-collateral" as string]: DEPENDENCY_TYPE_PRESENTATION.collateral.color, ["--ws-wrapper" as string]: DEPENDENCY_TYPE_PRESENTATION.wrapper.color }} onPointerLeave={() => { onRibbonHover(null); setHoverLeaf(null); }}>
      <svg
        role="group"
        aria-label={`Dependency watershed, ${hubs.length} hubs in ${model.columns.length} layers`}
        width={model.width}
        height={model.height}
        viewBox={`0 0 ${model.width} ${model.height}`}
        className="block max-w-none"
      >
        <defs aria-hidden="true">
          <pattern id="ws-wrapper-texture" width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill={DEPENDENCY_TYPE_PRESENTATION.wrapper.color} fillOpacity="0.3" />
            <circle cx="2" cy="2" r="0.9" fill={DEPENDENCY_TYPE_PRESENTATION.wrapper.color} />
          </pattern>
          <pattern id="ws-wrapper-texture-lit" width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" style={{ fill: "var(--ws-beam)", fillOpacity: 0.35 }} />
            <circle cx="2" cy="2" r="0.9" style={{ fill: "var(--ws-beam)" }} />
          </pattern>
        </defs>
        <RibbonLayer model={model} lit={lit} relationship={relationship} onHover={onRibbonHover} />
        <g>
          {model.nodes.map(node => {
            const litNow = hop(node.id) !== undefined;
            const style = { ["--hop" as string]: hop(node.id) ?? 0 };
            if (node.kind === "leaf") {
              return (
                <g key={node.id} aria-hidden="true" className={markClass(lit, litNow)} style={style} onPointerEnter={() => setHoverLeaf(node)} onPointerLeave={() => setHoverLeaf(null)}>
                  <rect x={node.x} y={node.y} width={layout.barWidth} height={node.height} rx={2} className={styles.bar} />
                </g>
              );
            }
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={tabStop === node.id ? 0 : -1}
                aria-pressed={roots.has(node.id)}
                aria-label={hubName(node, model.directKnown.has(node.id), labelOf)}
                data-watershed-hub={node.id}
                className={`${styles.hub} ${markClass(lit, litNow)} ${roots.has(node.id) ? styles.root : ""}`}
                style={style}
                onPointerEnter={() => preview(node.id)}
                onPointerLeave={() => preview(null)}
                onFocus={() => { setFocusId(node.id); preview(node.id); }}
                onBlur={() => preview(null)}
                onClick={() => onCommit(node.id)}
                onKeyDown={event => onKeyDown(event, node)}
              >
                <rect className={styles.focus} x={node.x - 3} y={node.y - 3} width={layout.barWidth + 6} height={node.height + 6} rx={4} />
                <rect x={node.x} y={node.y} width={layout.barWidth} height={node.height} rx={2} className={styles.bar} />
                <rect x={node.x} y={node.y} width={Math.min(150, model.columns.length > 1 ? model.columns[1]!.x - model.columns[0]!.x - 20 : 150)} height={node.height} fill="transparent" />
              </g>
            );
          })}
        </g>
        <LabelLayer model={model} lit={lit} labelOf={labelOf} />
      </svg>
      {anchor && previewTooltip && (
        <ChartTooltipSurface className={styles.tooltip} style={{ left: Math.min(anchor.x + layout.barWidth + 12, model.width - 290), top: anchor.y + anchor.height + 6 }}>
          {previewTooltip}
        </ChartTooltipSurface>
      )}
      {!anchor && hoverRibbon && (
        <ChartTooltipSurface className={styles.tooltip} style={{ left: Math.min(hoverRibbon.x + 12, model.width - 290), top: hoverRibbon.y + 12 }}>
          <RibbonTooltip ribbon={hoverRibbon.ribbon} labelOf={labelOf} />
        </ChartTooltipSurface>
      )}
      {!anchor && !hoverRibbon && hoverLeaf && (
        <ChartTooltipSurface className={styles.tooltip} style={{ left: Math.min(hoverLeaf.x + layout.barWidth + 12, model.width - 290), top: hoverLeaf.y + hoverLeaf.height + 6 }}>
          <p className="font-semibold">{labelOf(hoverLeaf.id)}</p>
          <p className="text-xs text-muted-foreground">No tracked dependents · supply at evaluation {hoverLeaf.supplyUsd === null ? "not published" : formatCurrency(hoverLeaf.supplyUsd, 2)}</p>
        </ChartTooltipSurface>
      )}
    </div>
  );
}

function RibbonTooltip({ ribbon, labelOf }: { ribbon: WatershedRibbon; labelOf: (id: string) => string }) {
  const presentation = DEPENDENCY_TYPE_PRESENTATION[ribbon.relationship];
  const form = ribbon.edge.wrapperForm ? WRAPPER_FORM_LABELS[ribbon.edge.wrapperForm] ?? ribbon.edge.wrapperForm : null;
  const scoreKnown = ribbon.edge.materiality === "serial" || ribbon.edge.materiality === "basket-weighted";
  return (
    <div className="space-y-1">
      <p className="font-semibold">{labelOf(ribbon.from)} → {labelOf(ribbon.to)}</p>
      <p className="text-xs">{presentation.label}{form ? ` · ${form}` : ""} · {ribbon.share === null ? "share unknown" : ribbon.edge.kind === "serial" ? "Full claim" : `${(ribbon.share * 100).toFixed(1)}% of backing`}</p>
      <p className="pharos-numeric text-xs">{watershedRibbonSummary(ribbon, labelOf)}</p>
      {!scoreKnown && <p className="text-xs text-muted-foreground">Upstream score unavailable or not rateable for this link</p>}
      {ribbon.edge.provenance && <p className="text-xs text-muted-foreground">Source {ribbon.edge.provenance.source}{ribbon.edge.provenance.evidenceAsOf ? ` · evidence ${ribbon.edge.provenance.evidenceAsOf}` : ""}</p>}
    </div>
  );
}
