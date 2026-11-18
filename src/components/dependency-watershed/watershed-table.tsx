"use client";

import { useMemo, useState } from "react";
import { formatCurrency } from "@shared/lib/format";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { DEPENDENCY_TYPE_PRESENTATION } from "@/components/contagion-graph/contagion-graph-model";
import type { WatershedReadyModel } from "./watershed-stage";

type SortState<K extends string> = { key: K; desc: boolean };
type HubKey = "hub" | "layer" | "direct" | "indirect" | "dependents";
type EdgeKey = "from" | "to" | "relationship" | "share" | "usd";

function compareNullable(a: number | string | null, b: number | string | null, desc: boolean): number {
  // Unknown values stay last in either direction.
  if (a === null || b === null) return a === null ? b === null ? 0 : 1 : -1;
  const order = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return desc ? -order : order;
}

function SortHeader<K extends string>({ label, column, sort, onSort }: { label: string; column: K; sort: SortState<K>; onSort: (next: SortState<K>) => void }) {
  const active = sort.key === column;
  return (
    <TableHead scope="col" aria-sort={active ? sort.desc ? "descending" : "ascending" : "none"}>
      <button type="button" className="pharos-focus-ring min-h-11 rounded-sm text-left font-semibold" onClick={() => onSort({ key: column, desc: active ? !sort.desc : true })}>
        {label}{active ? sort.desc ? " ↓" : " ↑" : ""}
      </button>
    </TableHead>
  );
}

export function WatershedTable({ model, labelOf }: { model: WatershedReadyModel; labelOf: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const [hubSort, setHubSort] = useState<SortState<HubKey>>({ key: "direct", desc: true });
  const [edgeSort, setEdgeSort] = useState<SortState<EdgeKey>>({ key: "usd", desc: true });
  const footprints = useMemo(() => open
    ? new Map([...model.hubExposures.keys()].map(id => [id, model.hubFootprint(id)]))
    : null, [open, model]);
  const hubRows = useMemo(() => [...model.hubExposures.values()].map(hub => {
    const footprint = footprints?.get(hub.hubId);
    return {
      id: hub.hubId,
      label: labelOf(hub.hubId),
      layer: model.layers.get(hub.hubId) ?? null,
      direct: footprint?.direct,
      indirect: footprint?.indirect,
      dependents: hub.dependentCount,
      unknown: footprint ? [footprint.direct, footprint.indirect].reduce((count, layer) =>
        count + layer.excludedSupplyUnknownIds.length + layer.unknownShareEdgeCount, 0) : null,
    };
  }).sort((a, b) => {
    const value = (row: typeof a): number | string | null => {
      switch (hubSort.key) {
        case "hub": return row.label;
        case "layer": return row.layer;
        case "direct": return row.direct?.hasKnownUsd ? row.direct.knownUsd : null;
        case "indirect": return row.indirect?.hasKnownUsd ? row.indirect.knownUsd : null;
        case "dependents": return row.dependents;
      }
    };
    return compareNullable(value(a), value(b), hubSort.desc) || a.id.localeCompare(b.id);
  }), [model, labelOf, footprints, hubSort]);
  const edgeRows = useMemo(() => [...model.edges].sort((a, b) => {
    const value = (row: typeof a) => edgeSort.key === "from" ? labelOf(row.from) : edgeSort.key === "to" ? labelOf(row.to) : edgeSort.key === "relationship" ? row.relationship : row[edgeSort.key];
    return compareNullable(value(a), value(b), edgeSort.desc) || a.key.localeCompare(b.key);
  }), [model, labelOf, edgeSort]);

  return (
    <details className="text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="pharos-focus-ring min-h-11 cursor-pointer py-3 font-medium">Table view · {hubRows.length} upstream hubs, {edgeRows.length} links</summary>
      <div className="space-y-4">
        <TableFrame tableId="dependency-watershed-hubs" density="compact" chrome="embedded" tableClassName="min-w-[40rem] text-left text-sm" caption="Upstream hubs: mapped dependent supply at evaluation" captionClassName="sr-only">
          <TableHeader><TableRow>
            <SortHeader label="Hub" column="hub" sort={hubSort} onSort={setHubSort} />
            <SortHeader label="Layer" column="layer" sort={hubSort} onSort={setHubSort} />
            <SortHeader label="Direct USD" column="direct" sort={hubSort} onSort={setHubSort} />
            <SortHeader label="Indirect USD" column="indirect" sort={hubSort} onSort={setHubSort} />
            <SortHeader label="Direct dependents" column="dependents" sort={hubSort} onSort={setHubSort} />
            <TableHead scope="col">Unknown</TableHead>
          </TableRow></TableHeader>
          <TableBody>{hubRows.map(row => <TableRow key={row.id}>
            <TableCell>{row.label}</TableCell>
            <TableCell className="pharos-numeric">{row.layer ?? "—"}</TableCell>
            <TableCell className="pharos-numeric">{!row.direct?.hasKnownUsd ? "Unavailable" : `${formatCurrency(row.direct.knownUsd, 2)}${row.direct.complete ? "" : " (known only)"}`}</TableCell>
            <TableCell className="pharos-numeric">{!row.indirect?.hasKnownUsd ? "Unavailable" : `${formatCurrency(row.indirect.knownUsd, 2)}${row.indirect.complete ? "" : " (known only)"}`}</TableCell>
            <TableCell className="pharos-numeric">{row.dependents}</TableCell>
            <TableCell className="pharos-numeric">{row.unknown ?? "—"}</TableCell>
          </TableRow>)}</TableBody>
        </TableFrame>
        <TableFrame tableId="dependency-watershed-links" density="compact" chrome="embedded" tableClassName="min-w-[44rem] text-left text-sm" caption="Published dependency links with mapped USD" captionClassName="sr-only">
          <TableHeader><TableRow>
            <SortHeader label="Upstream" column="from" sort={edgeSort} onSort={setEdgeSort} />
            <SortHeader label="Dependent" column="to" sort={edgeSort} onSort={setEdgeSort} />
            <SortHeader label="Relationship" column="relationship" sort={edgeSort} onSort={setEdgeSort} />
            <TableHead scope="col">Form</TableHead>
            <SortHeader label="Share" column="share" sort={edgeSort} onSort={setEdgeSort} />
            <SortHeader label="Mapped USD" column="usd" sort={edgeSort} onSort={setEdgeSort} />
          </TableRow></TableHeader>
          <TableBody>{edgeRows.map(row => <TableRow key={row.key}>
            <TableCell>{labelOf(row.from)}</TableCell>
            <TableCell>{labelOf(row.to)}</TableCell>
            <TableCell>{DEPENDENCY_TYPE_PRESENTATION[row.relationship].label}</TableCell>
            <TableCell>{row.edge.wrapperForm ?? "—"}</TableCell>
            <TableCell className="pharos-numeric">{row.share === null ? "Unknown" : row.edge.kind === "serial" ? "Full claim" : `${(row.share * 100).toFixed(2)}%`}</TableCell>
            <TableCell className="pharos-numeric">{row.usd === null ? "Unknown" : formatCurrency(row.usd, 2)}</TableCell>
          </TableRow>)}</TableBody>
        </TableFrame>
      </div>
    </details>
  );
}
