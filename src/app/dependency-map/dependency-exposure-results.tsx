"use client";

import { useState } from "react";
import Link from "next/link";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { formatCurrency } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { DEPENDENCY_ROLE_LABELS, EXPOSURE_BAND_LABELS } from "@shared/lib/classification";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import type { DependencyExposureResult } from "@/hooks/use-dependency-exposure-mode";
import type { ExposureRootOption } from "./dependency-exposure-controls";
import { useDependencyScenarios } from "@/hooks/use-dependency-scenarios";
import { DependencyScenarioChange, DependencyScenarioView, selectDependencyScenario } from "./dependency-scenario-view";

export function DependencyExposureResults({ result, publication, roots, options, inspectedId, onInspect, networkUpdated, held }: {
  result: DependencyExposureResult; publication: DependencyGraphResponse; roots: readonly string[];
  options: readonly ExposureRootOption[]; inspectedId: string | null; onInspect: (id: string) => void;
  networkUpdated: boolean; held: boolean;
}) {
  const [sort, setSort] = useState("usd");
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const scenarios = useDependencyScenarios(roots.length > 0);
  const scenarioSelection = selectDependencyScenario(scenarios.data, roots, selectedScenarioId, publication.publicationGenerationId, scenarios.isError, scenarios.nowSec);
  const label = (id: string) => options.find(option => option.id === id)?.label ?? id;
  const rows = result.rows.filter(row => !unknownOnly || row.supplyUnknown).sort((a, b) => {
    const left = sort === "share" ? a.share : a.exposureUsd, right = sort === "share" ? b.share : b.exposureUsd;
    return left === null ? right === null ? a.id.localeCompare(b.id) : 1 : right === null ? -1 : right - left || a.id.localeCompare(b.id);
  });
  const rootCards = roots.map(id => publication.nodes.find(card => card?.id === id));
  const coverageKnown = rootCards.every(card => typeof card?.dependencyCoverageCount === "number");
  const coverageCount = rootCards.reduce((count, card) => count + (card?.dependencyCoverageCount ?? 0), 0);
  const inspected = result.rows.find(row => row.id === inspectedId);
  const clocks = [...new Set(publication.nodes.filter(card => card?.circulatingUsdAtEvaluation !== null).map(card => `${publication.publicationGenerationId} at ${typeof card.supplyAsOfSec === "number" && Number.isFinite(card.supplyAsOfSec) ? new Date(card.supplyAsOfSec * 1000).toISOString() : "unknown"}`))];
  const roles = rootCards.flatMap(card => (Array.isArray(card?.roles) ? card.roles : []).filter(role => role && typeof role.upstreamAssetId === "string").map((role, index) => ({ root: card!.id, role, index })));
  const nodeById = new Map(publication.nodes.map(node => [node.id, node]));
  const knownRows = result.rows.filter(row => row.exposureUsd !== null);
  const directAvailable = knownRows.some(row => row.minHop === 1) || (result.direct.complete && knownRows.length > 0);
  const indirectAvailable = knownRows.some(row => row.minHop > 1) || (result.indirect.complete && knownRows.length > 0);
  const directUsd = directAvailable ? `${formatCurrency(result.direct.knownUsd, 2)}${result.direct.complete ? "" : " (known supply only)"}` : "USD unavailable";
  const indirectUsd = indirectAvailable ? `${formatCurrency(result.indirect.knownUsd, 2)}${result.indirect.complete ? "" : " (known supply only)"}` : "USD unavailable";
  const overlapUsd = knownRows.length > 0 ? `${formatCurrency(result.direct.overlapUsd + result.indirect.overlapUsd, 2)}${result.direct.complete && result.indirect.complete ? "" : " (known supply only)"}` : "USD unavailable";
  if (roots.length === 0) return <section aria-label="Exposure results"><p className="text-sm text-muted-foreground">Choose one or more upstream coins to trace exposure</p></section>;
  return <section className="space-y-4" aria-label="Exposure results">
    <div className="space-y-2"><h3 className="text-lg font-semibold">{result.reached} mapped dependents · direct {directUsd} · indirect {indirectUsd} (includes {overlapUsd} counted in more than one layer)</h3><p className="text-sm font-medium">Linked coins; not a loss forecast</p><p className="text-sm text-muted-foreground">Results use the full published graph and ignore Focus, Type and Limit. USD totals include known supply only; unknown values are not zero.</p></div>
    <p className="break-all text-xs text-muted-foreground">Publication {publication.publicationGenerationId} · methodology {publication.methodologyVersion} · asOfSec {publication.asOfSec} · supply clock {clocks.length ? clocks.join("; ") : "not published"}</p>
    {held && <p role="status" className="text-sm">Held publication. Results use the retained publication and its supply clock.</p>}
    {rootCards.map(card => card && (card.ratingStatus === "pipeline-gap" || card.partialEvidence) && <p key={card.id} className="text-sm">
      {label(card.id)} · {card.ratingStatus === "pipeline-gap" ? "Pipeline gap · fewer than two pillars available" : "Partial evidence: pipeline gap"}
      {card.partialEvidence && ` · ${card.partialEvidence.causes.map(cause => cause === "A" ? "pipeline unavailable (A)" : "public data awaiting curation (B)").join("; ")}`}
    </p>)}
    {networkUpdated && <p role="status" className="text-sm">Network updated. Results now use the latest publication.</p>}
    {publication.nodes.some(card => card?.circulatingUsdAtEvaluation === null) && <p className="text-sm text-muted-foreground">Supply at evaluation not published for this generation</p>}
    <p className="text-sm">{Object.entries(result.bandCounts).map(([band, count]) => `${EXPOSURE_BAND_LABELS[band as keyof typeof EXPOSURE_BAND_LABELS]} ${count}`).join(" · ")}</p>
    <p className="text-sm">Known, not in the scored graph: {coverageKnown ? coverageCount : "not published for this generation"} <Link href="/coverage/" className="underline">Coverage Matrix gaps</Link> (use the dependency Gaps filter).</p>
    {roles.length > 0 && <div className="space-y-2"><h4 className="font-semibold">Role dependencies (not drawn)</h4><ul className="text-sm">{roles.map(({ root, role, index }) => <li key={`${root}:${role.upstreamAssetId}:${role.economicRole}:${index}`}>{label(root)} → {label(role.upstreamAssetId)} · {DEPENDENCY_ROLE_LABELS[role.economicRole]} · {Number.isFinite(role.weight) ? `${Math.round(role.weight * 100)}%` : "Unknown share"}</li>)}</ul></div>}
    <DependencyScenarioView response={scenarios.data} roots={roots} selection={scenarioSelection} selectedId={selectedScenarioId} onSelect={setSelectedScenarioId} label={label} />
    {!result.reached ? <p className="text-sm text-muted-foreground">No mapped downstream exposure found. Other dependencies and transmission channels may be missing.</p> : <>
      <div className="flex flex-wrap items-center gap-4"><label className="text-sm">Sort <select className="min-h-11 rounded border border-border bg-background px-2" value={sort} onChange={event => setSort(event.target.value)}><option value="usd">Known USD</option><option value="share">Mapped share</option></select></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={unknownOnly} onChange={event => setUnknownOnly(event.target.checked)} />Unknown supply</label></div>
      <TableFrame tableId="dependency-exposure-results" density="compact" chrome="embedded" tableClassName="min-w-[40rem] text-left text-sm">
        <TableCaption className="sr-only">Mapped dependents, excluding roots</TableCaption>
        <TableHeader><TableRow>
          <TableHead scope="col">Coin</TableHead>
          <TableHead scope="col">Hops</TableHead>
          <TableHead scope="col">Share</TableHead>
          <TableHead scope="col">Band</TableHead>
          <TableHead scope="col">Exposure USD</TableHead>
          <TableHead scope="col">Safety rating</TableHead>
          {scenarioSelection.scenario && <TableHead scope="col">Modeled Safety Score change</TableHead>}
          <TableHead scope="col">Actions</TableHead>
        </TableRow></TableHeader>
        <TableBody>{rows.map(row => <TableRow key={row.id}>
          <TableCell>{label(row.id)}</TableCell>
          <TableCell>{row.minHop}</TableCell>
          <TableCell>{row.share === null ? "Unknown" : `${(row.share * 100).toFixed(2)}%`}</TableCell>
          <TableCell>{EXPOSURE_BAND_LABELS[row.band]}</TableCell>
          <TableCell>{row.exposureUsd === null ? "Unknown supply or share" : formatCurrency(row.exposureUsd, 2)}</TableCell>
          <TableCell>{(() => {
            const node = nodeById.get(row.id);
            if (!node) return "Unavailable";
            return <>{node.ratingStatus === "pipeline-gap" ? "Pipeline gap · fewer than two pillars available" : node.grade}
              {node.partialEvidence && <span className="block text-xs">{node.ratingStatus === "rated" && "Partial evidence: pipeline gap · "}{node.partialEvidence.causes.map(cause => cause === "A" ? "pipeline unavailable (A)" : "public data awaiting curation (B)").join("; ")}</span>}
            </>;
          })()}</TableCell>
          {scenarioSelection.scenario && <TableCell><DependencyScenarioChange selection={scenarioSelection} assetId={row.id} /></TableCell>}
          <TableCell><button type="button" className="pharos-focus-ring min-h-11 rounded px-2 underline" onClick={() => onInspect(row.id)}>Inspect path</button><Link href={buildStablecoinUrl(row.id)} className="pharos-focus-ring inline-flex min-h-11 items-center rounded px-2 underline">Open coin</Link></TableCell>
        </TableRow>)}</TableBody>
      </TableFrame>
    </>}
    {inspected && <div aria-live="polite" className="space-y-2 rounded border border-border p-3"><h4 className="font-semibold">Paths to {label(inspected.id)}</h4>{inspected.paths.length ? <ol className="space-y-1 text-sm">{inspected.paths.map((path, index) => <li key={index}>{path.map(label).join(" → ")}</li>)}</ol> : <p className="text-sm">No path details published for this row.</p>}</div>}
  </section>;
}
