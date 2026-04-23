import type { PegCurrency } from "@shared/types";
import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { PEG_COUNTRY_MAP } from "@/lib/alt-peg-geography";
import { logosById } from "@/lib/logos";

export interface PegEmblem {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly logoSrc: string;
}

export interface PegEmblemCluster {
  readonly peg: PegCurrency;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly colorHex: string;
  readonly emblems: readonly PegEmblem[];
}

/**
 * Percentage-based anchor positions for each fiat peg cluster, relative to
 * the world-map container (not the SVG viewBox). Tuned against the rendered
 * atlas at desktop width so each cluster lands over the peg's main territory.
 */
export const PEG_ANCHORS: Record<string, { x: number; y: number }> = {
  EUR: { x: 52, y: 20 },
  CHF: { x: 51, y: 26 },
  GBP: { x: 49, y: 14 },
  RUB: { x: 66, y: 14 },
  TRY: { x: 58, y: 26 },
  JPY: { x: 83, y: 25 },
  IDR: { x: 81, y: 49 },
  SGD: { x: 76, y: 47 },
  CNH: { x: 77, y: 30 },
  PHP: { x: 82, y: 40 },
  BRL: { x: 36, y: 56 },
  CAD: { x: 28, y: 18 },
  MXN: { x: 24, y: 33 },
  ZAR: { x: 56, y: 65 },
  AUD: { x: 83, y: 63 },
};

interface EmblemRecord {
  id: string;
  name: string;
  symbol: string;
  llamaId?: string;
  flags: { pegCurrency: PegCurrency };
}

function resolveLogoSrc(record: EmblemRecord): string | undefined {
  // The static logos map is keyed primarily by stablecoin id (slug); a handful
  // of USD coins are keyed by numeric llamaId as well. Try id first, fall back
  // to llamaId so we catch both conventions.
  const byId = logosById[record.id];
  if (byId) return byId;
  if (record.llamaId) return logosById[record.llamaId];
  return undefined;
}

function buildEmblems(records: readonly EmblemRecord[]): PegEmblem[] {
  const emblems: PegEmblem[] = [];
  for (const record of records) {
    const logoSrc = resolveLogoSrc(record);
    if (!logoSrc) continue;
    emblems.push({
      id: record.id,
      symbol: record.symbol,
      name: record.name,
      logoSrc,
    });
  }
  return emblems.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function buildPegEmblemsForPegs(pegs: readonly PegCurrency[]): readonly PegEmblem[] {
  const pegSet = new Set(pegs);
  if (pegSet.size === 0) return [];
  return buildEmblems(ACTIVE_STABLECOINS.filter((record) => pegSet.has(record.flags.pegCurrency)));
}

export function buildPegEmblems(peg: PegCurrency): readonly PegEmblem[] {
  return buildPegEmblemsForPegs([peg]);
}

export function buildPegEmblemClusters(): readonly PegEmblemCluster[] {
  const clusters: PegEmblemCluster[] = [];

  for (const peg of Object.keys(PEG_COUNTRY_MAP) as PegCurrency[]) {
    const anchor = PEG_ANCHORS[peg];
    if (!anchor) continue;

    const emblems = buildPegEmblems(peg);
    if (emblems.length === 0) continue;

    const colorHex = PEG_CHART_COLORS[peg]?.hex ?? "#64748b";
    clusters.push({ peg, anchor, colorHex, emblems });
  }

  return clusters;
}
