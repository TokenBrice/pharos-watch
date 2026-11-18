import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { evaluateReferenceAdmission, REFERENCE_INTRADAY_BUDGET_SEC } from "@shared/lib/reference-admission";
import { isParityPrice, type PegRatesResult } from "@shared/lib/peg-rates";
import { WORKER_ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { StablecoinData } from "@shared/types/supply";
import { z } from "zod";
import { getCache } from "./db-cache";
import { parseJson } from "./json-parse";
import { getFxReferenceTypeFromState, type FxRateState } from "./fx-rate-state";
import { REALTIME_FX_CURRENCY_TO_PEG } from "./fx-config";
import { prepareStablecoinsGenerationCompanion } from "./stablecoins-cache";

const CACHE_KEY = "fx-reference-admission-coverage:v1";
const second = z.number().int().positive();
const coverageSchema = z.object({
  generation: z.string().min(1),
  currencies: z.record(z.string(), z.object({
    decisionAt: second,
    sessionOpenedAt: second,
    missingSince: second.nullable(),
  }).refine((row) => row.sessionOpenedAt <= row.decisionAt &&
    (row.missingSince == null || (row.sessionOpenedAt <= row.missingSince && row.missingSince <= row.decisionAt)))),
});
type Coverage = z.output<typeof coverageSchema>;

function parseCoverage(value: string | undefined) {
  if (!value) return null;
  const json = parseJson(value);
  return json.ok ? coverageSchema.safeParse(json.value).data ?? null : null;
}

/** The publisher supplies the predecessor seen in the same transaction as its successful cache CAS. */
export async function recordFxAdmissionCoverage(
  db: D1Database, assets: readonly StablecoinData[], generationAt: number, previousAt: number | null,
  generation: string, previousGeneration: string | null,
  legacy?: { state: FxRateState | null; decisionAt: number; contributors: PegRatesResult["contributors"] },
): Promise<void> {
  const priorRow = await getCache(db, CACHE_KEY);
  const prior = priorRow && priorRow.updatedAt === previousAt ? parseCoverage(priorRow.value) : null;
  const currencies: Coverage["currencies"] = {};
  const originalClocks = legacy && new Map(assets.map((asset) => [asset.id, asset.priceObservedAt]));
  for (const asset of assets) {
    const flags = WORKER_ACTIVE_META_BY_ID.get(asset.id)?.flags;
    const currency = flags?.pegCurrency;
    const verdict = asset.currentPeg?.referenceAdmission;
    const decisionAt = legacy?.decisionAt ?? verdict?.decisionAtSec;
    const quoteAt = asset.priceObservedAt;
    if (flags?.navToken || !currency || !REALTIME_FX_CURRENCY_TO_PEG[currency] || !isParityPrice(asset) ||
        asset.priceObservedAtMode !== "upstream" || quoteAt == null || decisionAt == null ||
        quoteAt > decisionAt || decisionAt - quoteAt > REFERENCE_INTRADAY_BUDGET_SEC ||
        decisionAt < generationAt || decisionAt - generationAt > STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC) continue;
    if (!legacy && (verdict?.generation !== `stablecoins:${generationAt}` || verdict.quoteObservedAtSec !== quoteAt)) continue;
    const session = getReferenceSessionState("fx", decisionAt);
    if (!session.open || quoteAt < session.sessionOpenedAtSec) continue;
    const peg = REALTIME_FX_CURRENCY_TO_PEG[currency];
    const reference = asset.currentPeg?.pegReference;
    let admitted = verdict?.status === "admitted" && asset.currentPeg?.admittedDeviationBps != null;
    if (legacy && reference?.source === "median") {
      const contributors = legacy.contributors?.[peg] ?? [];
      // A legacy display clock may alias collection time. Every selected receipt needs its original quote clock.
      admitted = asset.currentPeg?.currentDeviationBps != null && contributors.every(({ assetId, observedAtSec }) =>
        assetId !== undefined && originalClocks?.get(assetId) === observedAtSec) &&
        evaluateReferenceAdmission({ kind: "median", pegKey: peg, contributors, quoteObservedAtSec: quoteAt,
          decisionAtSec: decisionAt, rawDeviationBps: null, purpose: "current" }).status === "admitted";
    } else if (legacy) {
      admitted = reference?.source === "fx" && reference.valueUsd === legacy.state?.rates[peg] &&
        getFxReferenceTypeFromState(legacy.state, peg, REFERENCE_INTRADAY_BUDGET_SEC, decisionAt) === "fresh";
    }
    const current = currencies[currency];
    if (current && (current.missingSince === null || !admitted)) continue;
    const previous = prior && prior.generation === previousGeneration ? prior.currencies[currency] : null;
    const since = previous?.missingSince;
    const continuous = previous && since != null && since >= session.sessionOpenedAtSec &&
      previous.sessionOpenedAt === session.sessionOpenedAtSec && previous.decisionAt <= decisionAt &&
      decisionAt - previous.decisionAt <= STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC;
    currencies[currency] = {
      decisionAt, sessionOpenedAt: session.sessionOpenedAtSec,
      missingSince: admitted ? null : continuous ? since : decisionAt,
    };
  }
  await prepareStablecoinsGenerationCompanion(db, CACHE_KEY, JSON.stringify({ generation, currencies }), generationAt, generation).run();
}

export async function loadFxAdmissionCoverage(db: D1Database, now: number) {
  const row = await db.prepare(`
    SELECT coverage.value FROM cache AS coverage JOIN cache AS assets
      ON assets.key = 'stablecoins' AND assets.updated_at = coverage.updated_at
      AND json_extract(assets.value, '$.fxAdmissionCoverageGeneration') = json_extract(coverage.value, '$.generation')
    WHERE coverage.key = ? AND coverage.updated_at BETWEEN ? AND ?
  `).bind(CACHE_KEY, now - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC, now).first<{ value: string }>();
  return parseCoverage(row?.value);
}
