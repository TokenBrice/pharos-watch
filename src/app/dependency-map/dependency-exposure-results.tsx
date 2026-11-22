"use client";

import { useState } from "react";
import Link from "next/link";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { formatCurrency } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { DEPENDENCY_ROLE_LABELS, EXPOSURE_BAND_LABELS } from "@shared/lib/classification";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";
import type { DependencyExposureResult } from "@/hooks/use-dependency-exposure-mode";
import type { ExposureRootOption } from "./dependency-exposure-controls";
import { useDependencyScenarios } from "@/hooks/use-dependency-scenarios";
import { DependencyScenarioChange, DependencyScenarioView, selectDependencyScenario } from "./dependency-scenario-view";
import { formatFootprintLayer, formatFootprintOverlap } from "@/lib/dependency-watershed/footprint-display";
import { describePartialEvidence, formatPartialEvidenceGap } from "@/lib/safety-score-reason-labels";

export function DependencyExposureResults({ result, publication, roots, options, logos, inspectedId, onInspect, networkUpdated, held }: {
  result: DependencyExposureResult;
  publication: DependencyGraphResponse;
  roots: readonly string[];
  options: readonly ExposureRootOption[];
  logos?: Record<string, string>;
  inspectedId: string | null;
  onInspect: (id: string) => void;
  networkUpdated: boolean;
  held: boolean;
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

  if (roots.length === 0) return <section aria-label="Exposure results"><p className="text-sm text-muted-foreground">Choose one or more upstream coins to trace exposure</p></section>;

  return (
    <section className="pharos-card-shell space-y-4 p-4 sm:p-5" aria-label="Exposure results">
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-foreground sm:text-lg">
          {result.reached} mapped dependents · direct {formatFootprintLayer(result.direct)} · indirect {formatFootprintLayer(result.indirect)} · {formatFootprintOverlap(result.direct, result.indirect)}
        </h3>
        <p className="text-xs font-medium text-foreground">Linked coins; not a loss forecast</p>
        <p className="text-xs text-muted-foreground">
          Results use the full published graph and ignore Focus, Type and Limit. USD totals include known supply only; unknown values are not zero.
        </p>
      </div>

      {held && <p role="status" className="text-sm">Held publication. Results use the retained publication and its supply clock.</p>}
      {rootCards.map(card => {
        if (!card || (card.ratingStatus !== "pipeline-gap" && !card.partialEvidence)) return null;
        const partial = describePartialEvidence(card);
        return <p key={card.id} className="text-sm" title={partial?.summary}>
          {label(card.id)} · {card.ratingStatus === "pipeline-gap" && "Pipeline gap · fewer than two pillars available · "}
          {partial?.gaps.map(formatPartialEvidenceGap).join(" · ")}
        </p>;
      })}
      {networkUpdated && <p role="status" className="text-sm">Network updated. Results now use the latest publication.</p>}
      {publication.nodes.some(card => card?.circulatingUsdAtEvaluation === null) && <p className="text-xs text-muted-foreground">Supply at evaluation not published for this generation</p>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">
          {Object.entries(result.bandCounts).map(([band, count]) => `${EXPOSURE_BAND_LABELS[band as keyof typeof EXPOSURE_BAND_LABELS]} ${count}`).join(" · ")}
        </p>
        <p>
          Known, not in the scored graph: {coverageKnown ? coverageCount : "not published for this generation"}{" "}
          <Link href="/coverage/" className="text-brand-accent-text underline underline-offset-2">Coverage Matrix gaps</Link> (use the dependency Gaps filter).
        </p>
      </div>

      {roles.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-3">
          <h4 className="pharos-label">Role dependencies (not drawn)</h4>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {roles.map(({ root, role, index }) => (
              <li key={`${root}:${role.upstreamAssetId}:${role.economicRole}:${index}`}>
                <span className="font-medium text-foreground">{label(root)}</span> →{" "}
                <span className="font-medium text-foreground">{label(role.upstreamAssetId)}</span> ·{" "}
                {DEPENDENCY_ROLE_LABELS[role.economicRole]} ·{" "}
                {Number.isFinite(role.weight) ? `${Math.round(role.weight * 100)}%` : "Unknown share"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <DependencyScenarioView response={scenarios.data} roots={roots} selection={scenarioSelection} selectedId={selectedScenarioId} onSelect={setSelectedScenarioId} label={label} logos={logos} />

      {!result.reached ? (
        <p className="text-sm text-muted-foreground">No mapped downstream exposure found. Other dependencies and transmission channels may be missing.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <label className="text-xs font-medium text-muted-foreground">
              Sort{" "}
              <select
                className="ml-1 min-h-11 rounded-md border border-border bg-background px-2 text-xs text-foreground sm:min-h-8"
                value={sort}
                onChange={event => setSort(event.target.value)}
              >
                <option value="usd">Known USD</option>
                <option value="share">Mapped share</option>
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-8">
              <input type="checkbox" checked={unknownOnly} onChange={event => setUnknownOnly(event.target.checked)} />
              Unknown supply
            </label>
          </div>
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
            <TableBody>{rows.map(row => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[row.id]} name={label(row.id)} size={20} />
                    <span className="font-medium text-foreground">{label(row.id)}</span>
                  </div>
                </TableCell>
                <TableCell className="pharos-numeric">{row.minHop}</TableCell>
                <TableCell className="pharos-numeric">{row.share === null ? "Unknown" : `${(row.share * 100).toFixed(2)}%`}</TableCell>
                <TableCell>{EXPOSURE_BAND_LABELS[row.band]}</TableCell>
                <TableCell className="pharos-numeric">{row.exposureUsd === null ? "Unknown supply or share" : formatCurrency(row.exposureUsd, 2)}</TableCell>
                <TableCell>{(() => {
                  const node = nodeById.get(row.id);
                  if (!node) return "Unavailable";
                  const partial = describePartialEvidence(node);
                  return (
                    <div className="space-y-0.5">
                      {node.ratingStatus === "pipeline-gap" ? (
                        <span className="text-xs text-muted-foreground">Pipeline gap · fewer than two pillars available</span>
                      ) : (
                        <SafetyGradeBadge grade={node.grade} size="xs" />
                      )}
                      {partial && <span className="block text-xs text-muted-foreground" title={partial.summary}>{partial.gaps.map(formatPartialEvidenceGap).join(" · ")}</span>}
                    </div>
                  );
                })()}</TableCell>
                {scenarioSelection.scenario && <TableCell><DependencyScenarioChange selection={scenarioSelection} assetId={row.id} /></TableCell>}
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="pharos-focus-ring pharos-control-pill inline-flex min-h-9 items-center px-2.5 text-xs font-medium text-foreground sm:min-h-7" onClick={() => onInspect(row.id)}>Inspect path</button>
                    <Link href={buildStablecoinUrl(row.id)} className="pharos-focus-ring inline-flex min-h-9 items-center rounded-sm px-1 text-xs font-medium text-brand-accent-text hover:underline sm:min-h-7">Open profile →</Link>
                  </div>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </TableFrame>
        </>
      )}

      {inspected && (
        <div aria-live="polite" className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
          <h4 className="text-sm font-semibold text-foreground">Paths to {label(inspected.id)}</h4>
          {inspected.paths.length ? (
            <ol className="space-y-1 text-xs text-muted-foreground">
              {inspected.paths.map((path, index) => <li key={index}>{path.map(label).join(" → ")}</li>)}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">No path details published for this row.</p>
          )}
        </div>
      )}

      <details className="border-t border-border/50 pt-2 text-xs text-muted-foreground">
        <summary className="pharos-focus-ring cursor-pointer rounded-sm py-1 font-medium text-muted-foreground hover:text-foreground">
          Provenance &amp; publication clocks
        </summary>
        <p className="mt-1.5 break-all">
          Publication {publication.publicationGenerationId} · methodology {publication.methodologyVersion} · asOfSec {publication.asOfSec} · supply clock {clocks.length ? clocks.join("; ") : "not published"}
        </p>
      </details>
    </section>
  );
}
