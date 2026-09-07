import type { YieldPublicDecisionLedger, YieldSourceInputMeta } from "@shared/types/yield";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { compareCandidates } from "./evaluation-arbitration";
import { buildPublicDecisionLedger } from "./decision-public";
import { buildYieldSourceProvenance } from "./provenance";
import { isRealSourceSwitch } from "../../lib/yield-history-ownership-handoffs";

export interface YieldCoinPublicationView {
  selected: EvaluatedYieldSource;
  /** Coin candidates ordered by confidence-weighted arbitration. */
  candidates: EvaluatedYieldSource[];
  rejectedCount: number;
  selectedReason: string;
  previousBestSourceKey: string | null;
  sourceSwitch: boolean;
  apy30dDeltaFromPrevious: number | null;
  decisionLedger: YieldPublicDecisionLedger;
}

export interface YieldPublicationViews {
  /** Per-source provenance keyed by history key, for every evaluated source. */
  provenanceByKey: Map<string, Record<string, unknown>>;
  /** Per-coin decision evidence keyed by stablecoin id, for best sources. */
  viewsByCoinId: Map<string, YieldCoinPublicationView>;
}

function resolveApy30dDeltaFromPrevious(input: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
}): number | null {
  if (!isRealSourceSwitch(input.previousBestSourceKey, input.selected.sourceKey)) {
    return null;
  }

  const previous = input.candidates.find(
    (candidate) => candidate.sourceKey === input.previousBestSourceKey,
  );
  if (!previous || !Number.isFinite(previous.apy30d) || !Number.isFinite(input.selected.apy30d)) {
    return null;
  }
  return input.selected.apy30d - previous.apy30d;
}

export function buildYieldPublicationViews(input: {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  startSec: number;
  dlPoolsMeta: YieldSourceInputMeta;
}): YieldPublicationViews {
  const provenanceByKey = new Map<string, Record<string, unknown>>();
  for (const source of input.evaluatedSources) {
    provenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: input.bestSourceKeyByCoin.get(source.id) === source.sourceKey,
        evaluatedSources: input.evaluatedSources,
        startSec: input.startSec,
        dlPoolsMeta: input.dlPoolsMeta,
      }),
    );
  }

  const viewsByCoinId = new Map<string, YieldCoinPublicationView>();
  for (const source of input.evaluatedSources) {
    if (input.bestSourceKeyByCoin.get(source.id) !== source.sourceKey) {
      continue;
    }
    const candidates = input.evaluatedSources
      .filter((candidate) => candidate.id === source.id)
      .sort(compareCandidates);
    const rejectedCount = candidates.filter((candidate) => candidate.rejected).length;
    const provenance = provenanceByKey.get(buildHistoryKey(source.id, source.sourceKey)) ?? {};
    const previousBestSourceKey =
      typeof provenance.previousBestSourceKey === "string" ? provenance.previousBestSourceKey : null;
    const sourceSwitch = provenance.sourceSwitch === true;
    const apy30dDeltaFromPrevious = resolveApy30dDeltaFromPrevious({
      selected: source,
      candidates,
      previousBestSourceKey,
    });

    viewsByCoinId.set(source.id, {
      selected: source,
      candidates,
      rejectedCount,
      selectedReason:
        typeof provenance.selectionReason === "string" ? provenance.selectionReason : "Selected source",
      previousBestSourceKey,
      sourceSwitch,
      apy30dDeltaFromPrevious,
      decisionLedger: buildPublicDecisionLedger({
        selected: source,
        candidates,
        rejectedCount,
        previousBestSourceKey,
        sourceSwitch,
        apy30dDeltaFromPrevious,
      }),
    });
  }

  return { provenanceByKey, viewsByCoinId };
}
