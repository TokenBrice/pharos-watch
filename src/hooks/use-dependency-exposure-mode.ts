"use client";

import { useMemo, useState } from "react";
import { exposureFootprint, type ExposureBand, type ExposureOptions, type ExposureTotals, type SupplyOf } from "@shared/lib/dependency-exposure";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";

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

function dependencyExposureIdentity(publication: ReportCardsV9Response | undefined): string {
  if (!publication) return "unpublished";
  return JSON.stringify([publication.safetyScoreIdentity.publicationGenerationId,
    publication.cards.filter(card => card && typeof card.id === "string").map(card => [card.id, card.supply?.generationId ?? null, card.supply?.asOfSec ?? null])]);
}

export function computeDependencyExposure(publication: ReportCardsV9Response, roots: readonly string[]): DependencyExposureResult {
  const cards = new Map(publication.cards.filter(card => card && typeof card.id === "string").map(card => [card.id, card]));
  const supplyOf: SupplyOf = id => {
    const supply = cards.get(id)?.supply;
    const usd = supply?.circulatingUsdAtEvaluation;
    return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
      ? { usd, asOf: supply?.asOfSec ?? null, basis: "publication-circulating" } : null;
  };
  const opts: ExposureOptions = {
    sharedBooks: { bookIdOf: id => cards.get(id)?.sharedBookId ?? null, measuredHoldingUsd: () => null },
    familyOf: () => null,
    wrapperFormOf: id => {
      const form = cards.get(id)?.scoreTrace?.wrapperParentLimit?.form;
      return !form ? "unknown" : form === "pure" || form === "native-staked" || (form as string) === "staked" ? "pass-through" : "vault-claim";
    },
  };
  // Keep malformed relationships as unknown when their endpoints are identifiable.
  // One bad row must not poison traversal or manufacture a measured share.
  const edges = publication.dependencyGraph.edges.flatMap(edge => {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") return [];
    if ((edge.kind === "serial" || edge.kind === "basket") &&
      (edge.kind === "serial" || edge.weight === null || (typeof edge.weight === "number" && Number.isFinite(edge.weight) && edge.weight >= 0 && edge.weight <= 1))) return [edge];
    return [{ ...edge, kind: "basket" as const, weight: null }];
  });
  const result = exposureFootprint(roots, edges, supplyOf, opts);
  return { ...result, rows: result.rows.map(row => ({ ...row, supplyUnknown: supplyOf(row.id) === null })) };
}

export function useDependencyExposureMode(publication: ReportCardsV9Response | undefined, roots: readonly string[]) {
  const identity = dependencyExposureIdentity(publication);
  const [snapshot, setSnapshot] = useState({ identity, publication, updated: false });
  if (snapshot.identity !== identity) {
    setSnapshot({ identity, publication, updated: snapshot.publication !== undefined });
  }
  const result = useMemo(() => snapshot.publication ? computeDependencyExposure(snapshot.publication, roots) : null, [snapshot, roots]);
  return { result, publication: snapshot.publication, networkUpdated: snapshot.updated,
    held: publication?.publicationHealth.status === "held" };
}
