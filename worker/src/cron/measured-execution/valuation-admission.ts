import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { DexMeasuredExecutionTarget, DexMeasuredExecutionObservationHistory } from "@shared/types/measured-execution";
import { getClosedReferenceDexValuation, isClosureValuationMark, type DexMarketMark } from "../../lib/dex-api-token-pricing";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";

export const DEX_MEASURED_CLOSURE_VALUATION_UNAVAILABLE = "reference-market-closed-valuation-unavailable";

export function createDexMeasuredValuationAdmission(
  nowSec: number,
  sourceRejectedAssetIds: ReadonlySet<string>,
  marketMarks?: ReadonlyMap<string, DexMarketMark>,
) {
  const prices = marketMarks && Object.assign(
    new Map([...marketMarks].map(([id, mark]) => [id, mark.priceUsd])),
    { marketMarks },
  );
  const closedAssets = new Map<string, NonNullable<ReturnType<typeof getClosedReferenceDexValuation>>>();
  const rejectedQuoteAssetIds = new Set(sourceRejectedAssetIds);
  // A stage built while open can reach scoring after the market closes.
  for (const id of marketMarks ? TRACKED_META_BY_ID.keys() : []) {
    const valuation = getClosedReferenceDexValuation(prices, id, nowSec);
    if (valuation) {
      closedAssets.set(id, valuation);
      if (!valuation.mark) rejectedQuoteAssetIds.add(id);
    }
  }
  const affectedContracts = new Map<string, string[]>();
  for (const id of new Set([...rejectedQuoteAssetIds, ...closedAssets.keys()])) {
    const meta = TRACKED_META_BY_ID.get(id);
    for (const { chain, address } of [...(meta?.contracts ?? []), ...(meta?.tradedContracts ?? [])]) {
      const key = buildChainAddressKey(chain, address);
      const ids = affectedContracts.get(key) ?? [];
      if (!ids.includes(id)) ids.push(id);
      affectedContracts.set(key, ids);
    }
  }
  function legs(target: DexMeasuredExecutionTarget) {
    const inputIds = affectedContracts.get(buildChainAddressKey(target.chain, target.tokenIn.address)) ?? [];
    const outputIds = affectedContracts.get(buildChainAddressKey(target.chain, target.tokenOut.address)) ?? [];
    return [
      [target.stablecoinId, target.tokenIn],
      [target.tokenIn.trackedAssetId, target.tokenIn],
      [target.tokenOut.trackedAssetId, target.tokenOut],
      ...inputIds.map((id) => [id, target.tokenIn] as const),
      ...outputIds.map((id) => [id, target.tokenOut] as const),
    ] as const;
  }

  function rejectsMark(
    id: string,
    stored: DexMeasuredExecutionTarget["tokenIn"]["marketMark"],
    valuedAt: number,
    quotedAt = valuedAt,
  ): boolean {
    const closure = closedAssets.get(id);
    if (!closure) return false;
    return !closure.mark || !isClosureValuationMark(stored, closure.closureStart, valuedAt) || stored.stablecoinId !== id ||
      stored.source !== closure.mark.source ||
      stored.observedAtSec > valuedAt || (!stored.fxReference && valuedAt - stored.observedAtSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) ||
      valuedAt > quotedAt || quotedAt > nowSec;
  }

  function rejectsLeg(id: string, token: DexMeasuredExecutionTarget["tokenIn"], capturedAt: number) {
    if (rejectedQuoteAssetIds.has(id)) return true;
    if (!closedAssets.has(id)) return false;
    return token.trackedAssetId !== id || token.marketMark?.priceUsd !== token.referencePriceUsd ||
      rejectsMark(id, token.marketMark, capturedAt);
  }

  return {
    rejectedQuoteAssetIds,
    rejectsQuotedTarget(target: DexMeasuredExecutionTarget, history?: DexMeasuredExecutionObservationHistory | null): boolean {
      return legs(target).some(([id, token]) => {
        if (id == null) return false;
        if (rejectsLeg(id, token, target.capturedAt)) return true;
        if (!closedAssets.has(id)) return false;
        const observations = history?.valuationObservations;
        if (!observations?.length || observations.length !== history?.successfulObservationCount ||
          new Set(observations.map((row) => row.quoteGenerationId)).size !== observations.length) return true;
        const leg = token === target.tokenIn ? "tokenIn" : "tokenOut";
        return observations.some((row) => rejectsMark(id, row[leg], row.targetCapturedAt ?? row.quotedAt, row.quotedAt));
      });
    },
    rejectsStagedTarget(target: DexMeasuredExecutionTarget): boolean {
      return legs(target).some(([id, token]) => id != null &&
        (rejectsLeg(id, token, target.capturedAt) || rejectsMark(id, token.marketMark, nowSec)));
    },
  };
}
