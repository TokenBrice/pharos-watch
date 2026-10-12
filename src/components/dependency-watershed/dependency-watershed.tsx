"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatCurrency } from "@shared/lib/format";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { computeDependencyExposure, type DependencyExposureResult } from "@/hooks/use-dependency-exposure-mode";
import { buildWatershedModel } from "@/lib/dependency-watershed/model";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import { WatershedLegend } from "./watershed-legend";
import { WatershedOtherBasins } from "./watershed-other-basins";
import { WatershedStage, type WatershedRelationshipFilter } from "./watershed-stage";
import { WatershedTable } from "./watershed-table";

export interface WatershedOverlay {
  roots: readonly string[];
  rows: ReadonlyMap<string, { minHop: number }>;
}

const MIN_STAGE_WIDTH = 720;
const RELATIONSHIP_OPTIONS = [
  { value: "all" as const, label: "All" },
  { value: "collateral" as const, label: "Collateral" },
  { value: "wrapper" as const, label: "Wrapper" },
];

/** "Downstream of X: $Y of mapped dependent supply across N coins" — a relationship, never an outcome. */
export function downstreamHeadline(names: string, result: DependencyExposureResult): { lead: string; detail: string } {
  const knownRows = result.rows.filter(row => row.exposureUsd !== null);
  const complete = result.direct.complete && result.indirect.complete;
  const total = knownRows.length ? `${formatCurrency(result.direct.knownUsd + result.indirect.knownUsd, 2)}${complete ? "" : " (known supply only)"}` : "USD unavailable";
  const usd = (value: number, available: boolean) => available ? formatCurrency(value, 2) : "USD unavailable";
  return {
    lead: `Downstream of ${names}: ${total} of mapped dependent supply across ${result.reached} ${result.reached === 1 ? "coin" : "coins"}`,
    detail: `direct ${usd(result.direct.knownUsd, knownRows.some(row => row.minHop === 1))} · indirect ${usd(result.indirect.knownUsd, knownRows.some(row => row.minHop > 1))} (includes ${usd(result.direct.overlapUsd + result.indirect.overlapUsd, knownRows.length > 0)} counted in more than one layer)`,
  };
}

