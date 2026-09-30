import type { SupplyOf } from "@shared/lib/dependency-exposure";
import type { SafetyScoreV9CommonModeGroups } from "@shared/types/safety-score-v9-public";
import type { SafetyScoreV9Cap } from "@shared/types/safety-score-v9-public-facts";

export type SharedFailureDomainCap = Pick<SafetyScoreV9Cap, "kind" | "limit">;
export interface SharedFailureDomainAdjustment {
  adjustmentPoints: number;
  scoreBefore: number;
  scoreAfter: number;
}
export interface SharedFailureDomainCard {
  id: string;
  name?: string;
  symbol?: string;
  caps?: readonly SharedFailureDomainCap[];
  scoreTrace?: { deploymentRisk?: { adjustments: readonly SharedFailureDomainAdjustment[] } };
}
type PublishedEffect = NonNullable<SafetyScoreV9CommonModeGroups[number]["pricedEffects"]>[number];
export type SharedFailureDomainGroups = readonly (Omit<SafetyScoreV9CommonModeGroups[number], "pricedEffects"> & {
  pricedEffects?: readonly (PublishedEffect & {
    resolvedCaps?: readonly SharedFailureDomainCap[];
    resolvedAdjustments?: readonly SharedFailureDomainAdjustment[];
    referencesUnresolved?: boolean;
  })[];
})[];
export interface SharedFailureDomainRow {
  id: string;
  kind: SafetyScoreV9CommonModeGroups[number]["kind"];
  key: string;
  members: { id: string; name: string; symbol: string }[];
  knownUsd: number | null;
  publicationMemberCount: number;
  marketCapMemberCount: number;
  unavailableMemberCount: number;
  oldestAsOfSec: number | null;
  supplyDateIncomplete: boolean;
  effects: {
    assetId: string;
    label: string;
    caps: readonly SharedFailureDomainCap[];
    adjustments: readonly SharedFailureDomainAdjustment[];
    referencesUnresolved: boolean;
  }[];
  pricedEffectsIncomplete: boolean;
}
export interface SharedFailureDomainsModel {
  status: "not-published" | "published";
  rows: SharedFailureDomainRow[];
}

export function buildSharedFailureDomainsModel({ groups, cards, supplyOf }: {
  groups: SharedFailureDomainGroups | null;
  cards: readonly SharedFailureDomainCard[];
  supplyOf: SupplyOf;
}): SharedFailureDomainsModel {
  if (groups === null) return { status: "not-published", rows: [] };
  const cardById = new Map(cards.map(card => [card.id, card]));
  const rows: SharedFailureDomainRow[] = [];
  for (const group of groups) {
    const memberIds = [...new Set(group.memberAssetIds)];
    if (memberIds.length < 2) continue;
    let knownUsd: number | null = null;
    let publicationMemberCount = 0;
    let marketCapMemberCount = 0;
    let unavailableMemberCount = 0;
    let oldestAsOfSec: number | null = null;
    let supplyDateIncomplete = false;
    const members = memberIds.map(id => {
      const card = cardById.get(id);
      const supply = supplyOf(id);
      if (supply === null || !Number.isFinite(supply.usd) || supply.usd < 0) {
        unavailableMemberCount++;
      } else {
        knownUsd = (knownUsd ?? 0) + supply.usd;
        if (supply.basis === "publication-circulating") publicationMemberCount++;
        else marketCapMemberCount++;
        if (supply.asOf === null) supplyDateIncomplete = true;
        else oldestAsOfSec = oldestAsOfSec === null ? supply.asOf : Math.min(oldestAsOfSec, supply.asOf);
      }
      return { id, name: card?.name ?? id, symbol: card?.symbol ?? card?.name ?? id };
    });
    const effects = (group.pricedEffects ?? []).map(effect => {
      const card = cardById.get(effect.assetId);
      const caps = effect.resolvedCaps ?? effect.capIndices.flatMap(index => card?.caps?.[index] ? [card.caps[index]] : []);
      const adjustments = effect.resolvedAdjustments ?? effect.deploymentAdjustmentIndices.flatMap(index => {
        const adjustment = card?.scoreTrace?.deploymentRisk?.adjustments[index];
        return adjustment ? [adjustment] : [];
      });
      return {
        assetId: effect.assetId,
        label: card?.symbol ?? card?.name ?? effect.assetId,
        caps,
        adjustments,
        referencesUnresolved: effect.referencesUnresolved === true || caps.length !== effect.capIndices.length || adjustments.length !== effect.deploymentAdjustmentIndices.length,
      };
    });
    rows.push({ id: group.id, kind: group.kind, key: group.key, members, knownUsd,
      publicationMemberCount, marketCapMemberCount, unavailableMemberCount, oldestAsOfSec, supplyDateIncomplete,
      effects, pricedEffectsIncomplete: group.pricedEffectsIncomplete === true });
  }
  rows.sort((a, b) => (b.knownUsd ?? -1) - (a.knownUsd ?? -1) || a.id.localeCompare(b.id));
  return { status: "published", rows };
}
