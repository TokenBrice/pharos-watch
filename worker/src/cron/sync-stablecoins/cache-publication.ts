import { logWorkerEventArgs } from "../../lib/structured-log";
import { FROZEN_IDS, FROZEN_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { formatSchemaLikeIssues } from "@shared/lib/schema-like";
import { derivePegRates, normalizePegType, type PegRatesResult } from "@shared/lib/peg-rates";
import { readRecord } from "@shared/lib/type-guards";
import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { REFERENCE_INTRADAY_BUDGET_SEC } from "@shared/lib/reference-admission";
import { CommodityEntitlementSchema, StablecoinDataSchema, XAGM_ENTITLEMENT_PEG_TYPE, type StablecoinData, type StablecoinListResponse } from "@shared/types/supply";
import type { FxReferenceEvidenceMap, SelectedPegReference } from "@shared/types/fx-reference";
import { CurrentPegSchema } from "@shared/types/current-peg";
import { deriveCurrentPegObservationMap, selectCurrentPegDexPrices, type CurrentPegDexRow } from "../../lib/current-peg-observations";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { MIN_VALID_ASSET_COUNT } from "../../lib/stablecoin-intake-policy";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../lib/response-ready-cache-contracts";
import { prepareCacheUpsert } from "../../lib/db-cache";
import { executeAtomicBatch } from "../../lib/db";
import { getLatestSuccessfulReserveSnapshotMetadata } from "../../lib/live-reserves/store";
import { recordFxAdmissionCoverage } from "../../lib/fx-admission-coverage";
import { getFxReferenceTypeFromState, hasVerifiedLegacyRate } from "../../lib/fx-rate-state";
import { prepareStablecoinsGenerationCompanion } from "../../lib/stablecoins-cache";
import { savePriceCache, type PriceCacheWriteEntry } from "../../lib/price-cache";
import type { PeggedAsset } from "./enrich-prices";
import { returnIfAborted } from "./runtime";
import {
  getStablecoinsCacheAgeSec,
  normalizeStablecoinsPayload,
  reviewedOnchainSupplyHoldFields,
  StablecoinListResponseSchema,
  summarizeValidationIssues,
  writeInvalidStablecoinsDiagnostic,
  type CronResult,
  type StablecoinsPayload,
  type StablecoinsFxSelection,
} from "./shared";

/** One post-enrichment row withheld from publication because it failed the published row schema. */
export interface PublicationQuarantinedAsset {
  id: string | null;
  issues: string;
}

export interface CacheValidationResult {
  /** Whether the schema validation succeeded and the cache was written. */
  written: boolean;
  /** Whether the write was skipped because a newer canonical cache already exists. */
  skippedBecauseNewer: boolean;
  cacheKey: string;
  syncStartSec: number;
  /** If validation failed, the degraded CronResult to return. */
  blockedResult?: CronResult;
  /** Non-fatal companion-cache write failure for response-ready optimization. */
  responseReadyCacheError?: string | null;
  /** Rows quarantined per asset (DEC-03) and removed from `input.assets`; peers still published. */
  quarantinedAssets: PublicationQuarantinedAsset[];
}

export interface ValidateAndCacheInput extends StablecoinsFxSelection {
  assets: PeggedAsset[];
  publishFxReferenceEvidence?: boolean;
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  /** "main" or "fallback" - controls log messages */
  validationContext: "main" | "fallback";
}

type PublicationAdmission =
  | { ok: true; payload: StablecoinListResponse; quarantined: PublicationQuarantinedAsset[]; quarantinedIndexes: Set<number> }
  | { ok: false; issues: string };

/**
 * DEC-03 publication boundary. Each normalized row is validated on its own against the published row
 * schema; a schema-invalid row is quarantined with its issues while valid peers publish. The whole list is
 * held only for a global failure: an invalid envelope (FX map), a duplicate published id (identity), or a
 * quarantine that leaves fewer admitted rows than the `MIN_VALID_ASSET_COUNT` intake floor (the cohort-wide
 * schema drift that would otherwise publish a near-empty list). Intake already enforced that floor, so a
 * cohort without quarantined rows is never re-held here.
 */
function admitPublishableAssets(payload: StablecoinsPayload, fxReferenceObservations?: FxReferenceEvidenceMap): PublicationAdmission {
  const envelope = StablecoinListResponseSchema.safeParse({
    peggedAssets: [], fxFallbackRates: payload.fxFallbackRates, fxReferenceObservations,
  });
  if (!envelope.success) return { ok: false, issues: `envelope: ${formatSchemaLikeIssues(envelope.error.issues)}` };

  const admitted: StablecoinData[] = [];
  const quarantined: PublicationQuarantinedAsset[] = [];
  const quarantinedIndexes = new Set<number>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  payload.peggedAssets.forEach((row, index) => {
    const parsed = StablecoinDataSchema.safeParse(row);
    if (!parsed.success) {
      quarantinedIndexes.add(index);
      quarantined.push({
        id: typeof row?.id === "string" ? row.id : null,
        issues: formatSchemaLikeIssues(parsed.error.issues),
      });
      return;
    }
    if (seenIds.has(parsed.data.id)) duplicateIds.add(parsed.data.id);
    seenIds.add(parsed.data.id);
    admitted.push(parsed.data);
  });

  if (duplicateIds.size > 0) {
    return { ok: false, issues: `identity: duplicate published ids ${[...duplicateIds].join(", ")}` };
  }
  if (quarantined.length > 0 && admitted.length < MIN_VALID_ASSET_COUNT) {
    const detail = quarantined.slice(0, 5).map((row) => `${row.id ?? "<no id>"}: ${row.issues}`).join("; ");
    return {
      ok: false,
      issues: `floor: ${admitted.length} valid rows < ${MIN_VALID_ASSET_COUNT}${detail ? `; ${detail}` : ""}`,
    };
  }
  return {
    ok: true,
    payload: { ...envelope.data, peggedAssets: admitted },
    quarantined,
    quarantinedIndexes,
  };
}

/** Contractual ounces are measured by the issuer's pinned token contract. */
async function readXagmEntitlement(db: D1Database, now: number, quoteObservedAtSec: number | null) {
  const snapshot = await getLatestSuccessfulReserveSnapshotMetadata(db, "xagm-matrixdock", now);
  const details = snapshot?.metadata.details;
  const block = readRecord(snapshot?.metadata.observedBlock);
  // The issuer contract can attest its token unit even though it is not independent proof of reserves.
  if (snapshot?.source !== "matrixdock-frs" || !snapshot.admission ||
      snapshot.admission.reasons.some((reason) => reason !== "non-independent") ||
      details?.proofKind !== "matrixdock-frs-fallback-reserve-feed" || details.reserveUnit !== "troy-oz" ||
      block?.chain !== "ethereum" || typeof block.number !== "number" || !Number.isSafeInteger(block.number) || block.number <= 0 ||
      typeof block.timestamp !== "number" || block.timestamp > snapshot.fetchedAt || block.timestamp > now) return undefined;
  if (quoteObservedAtSec == null || quoteObservedAtSec > now) return undefined;
  const entitlement = CommodityEntitlementSchema.safeParse({
    source: "matrixdock-frs", generation: `ethereum:${block.number}`, quoteObservedAtSec,
    ozPerToken: details.ozPerToken, observedAtSec: block.timestamp,
  }).data;
  return getCommodityOuncesAtQuote(undefined, { assetId: "xagm-matrixdock", commodityEntitlement: entitlement, quoteObservedAtSec }) != null
    ? entitlement : undefined;
}

function selectedPegReferences(pegRates: PegRatesResult, generation: string, legacyFxPegs: ReadonlySet<string>): Record<string, SelectedPegReference> {
  const selected: Record<string, SelectedPegReference> = Object.create(null);
  for (const [pegKey, kind] of Object.entries(pegRates.sources)) {
    if (normalizePegType(pegKey) !== pegKey || pegKey === "peggedUSD" || legacyFxPegs.has(pegKey)) continue;
    if (kind === "median") {
      const contributors = pegRates.contributors?.[pegKey];
      if (contributors?.length) selected[pegKey] = {
        kind, pegKey, generation, usdPerUnit: pegRates.rates[pegKey], contributors: [...contributors],
      };
    } else {
      const reference = pegRates.observations?.[pegKey];
      if (!reference || reference.pegKey !== pegKey || reference.source === "peer-median") continue;
      const { repricing, contributors: _contributors, ...observation } = reference;
      selected[pegKey] = { kind, generation, observation, ...(repricing ? {
        repricing: {
          ...repricing, source: observation.source, preCloseUsdPerUnit: repricing.preCloseUsdPerUnit ?? undefined,
        },
      } : {}) };
    }
  }
  return selected;
}

/**
 * Normalizes the payload, admits rows per asset, and writes to the stablecoins cache. Returns the CAS
 * outcome on a publishable cohort (quarantined rows removed from `input.assets` so later stages see the
 * published cohort) or `{ written: false, blockedResult }` on a global validation failure.
 */
export async function validateAndWriteStablecoinsCache(
  input: ValidateAndCacheInput,
  buildBlockedResult: (stablecoinsCacheAgeSec: number | null) => CronResult,
): Promise<CacheValidationResult | CronResult> {
  const { assets, fxFallbackRates, db, syncStartSec, signal, validationContext } =
    input;

  // Tag frozen coins so /api/stablecoins exposes `frozen` and `frozenAt` per-coin.
  // Runs after intake's mergeFrozenSnapshots so injected rows also get tagged here.
  for (const asset of assets) {
    const hold = reviewedOnchainSupplyHoldFields(asset, syncStartSec);
    if (hold) Object.assign(asset, hold);
    const frozenMeta = FROZEN_META_BY_ID.get(asset.id);
    if (FROZEN_IDS.has(asset.id)) {
      asset.frozen = true;
      if (frozenMeta?.frozenAt != null) {
        asset.frozenAt = frozenMeta.frozenAt;
      } else {
        delete asset.frozenAt;
      }
      continue;
    }
    delete asset.frozen;
    delete asset.frozenAt;
  }

  const now = Math.floor(Date.now() / 1000);
  const xagm = assets.find(({ id }) => id === "xagm-matrixdock");
  if (xagm) {
    const entitlement = await readXagmEntitlement(db, now, xagm.priceObservedAtMode === "upstream" ? xagm.priceObservedAt ?? null : null).catch((error: unknown) => {
      logWorkerEventArgs("handler", "warn", "[sync-stablecoins] XAGm entitlement unavailable:", error);
      return undefined;
    });
    // The same cohort continues to depeg detection after a successful write.
    xagm.commodityEntitlement = entitlement;
  }

  const llamaData: StablecoinsPayload = { peggedAssets: assets, fxFallbackRates };
  const normalizedPayload = normalizeStablecoinsPayload(llamaData, syncStartSec);
  const publicFxEvidence = input.publishFxReferenceEvidence === true ? input.fxReferenceObservations : undefined;
  if (publicFxEvidence !== undefined) {
    // Legacy normalization aliases updatedAt. Admission needs the actual selected quote clock.
    normalizedPayload.peggedAssets.forEach((row, i) => {
      if (assets[i].priceObservedAt == null) row.priceObservedAt = null;
    });
  }
  const admission = admitPublishableAssets(normalizedPayload, publicFxEvidence);

  if (!admission.ok) {
    const issueSummary = summarizeValidationIssues(admission.issues);
    const stablecoinsCacheAgeSec = await getStablecoinsCacheAgeSec(db);
    logWorkerEventArgs("handler", "error",
      `[sync-stablecoins] Schema validation failed${validationContext === "fallback" ? " in CG fallback" : ""}; blocking stablecoins cache write:`,
      issueSummary,
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      validationContext,
      normalizedPayload,
      admission.issues,
      stablecoinsCacheAgeSec,
    );
    return {
      written: false,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      syncStartSec,
      blockedResult: buildBlockedResult(stablecoinsCacheAgeSec),
      quarantinedAssets: [],
    };
  }

  if (admission.quarantined.length > 0) {
    const issues = admission.quarantined.map((row) => `${row.id ?? "<no id>"}: ${row.issues}`).join("; ");
    logWorkerEventArgs("handler", "warn",
      `[sync-stablecoins] Quarantined ${admission.quarantined.length} schema-invalid asset(s)${validationContext === "fallback" ? " in CG fallback" : ""}; publishing valid peers:`,
      summarizeValidationIssues(issues),
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      validationContext,
      { peggedAssets: normalizedPayload.peggedAssets.filter((_, index) => admission.quarantinedIndexes.has(index)) },
      issues,
      null,
    );
    // normalizeStablecoinsPayload maps rows 1:1, so indexes address the caller's asset rows.
    const kept = assets.filter((_, index) => !admission.quarantinedIndexes.has(index));
    assets.splice(0, assets.length, ...kept);
  }

  // One optional cohort read: unavailable DEX evidence never becomes an agreement verdict.
  const fxReferenceObservations = admission.payload.fxReferenceObservations;
  const fxState = input.detectionFxState ?? null;
  const legacyFxPegs = fxState?.legacyDetectionPegs?.filter((peg) =>
    hasVerifiedLegacyRate(fxState, peg) && !input.fxReferenceObservations?.[peg] &&
    fxFallbackRates?.[peg] === fxState.rates[peg] &&
    getFxReferenceTypeFromState(fxState, peg, REFERENCE_INTRADAY_BUDGET_SEC, now) === "fresh") ?? [];
  const legacyFxPegSet = new Set(legacyFxPegs);
  const generation = `stablecoins:${syncStartSec}`;
  const pegRates = derivePegRates(admission.payload.peggedAssets, WORKER_TRACKED_META_BY_ID, fxFallbackRates,
    fxReferenceObservations, now, legacyFxPegs);
  if (fxReferenceObservations !== undefined) {
    admission.payload.selectedPegReferences = selectedPegReferences(pegRates, generation, legacyFxPegSet);
  }
  const coverageGeneration = crypto.randomUUID();
  admission.payload.fxAdmissionCoverageGeneration = coverageGeneration;
  const dexRows = await runWithOverloadRetry(() => db.prepare(
    "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at, price_sources_json FROM dex_prices",
  ).all<CurrentPegDexRow>(), 1, signal).then((result) => result.results ?? []).catch((error: unknown) => {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Current DEX comparison unavailable:", error);
    return [];
  });
  const observations = deriveCurrentPegObservationMap({
    peggedAssets: admission.payload.peggedAssets, pegRates, fxReferenceObservations, legacyFxPegs: legacyFxPegSet, generation, asOf: syncStartSec, now,
    dexPrices: selectCurrentPegDexPrices(dexRows, now),
  });
  for (const asset of admission.payload.peggedAssets) {
    const observation = observations.get(asset.id);
    if (observation) asset.currentPeg = CurrentPegSchema.parse({
      ...observation,
      // The legacy summary may compare DEX to a peg alone; this block accompanies a live quote.
      dexPriceCheck: observation.currentPriceUnavailable ? null : observation.dexPriceCheck,
    });
    else delete asset.currentPeg;
  }

  const cacheWriteAbort = returnIfAborted(
    signal,
    validationContext === "fallback" ? "fallback-cache-write" : "persist-main-cache",
  );
  if (cacheWriteAbort) return cacheWriteAbort;
  // The rollback Worker rederives from pegType using a static ounce.
  const stablecoinsCacheBody = JSON.stringify({
    ...admission.payload,
    peggedAssets: admission.payload.peggedAssets.map((asset) =>
      asset.id === "xagm-matrixdock" && normalizePegType(asset.pegType) === "peggedSILVER"
        ? { ...asset, pegType: XAGM_ENTITLEMENT_PEG_TYPE } : asset),
  });
  const bootstrap = admission.payload.peggedAssets.find(asset => asset.id === "buidl-blackrock"
    && asset.supplySource === "defillama" && asset.supplyRestored);
  // A delayed legacy carry cannot overwrite native success or bootstrap an absent predecessor.
  const write = bootstrap ? db.prepare(`
      UPDATE cache SET value = ?, updated_at = ? WHERE key = 'stablecoins' AND updated_at <= ?
        AND EXISTS (SELECT 1 FROM json_each(cache.value, '$.peggedAssets') AS prior
          WHERE json_extract(prior.value, '$.id') = 'buidl-blackrock'
            AND json_extract(prior.value, '$.supplySource') = 'defillama'
            AND json_extract(prior.value, '$.supplyRestored') = 1
            AND json_extract(prior.value, '$.supplyObservedAt') = ?)
    `).bind(stablecoinsCacheBody, syncStartSec, syncStartSec, bootstrap.supplyObservedAt)
    : prepareCacheUpsert(db, { key: "stablecoins", value: stablecoinsCacheBody, updatedAt: syncStartSec }, "if-newer");
  const responseReadyKey = getResponseReadyCacheKey("stablecoins");
  // Identify exactly which accepted cohort the clocked write replaced, including equal-clock retries.
  const [prior, committed] = await executeAtomicBatch(db, [
    db.prepare(`SELECT updated_at, CASE WHEN json_valid(value) THEN json_extract(value, '$.fxAdmissionCoverageGeneration') END AS generation
                FROM cache WHERE key = 'stablecoins'`), write,
    // The fast reader uses the source clock. Invalidate a replaced equal-clock body in the same transaction.
    db.prepare("DELETE FROM cache WHERE key = ? AND updated_at = ? AND changes() = 1").bind(responseReadyKey, syncStartSec),
  ], { returnResults: true, signal });
  const previous = prior.results[0] as { updated_at: number; generation: string | null } | undefined;
  const written = committed.meta.changes === 1;
  if (bootstrap && !written && (previous?.updated_at ?? 0) <= syncStartSec) {
    return {
      written: false, skippedBecauseNewer: false, cacheKey: "stablecoins", syncStartSec,
      quarantinedAssets: admission.quarantined,
      blockedResult: { status: "degraded", itemCount: 0,
        metadata: JSON.stringify({ reason: "buidl-bootstrap-predecessor-unavailable" }) },
    };
  }
  const cacheResult = { written, skippedBecauseNewer: !written };
  let responseReadyCacheError: string | null = null;
  if (cacheResult.written) {
    let coverageAssets = admission.payload.peggedAssets;
    if (fxReferenceObservations === undefined) {
      // Keep legacy display clock aliases out of the internal coverage measurement.
      coverageAssets = coverageAssets.map((row, i) => ({ ...row, priceObservedAt: assets[i].priceObservedAt ?? null }));
      if (input.fxReferenceObservations !== undefined) {
        const internalPegRates = derivePegRates(coverageAssets, WORKER_TRACKED_META_BY_ID, fxFallbackRates,
          input.fxReferenceObservations, now, legacyFxPegs);
        const internal = deriveCurrentPegObservationMap({ peggedAssets: coverageAssets, pegRates: internalPegRates,
          fxReferenceObservations: input.fxReferenceObservations, legacyFxPegs: legacyFxPegSet, generation, asOf: syncStartSec, now });
        for (const row of coverageAssets) row.currentPeg = internal.get(row.id);
      }
    }
    const legacy = {
      state: fxState, decisionAt: now, contributors: pegRates.contributors,
      pegs: input.fxReferenceObservations === undefined ? undefined : legacyFxPegSet,
    };
    await recordFxAdmissionCoverage(db, coverageAssets, syncStartSec,
      previous?.updated_at ?? null, coverageGeneration, previous?.generation ?? null, legacy).catch((error: unknown) => {
      logWorkerEventArgs("handler", "warn", "[sync-stablecoins] FX admission coverage write failed:", error);
    });
    try {
      const companion = prepareStablecoinsGenerationCompanion(db, responseReadyKey,
        encodeResponseReadyCacheValue(stablecoinsCacheBody, RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins), syncStartSec, coverageGeneration);
      await runWithOverloadRetry(() => companion.run(), 3, signal);
    } catch (error) {
      responseReadyCacheError = error instanceof Error ? error.name : "UnknownError";
    }
  }
  if (cacheResult.written) {
    logWorkerEventArgs("handler", "info",
      `[sync-stablecoins] ${validationContext === "fallback" ? "CG fallback: cached" : "Cached"} ${assets.length} assets`,
    );
  } else {
    logWorkerEventArgs("handler", "info",
      `[sync-stablecoins] Skipped stablecoins cache write; newer canonical cache already exists ` +
        `(syncStartSec=${syncStartSec})`,
    );
  }

  return {
    ...cacheResult,
    cacheKey: "stablecoins",
    syncStartSec,
    responseReadyCacheError,
    quarantinedAssets: admission.quarantined,
  };
}

export async function commitReplayPriceCache(input: {
  db: D1Database;
  entries: PriceCacheWriteEntry[];
  signal?: AbortSignal;
  stagePrefix?: string;
}): Promise<CronResult | null> {
  if (input.entries.length === 0) return null;
  const stage = `${input.stagePrefix ?? ""}save-price-cache`;
  const priceCacheWriteAbort = returnIfAborted(input.signal, stage);
  if (priceCacheWriteAbort) return priceCacheWriteAbort;
  await savePriceCache(input.db, input.entries);
  return null;
}