export function DependencyWatershed({ publication, overlay, result, labelOf, onAddRoot, controls, fallback }: {
  publication: DependencyGraphResponse;
  overlay: WatershedOverlay | null;
  /** The Exposure workspace's footprint for the committed roots. */
  result: DependencyExposureResult | null;
  labelOf: (id: string) => string;
  onAddRoot: (id: string) => void;
  /** Mode and view controls rendered in the header row. */
  controls?: ReactNode;
  /** Rendered with a notice when the layered view is unavailable. */
  fallback: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [relationship, setRelationship] = useState<WatershedRelationshipFilter>("all");
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(MIN_STAGE_WIDTH, Math.floor(entry!.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const roots = useMemo(() => overlay?.roots ?? [], [overlay]);
  const rootSet = useMemo(() => new Set(roots), [roots]);
  const nodes = publication.nodes;
  const model = useMemo(() => buildWatershedModel({ nodes, edges: publication.edges, expandedHubs: roots, layout: { width } }), [nodes, publication.edges, roots, width]);
  const preview = useMemo(() => previewId ? computeDependencyExposure(publication, [previewId]) : null, [publication, previewId]);
  const lit = useMemo(() => {
    if (!overlay && !preview) return null;
    const hops = new Map<string, number>();
    const add = (id: string, hop: number) => hops.set(id, Math.min(hop, hops.get(id) ?? hop));
    for (const root of roots) add(root, 0);
    for (const [id, row] of overlay?.rows ?? []) add(id, row.minHop);
    if (previewId && preview) {
      add(previewId, 0);
      for (const row of preview.rows) add(row.id, row.minHop);
    }
    return hops;
  }, [overlay, roots, preview, previewId]);

  if (!model.ok) {
    return (
      <div className="space-y-3">
        <p role="status" className="pharos-card-shell px-4 py-3 text-sm">
          Layered view unavailable: the published graph contains a dependency cycle ({[...model.members, model.members[0]].map(labelOf).join(" → ")}). Showing the network view.
        </p>
        {fallback}
      </div>
    );
  }

  const supplyClocks = [...new Set(nodes.filter(node => model.layers.has(node.id) && node.supplyAsOfSec !== null).map(node => node.supplyAsOfSec!))].sort((a, b) => a - b);
  const beam = overlay && result ? downstreamHeadline(roots.map(labelOf).join(" + "), result) : null;
  const previewHeadline = preview && previewId ? downstreamHeadline(labelOf(previewId), preview) : null;
  const previewTop = preview ? [...preview.rows].filter(row => row.exposureUsd !== null).sort((a, b) => b.exposureUsd! - a.exposureUsd! || a.id.localeCompare(b.id)).slice(0, 3) : [];
  const commit = (id: string) => {
    if (!rootSet.has(id)) onAddRoot(id);
  };

  return (
    <section className="pharos-card-shell space-y-4 px-4 py-4" aria-labelledby="dependency-watershed-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="dependency-watershed-title" className="pharos-section-title">Dependency watershed</h2>
          <p className="text-sm text-muted-foreground">Each band is a published dependency: a dependent&apos;s supply mapped to its upstream. Select a hub to light what sits downstream of it.</p>
        </div>
        {controls}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ControlPillToggle ariaLabel="Relationship" options={RELATIONSHIP_OPTIONS} value={relationship} onChange={setRelationship} className="flex flex-wrap gap-1.5" buttonClassName="min-h-9 px-3 text-xs" />
        <p className="text-xs text-muted-foreground">Filtering dims other links; totals always use every link.</p>
      </div>
      {beam && (
        <div className="space-y-1" aria-live="polite">
          <p className="text-sm font-semibold">{beam.lead}</p>
          <p className="pharos-numeric text-xs text-muted-foreground">{beam.detail}</p>
          <p className="text-xs font-medium">Linked coins; not a loss forecast</p>
        </div>
      )}
      <div className="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
        <span>← Upstream</span>
        <span>Downstream →</span>
      </div>
      <div ref={container} className="max-h-[70rem] overflow-auto">
        <WatershedStage
          model={model}
          lit={lit}
          roots={rootSet}
          relationship={relationship}
          labelOf={labelOf}
          onPreview={setPreviewId}
          onCommit={commit}
          previewTooltip={previewHeadline && (
            <div className="space-y-1">
              <p className="font-semibold">{previewHeadline.lead}</p>
              <p className="pharos-numeric text-xs">{previewHeadline.detail}</p>
              {previewTop.length > 0 && <p className="text-xs">Largest: {previewTop.map(row => `${labelOf(row.id)} ${formatCurrency(row.exposureUsd!, 2)}`).join(" · ")}</p>}
              <p className="text-xs text-muted-foreground">Linked coins; not a loss forecast · {rootSet.has(previewId!) ? "selected" : "click or press Enter to select"}</p>
            </div>
          )}
        />
      </div>
      <WatershedLegend model={model} labelOf={labelOf} />
      <WatershedOtherBasins model={model} labelOf={labelOf} roots={rootSet} onCommit={commit} />
      <WatershedTable model={model} publication={publication} labelOf={labelOf} />
      <p className="break-all text-xs text-muted-foreground">
        Publication supply basis · V10 {publication.methodologyVersion} · publication {publication.publicationGenerationId.split(":").pop()?.slice(0, 7)} · {supplyClocks.length === 0 ? "supply clock not published" : supplyClocks.length === 1 ? `supply as of ${formatEventTimestamp(supplyClocks[0]!, true)}` : `mixed supply clocks, ${formatEventTimestamp(supplyClocks[0]!, true)} to ${formatEventTimestamp(supplyClocks[supplyClocks.length - 1]!, true)}`}
        {publication.publicationStatus === "held" ? " · held publication" : ""}
      </p>
    </section>
  );
}
