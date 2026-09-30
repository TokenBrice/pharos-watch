"use client";

import { useMemo, useState } from "react";
import { exposureFootprint, type ExposureBand, type ExposureOptions, type ExposureTotals, type SupplyOf } from "@shared/lib/dependency-exposure";
import type { DependencyGraphResponse } from "@shared/types/dependency-graph";

export interface DependencyExposureRow {
  id: string;
  minHop: number;
  share: number | null;
  band: ExposureBand;
  exposureUsd: number | null;
  supplyUnknown: boolean;
  scoreUnknown: boolean;
  paths: string[][];
}
export interface DependencyExposureResult {
  rows: DependencyExposureRow[];
  direct: ExposureTotals;
  indirect: ExposureTotals;
  reached: number;
  bandCounts: Record<DependencyExposureRow["band"], number>;
}

function dependencyExposureIdentity(publication: DependencyGraphResponse | undefined): string {
  if (!publication) return "unpublished";
  return JSON.stringify([publication.publicationGenerationId,
    publication.nodes.map(node => [node.id, node.supplyAsOfSec])]);
}

export function computeDependencyExposure(publication: DependencyGraphResponse, roots: readonly string[]): DependencyExposureResult {
  const cards = new Map(publication.nodes.map(node => [node.id, node]));
  const supplyOf: SupplyOf = id => {
    const node = cards.get(id);
    const usd = node?.circulatingUsdAtEvaluation;
    return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
      ? { usd, asOf: node?.supplyAsOfSec ?? null, basis: "publication-circulating" } : null;
  };
  const opts: ExposureOptions = {
    sharedBooks: { bookIdOf: id => cards.get(id)?.sharedBookId ?? null, measuredHoldingUsd: () => null },
    familyOf: () => null,
    wrapperFormOf: id => {
      let form: DependencyGraphResponse["edges"][number]["wrapperForm"];
      for (const edge of publication.edges) {
        if (!edge || edge.to !== id || edge.kind !== "serial") continue;
        if (edge.wrapperForm == null || (form !== undefined && form !== edge.wrapperForm)) return "unknown";
        form = edge.wrapperForm;
      }
      return form == null ? "unknown" : form === "pure" || form === "native-staked" ? "pass-through" : "vault-claim";
    },
  };
  // Keep malformed relationships as unknown when their endpoints are identifiable.
  // One bad row must not poison traversal or manufacture a measured share.
  const edges = publication.edges.flatMap(edge => {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") return [];
    if ((edge.kind === "serial" || edge.kind === "basket") &&
      (edge.kind === "serial" || edge.weight === null || (typeof edge.weight === "number" && Number.isFinite(edge.weight) && edge.weight >= 0 && edge.weight <= 1))) return [edge];
    return [{ ...edge, kind: "basket" as const, weight: null }];
  });
  const result = exposureFootprint(roots, edges, supplyOf, opts);
  return { ...result, rows: result.rows.map(row => ({ ...row, supplyUnknown: supplyOf(row.id) === null })) };
}

export function useDependencyExposureMode(publication: DependencyGraphResponse | undefined, roots: readonly string[]) {
  const identity = dependencyExposureIdentity(publication);
  const [snapshot, setSnapshot] = useState({ identity, publication, updated: false });
  if (snapshot.identity !== identity) {
    setSnapshot({ identity, publication, updated: snapshot.publication !== undefined });
  }
  const result = useMemo(() => snapshot.publication ? computeDependencyExposure(snapshot.publication, roots) : null, [snapshot, roots]);
  return { result, publication: snapshot.publication, networkUpdated: snapshot.updated,
    held: publication?.publicationHealth.status === "held" };
}
