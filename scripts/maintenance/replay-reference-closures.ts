#!/usr/bin/env node

// Boundary waiver: reference-closure-replay. See docs/process/boundary-waivers.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database as WorkerD1, D1PreparedStatement as WorkerD1Statement, D1Result as WorkerD1Result } from "@cloudflare/workers-types";
import { z } from "zod";
import { DEPEG_PENDING_MIN_AGE_SEC, DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { getNativeEventPriceObservation, isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { getCommodityOuncesAtQuote } from "@shared/lib/commodity-median";
import { getPegTaxonomyByType, pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { derivePegRates, getPegReference, normalizePegType, type PegRatesResult } from "@shared/lib/peg-rates";
import { BINANCE_MARKETS } from "@shared/lib/pricing-provider-config";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { admittedDeviationBps, evaluateReferenceAdmission, REFERENCE_INTRADAY_BUDGET_SEC } from "@shared/lib/reference-admission";
import {
  getReferenceMarket,
  getReferenceSessionState,
  REFERENCE_MARKET_REOPEN_GRACE_SEC,
  type ReferenceMarket,
} from "@shared/lib/reference-market-hours";
import { easterSundayUtcDaySec } from "@shared/lib/time-buckets";
import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { FxReferenceEvidenceMapSchema, FxReferenceObservationSchema, SelectedPegReferencesSchema,
  type FxReferenceEvidence, type FxReferenceObservation } from "@shared/types/fx-reference";
import { QuoteDerivationSchema } from "@shared/types/native-peg-quote";
import { DepegEventQuoteDomainSchema, DepegEventSchema, DepegEventStoredSnapshotSchema, PegSummaryCoinSchema, type DepegEventEntry } from "@shared/types/peg";
import { asRawDeviationBps, ReferenceContributorSchema } from "@shared/types/reference-admission";
import { UnixSecondsSchema } from "@shared/types/safety-schema-primitives";
import { StablecoinDataSchema, type StablecoinData } from "@shared/types/supply";
import {
  buildConfirmationPlan,
  buildDuplicateOpenEventRepair,
  collectConfirmationEvidence,
  computeDivergSignal,
  decideDepegAsset,
  evaluatePromotionDecision,
  FxSyncRunState,
  getDepegRecoveryThresholdBps,
  getDepegThresholdBps,
  getNativePegQueryCurrencies,
  hydrateFxRateState,
  isAffirmativeDexPriceRow,
  isNativeOriginPending,
  isNativeQuoteForPending,
  loadDexPrices,
  normalizePendingDepegRow,
  persistDepegCommands,
  POOL_CHALLENGE_MIN_TVL,
  SELECT_PENDING_CONFIRMATION_SQL,
  type ConfirmationEvidenceInput,
  type DEWSInput,
  type PendingDepegRow,
} from "../../worker/scripts/backfills/reference-closure-replay-adapter";
import {
  assessDetectionReference, assessIndependentPeerMove, attachDetectionReferenceContext, getClockedTradedNativeQuote,
  hasIncompatibleParityPrice, observationPegMeta, sourceObservationClock,
} from "../../worker/src/cron/depeg-detection/reference-policy";
import { deriveAuthoritativePegSignal } from "../../worker/src/cron/authoritative-peg-signal";
import { buildPendingClosureHoldStatements, readPendingObservationReceipt, readAdmittedPeerOnset } from "../../worker/src/lib/depeg-pending";
import { parsePendingReason, serializeDepegPriceCoverage } from "../../worker/src/lib/depeg-helpers";
import { getDewsPrimaryQuoteClock, hasIndependentDewsVenues, readDewsDexAggregateFamilies } from "../../worker/src/lib/dews/reference-evidence";
import { isAuthoritativeDepegPegReference } from "../../worker/src/lib/depeg-trust-policy";
import { fxSourceSampleKey, recordFxSourceSample, type FxReferenceSourceSamples } from "../../worker/src/lib/fx-observations";
import { isFreshFxObservation } from "../../worker/src/lib/fx-rate-state";
import { getPublishedReferenceEvidence } from "../../worker/src/lib/psi-reference";
import { parseStrictCliArgs, requireCliString, runDirectCli, writeCliHelpIfRequested, writeFileResolved } from "../lib/cli-args.mjs";
import { depegLedgerCaptureId } from "../lib/depeg-ledger-capture";
import { renderMarkdownRows } from "../lib/markdown-report";
import { createD1Client } from "../lib/remote-d1";

// The Node typecheck follows the imported Worker leaves without a Worker lib.
declare global {
  type D1Database = WorkerD1;
  type D1PreparedStatement = WorkerD1Statement;
  type D1Result<T = unknown> = WorkerD1Result<T>;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REMOVED_BY = "44f025dd34";
const BRL = "peggedREAL";
const TWO_HOURS = 2 * HOUR_SECONDS;
const BINANCE_SYMBOLS = new Set(BINANCE_MARKETS.map(({ symbol }) => symbol));

const REVIEWED = new Map([
  [24994, "PAXG premium, April 2024"],
  [89640, "EURS premium, April 2026"],
  [91044, "BRZ discount, November 2026"],
  [90024, "EURR suspension, 24 May 2026"],
]);

const USAGE = `Usage: node --import tsx scripts/maintenance/replay-reference-closures.ts --out <directory>
  [--captures <directory>] [--reference-cache <file>] [--d1] [--fx-producer]

Defaults to offline replay using agents/captures. --d1 adds production event-ledger SELECTs.
--reference-cache accepts a JSON array of FxReferenceObservation rows (USD per peg unit).
--fx-producer runs only the FX producer scenarios.
Writes receipt.json and summary.md to --out.`;

const positive = z.number().finite().positive();
const ratesSchema = z.record(z.string(), positive);
const matchedRiskSchema = z.object({ decisionAtSec: UnixSecondsSchema, generationAtSec: UnixSecondsSchema.nullable() });
const usdQuoteSchema = z.object({ priceUsd: positive, observedAtSec: UnixSecondsSchema });
const lineage = {
  upstreamKeys: z.array(z.string()).optional(),
  pricePoolKeys: z.array(z.string()).optional(),
};
const detectorAssetEvidenceSchema = z.object({
  ...lineage,
  commodityEntitlement: z.object({
    source: z.literal("matrixdock-frs"), generation: z.string().min(1), ozPerToken: positive,
    observedAtSec: UnixSecondsSchema.positive(), quoteObservedAtSec: UnixSecondsSchema.positive(),
  }).optional().catch(undefined),
});
const observedSourcesSchema = z.array(z.object({
  protocol: z.string(), chain: z.string(), price: positive, tvl: positive,
  updatedAt: UnixSecondsSchema, observedAt: UnixSecondsSchema, aggregateObservedAt: UnixSecondsSchema,
  sourceFamily: z.string().min(1),
  ...lineage,
}));
const evidenceSchema = z.object({
  nativePegQuote: z.object({
    stablecoinId: z.string(),
    geckoId: z.string(),
    pegCurrency: z.string(),
    vsCurrency: z.string().optional(),
    price: positive,
    updatedAt: UnixSecondsSchema,
    derivation: QuoteDerivationSchema.optional(),
  }).nullish(),
  challengerPools: z.array(z.object({
    price: positive, tvlUsd: positive, protocol: z.string(), chain: z.string(),
    observedAt: UnixSecondsSchema, sourceFamily: z.string(), ...lineage,
  })).optional(),
  dex: usdQuoteSchema.optional(),
  dexAggregate: z.object({
    priceUsd: positive, publishedAtSec: UnixSecondsSchema, sourceTotalTvl: positive,
    sourcePoolCount: z.number().int().nonnegative(), deviationFromPrimaryBps: z.number().finite().nullable(),
    sources: observedSourcesSchema,
    aggregateObservedAt: UnixSecondsSchema.positive().optional(),
    aggregateContributors: z.array(z.object({ providerFamily: z.string(), venueFamily: z.string() })).optional(),
    ...lineage,
  }).nullish(),
  binance: usdQuoteSchema.optional(),
  offchain: usdQuoteSchema.extend({ geckoId: z.string().min(1) }).optional(),
  tradedPairCoverage: z.object({ fromSec: UnixSecondsSchema, toSec: UnixSecondsSchema }).optional(),
  incumbentPsi: matchedRiskSchema.extend({ contributionBps: z.number().finite() }).optional(),
  incumbentDews: matchedRiskSchema.extend({
    divergence: z.number().min(0).max(100),
    currentDivergenceValue: z.number().min(0).max(100).nullish(),
    referenceDivergence: z.object({ value: z.number().min(0).max(100), observedAtSec: UnixSecondsSchema.positive() }).optional(),
  }).optional(),
});
const pendingSeedSchema = z.object({
  at: UnixSecondsSchema,
  rows: z.array(z.object({
    stablecoin_id: z.string(), symbol: z.string(), peg_type: z.string(), direction: z.enum(["above", "below"]),
    first_seen_bps: z.number().finite(), first_seen_at: UnixSecondsSchema, first_price: positive,
    last_seen_bps: z.number().finite(), last_seen_at: UnixSecondsSchema, last_price: positive,
    peak_seen_bps: z.number().finite(), peak_price: positive, peg_reference: positive, reason: z.string().min(1),
    peak_peg_reference: positive.nullish(),
    peer_basis_json: z.string().nullable().optional(),
    reference_market_held_at: UnixSecondsSchema.positive().nullable().optional(),
  })),
});
const recoveryClock = UnixSecondsSchema.positive().nullable().optional();
const openSeedSchema = z.object({ at: UnixSecondsSchema, rows: z.array(DepegEventSchema.and(z.object({
  quoteMode: DepegEventQuoteDomainSchema.nullable().optional(),
  recoveryFirstSeenAt: recoveryClock,
  recoveryLastSeenAt: recoveryClock,
  recoveryEvidenceSource: z.enum(["dex", "native"]).nullable().optional(),
  recoveryUsdFirstSeenAt: recoveryClock,
  recoveryUsdObservedAt: recoveryClock,
  peerBasisJson: z.string().nullable().optional(),
  referenceHoldJson: z.string().nullable().optional(),
}))) });
const medianCaptureSchema = z.object({
  generationAtSec: UnixSecondsSchema,
  usdPerUnit: positive,
  contributors: z.array(ReferenceContributorSchema.extend({
    stablecoinId: z.string().min(1), normalizedPriceUsd: positive,
  })).min(1),
});
const captureSchema = z.object({
  peggedAssets: z.array(z.unknown()).optional(),
  stablecoins: z.array(z.unknown()).optional(),
  coins: z.array(z.unknown()).optional(),
  fxFallbackRates: ratesSchema.optional(),
  fxReferenceObservations: FxReferenceEvidenceMapSchema.optional(),
  selectedPegReferences: SelectedPegReferencesSchema.optional(),
  _meta: z.object({ updatedAt: UnixSecondsSchema.optional(), assessedAt: UnixSecondsSchema.optional() }).optional(),
  decisionAtSec: UnixSecondsSchema.optional(),
  collectedAt: z.union([UnixSecondsSchema, z.string()]).optional(),
  collectedAtIso: z.string().optional(),
  replayEvidence: z.record(z.string(), evidenceSchema).optional(),
  medianReferences: z.record(z.string(), medianCaptureSchema).optional(),
  detectorCensusComplete: z.boolean().optional(),
  pendingSeed: pendingSeedSchema.optional(),
  openSeed: openSeedSchema.optional(),
});
type Evidence = z.output<typeof evidenceSchema>;
type Asset = Parameters<typeof decideDepegAsset>[0]["asset"] & Pick<StablecoinData, "parityQuoteUnit" | "priceDerivation">;
type Frame = {
  at: number; generationAt: number | null; source: string; assets: Asset[]; rates: Record<string, number>;
  evidence: Record<string, Evidence>;
  fxObservations: NonNullable<z.output<typeof captureSchema>["fxReferenceObservations"]>;
  dewsReferences: Map<string, NonNullable<ReturnType<typeof getPublishedReferenceEvidence>>>;
  medians: NonNullable<z.output<typeof captureSchema>["medianReferences"]>;
  censusComplete: boolean;
  pendingSeed?: z.output<typeof pendingSeedSchema>;
  openSeed?: z.output<typeof openSeedSchema>;
};
type UntimedFrame = { source: string; generationAt: number | null; assets: number; reason: "capture-availability-unmeasurable" };
type Closure = {
  market: ReferenceMarket; from: number; to: number; labels: Set<string>;
  calendar: "market" | "target";
};
type DecisionInput = Pick<Parameters<typeof decideDepegAsset>[0],
  | "now" | "asset" | "meta" | "existing" | "pegRates" | "pegRateSources" | "pegRateCounts"
  | "nativePegQuote" | "challengerPools" | "dexRow" | "protocolSources" | "referenceContext">;

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (at: number) => new Date(at * 1000).toISOString();
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const pegOf = (asset: Pick<Asset, "id" | "pegType">) => normalizePegType(asset.pegType
  ?? pegTypeFromCurrency(PSI_ELIGIBLE_META_BY_ID.get(asset.id)?.flags.pegCurrency));
const marketOf = (peg: string | undefined) => getReferenceMarket(getPegTaxonomyByType(peg)?.currency);

function loadArchive() {
  const dir = resolve(ROOT, "data/depeg-events");
  const yearShards = (paths: string[]) => paths.filter((name) => /^\d{4}\.json$/.test(name)).sort();
  const years = yearShards(readdirSync(dir));
  const events = years.flatMap((file) => DepegEventStoredSnapshotSchema.parse(readJson(join(dir, file))));
  const ids = new Set(events.map(({ id }) => id));
  function historicalIds(revision: string) {
    const tree = `${revision}:data/depeg-events`;
    const git = (args: string[]) => execFileSync("git", args, {
      cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
    });
    return yearShards(git(["ls-tree", "-z", "--name-only", tree]).split("\0")).flatMap((file) => {
      const raw = git(["show", `${tree}/${file}`]);
      return DepegEventStoredSnapshotSchema.parse(JSON.parse(raw));
    });
  }
  const after = new Set(historicalIds(REMOVED_BY).map(({ id }) => id));
  const removed = historicalIds(`${REMOVED_BY}^`).filter((event) => !after.has(event.id) && marketOf(event.pegType) != null);
  for (const id of [24994, 89640]) {
    if (!removed.some((row) => row.id === id)) throw new Error(`Historical removal ${id} missing`);
  }
  return { events, deleted: removed.filter(({ id }) => !ids.has(id)), identity: depegLedgerCaptureId(dir) };
}

function loadD1Events() {
  const client = createD1Client("stablecoin-db", { cwd: resolve(ROOT, "worker"), target: "remote" });
  const events: DepegEventEntry[] = [];
  let cursor = 0;
  for (;;) {
    const page = DepegEventStoredSnapshotSchema.parse(client.query<unknown>(
      `SELECT id, stablecoin_id AS stablecoinId, symbol, peg_type AS pegType, direction,
        peak_deviation_bps AS peakDeviationBps, started_at AS startedAt, ended_at AS endedAt,
        start_price AS startPrice, peak_price AS peakPrice, recovery_price AS recoveryPrice,
        peg_reference AS pegReference, source, confirmation_sources AS confirmationSources,
        pending_reason AS pendingReason, close_reason AS closeReason, CAST(id AS TEXT) AS slug
       FROM depeg_events WHERE id > ${cursor} AND peg_type <> 'peggedUSD' ORDER BY id LIMIT 500`,
    ));
    for (const event of page) {
      if (!Number.isSafeInteger(event.id) || event.id <= cursor) throw new Error("Invalid D1 event pagination");
      cursor = event.id;
      events.push(event);
    }
    if (page.length < 500) return events;
  }
}

const capturedPegSchema = PegSummaryCoinSchema.pick({
  id: true, symbol: true, pegType: true, price: true, priceSource: true, priceConfidence: true,
  priceUpdatedAt: true, priceObservedAt: true, priceObservedAtMode: true, nominalPriceReference: true,
  priceSyncedAt: true, agreeSources: true, consensusSources: true, currentDeviationBps: true,
});
function loadFrames(dir: string) {
  if (!existsSync(dir)) throw new Error(`Capture directory missing: ${dir}`);
  const frames: Frame[] = [];
  const untimed: UntimedFrame[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/stablecoins|peg|blind-events|list|replay/i.test(entry.name) || !entry.name.endsWith(".json")) continue;
    const file = join(entry.parentPath, entry.name);
    const payload = readJson(file);
    const parsed = captureSchema.safeParse(payload);
    if (!parsed.success) {
      if (payload && typeof payload === "object" &&
        ("replayEvidence" in payload || "openSeed" in payload || "pendingSeed" in payload)) throw parsed.error;
      continue;
    }
    const { peggedAssets, stablecoins, coins, fxFallbackRates, fxReferenceObservations, selectedPegReferences,
      _meta, decisionAtSec, collectedAt, collectedAtIso,
      replayEvidence, medianReferences, detectorCensusComplete, pendingSeed, openSeed } = parsed.data;
    const rows = peggedAssets ?? stablecoins ?? coins ?? (openSeed || pendingSeed ? [] : undefined);
    if (!rows) continue;
    const source = relative(ROOT, file);
    const generationAt = _meta?.updatedAt ?? null;
    const at = decisionAtSec ?? _meta?.assessedAt ?? (typeof collectedAt === "number" ? collectedAt : sec(collectedAtIso ?? collectedAt ?? ""));
    if (!UnixSecondsSchema.safeParse(at).success || (generationAt != null && at < generationAt)) {
      untimed.push({ source, generationAt, assets: rows.length, reason: "capture-availability-unmeasurable" });
      continue;
    }
    const assets = rows.flatMap<Asset>((row) => {
      const stablecoin = StablecoinDataSchema.safeParse(row);
      if (stablecoin.success) {
        const evidence = detectorAssetEvidenceSchema.safeParse(row).data;
        return [{ ...stablecoin.data, ...evidence, commodityEntitlement: evidence?.commodityEntitlement }];
      }
      const peg = capturedPegSchema.safeParse(row);
      return peg.success ? [peg.data] : [];
    });
    if (assets.length || openSeed || pendingSeed) frames.push({
      at, generationAt, assets, source, rates: fxFallbackRates ?? {}, evidence: replayEvidence ?? {},
      fxObservations: fxReferenceObservations ?? {},
      dewsReferences: new Map(Object.entries(selectedPegReferences ?? {}).flatMap(([peg, ref]) => {
        if (generationAt === null || normalizePegType(peg) !== peg || (ref.kind === "median"
          ? ref.contributors.some((row) => row.observedAtSec == null || row.observedAtSec > at)
          : (ref.observation.publishedAtSec ?? ref.observation.observedAtSec) > generationAt)) return [];
        const evidence = getPublishedReferenceEvidence(ref, `stablecoins:${generationAt}`, at);
        return evidence ? [[peg, evidence] as const] : [];
      })),
      medians: medianReferences ?? {}, pendingSeed, openSeed,
      censusComplete: detectorCensusComplete === true && assets.length === rows.length,
    });
  }
  frames.sort((a, b) => a.at - b.at || Number(b.censusComplete) - Number(a.censusComplete)
    || Object.keys(b.evidence).length - Object.keys(a.evidence).length
    || b.assets.length - a.assets.length || a.source.localeCompare(b.source));
  return { frames, untimed };
}

function discoverClosures(events: DepegEventEntry[], frames: Frame[], observations: readonly FxReferenceObservation[]): Closure[] {
  const closures = new Map<string, Closure>();
  function add(market: ReferenceMarket, from: number, to: number, label?: string, calendar: Closure["calendar"] = "market") {
    const key = `${market}/${from}/${to}`;
    const closure = closures.get(key) ?? { market, from, to, calendar, labels: new Set<string>() };
    if (label) closure.labels.add(label);
    closures.set(key, closure);
  }
  function at(market: ReferenceMarket, now: number, label?: string) {
    const state = getReferenceSessionState(market, now);
    if (!state.open) add(market, state.closureStartSec, state.nextOpenSec, label);
    else if (now - state.sessionOpenedAtSec <= REFERENCE_MARKET_REOPEN_GRACE_SEC) {
      const prior = getReferenceSessionState(market, state.sessionOpenedAtSec - 1);
      if (!prior.open) add(market, prior.closureStartSec, prior.nextOpenSec, label);
    }
  }
  for (const event of events) {
    const market = marketOf(event.pegType);
    if (!market) continue;
    at(market, event.startedAt, REVIEWED.get(event.id));
    if (event.endedAt !== null) at(market, event.endedAt);
    for (const [from, to] of event.priceCoverage?.intervals ?? []) {
      at(market, from);
      at(market, to);
    }
    for (const { fromSec, toSec } of event.admittedCoverage ?? []) {
      at(market, fromSec);
      at(market, toSec);
    }
  }
  for (const observation of observations) {
    const market = marketOf(observation.pegKey);
    if (market) at(market, observation.publishedAtSec ?? observation.observedAtSec);
  }
  for (const frame of frames) {
    for (const market of new Set(frame.assets.map((asset) => marketOf(pegOf(asset))))) {
      if (market) at(market, frame.at);
    }
    for (const row of frame.openSeed?.rows ?? []) {
      const market = marketOf(row.pegType);
      if (market) at(market, frame.openSeed!.at);
    }
    for (const row of frame.pendingSeed?.rows ?? []) {
      const market = marketOf(row.peg_type);
      if (market) at(market, frame.pendingSeed!.at);
    }
  }
  for (const market of ["fx", "metal"] as const) {
    at(market, sec("2026-11-14T12:00:00Z"), "14–15 November 2026 weekend");
    for (const year of [2025, 2026, 2027]) {
      at(market, sec(`${year}-01-01T12:00:00Z`), `New Year ${year}`);
      if (year === 2027) continue;
      at(market, sec(`${year}-12-25T12:00:00Z`), `Christmas ${year}`);
      const goodFriday = easterSundayUtcDaySec(year) - 2 * DAY_SECONDS;
      if (market === "metal") at(market, goodFriday + 12 * HOUR_SECONDS, `Good Friday ${year}`);
      else add(market, goodFriday, goodFriday + 4 * DAY_SECONDS, `Good Friday and Easter Monday ${year} (ECB fixing)`, "target");
    }
  }
  return [...closures.values()].sort((a, b) => a.from - b.from || a.market.localeCompare(b.market));
}

function referenceEvidence(pegKey: string, now: number, observations: readonly FxReferenceObservation[]): FxReferenceEvidence | undefined {
  const available = observations.filter((row) => row.pegKey === pegKey && row.source !== "peer-median"
    && (row.publishedAtSec ?? row.observedAtSec) <= now);
  const observation = available.at(-1);
  if (!observation) return undefined;
  const samples: FxReferenceSourceSamples = {};
  for (const row of available) {
    if (row.source !== observation.source) continue;
    recordFxSourceSample(samples, row, (prior, atSec) => isFreshFxObservation(prior.observedAtSec, "live", atSec, {
      pegKey, cadence: prior.cadence, sourceDate: prior.cadence === "intraday" ? null : iso(prior.observedAtSec).slice(0, 10),
    }));
  }
  const sample = samples[fxSourceSampleKey(observation)];
  return { ...observation, ...(sample?.observation === observation
    ? { repricing: { source: observation.source, ...sample.evidence } } : {}) };
}

function selectedMedian(frame: Frame, priced: Asset[], peg: string, derived: PegRatesResult) {
  const captured = frame.medians[peg];
  const selected = derived.contributors?.[peg];
  if (!captured || frame.generationAt !== captured.generationAtSec || captured.usdPerUnit !== derived.rates[peg] ||
    !selected || selected.length !== captured.contributors.length ||
    new Set(captured.contributors.map(({ stablecoinId }) => stablecoinId)).size !== selected.length) return undefined;
  for (const item of captured.contributors) {
    const proof = selected.find(({ assetId }) => assetId === item.stablecoinId);
    const matches = priced.filter(({ id }) => id === item.stablecoinId);
    if (matches.length !== 1 || !proof || proof.observedAtSec !== item.observedAtSec ||
      proof.provenanceKey !== item.provenanceKey || proof.derivation !== item.derivation) return undefined;
    const asset = matches[0];
    const ounces = peg === "peggedGOLD" || peg === "peggedSILVER" ? getCommodityOuncesAtQuote(
      PSI_ELIGIBLE_META_BY_ID.get(asset.id)?.commodityOunces,
      { assetId: asset.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec: asset.priceObservedAt },
    ) : 1;
    if (pegOf(asset) !== peg || asset.price == null || ounces == null || asset.price / ounces !== item.normalizedPriceUsd) return undefined;
  }
  return selected;
}

function replayReferences(frame: Frame, priced: Asset[], openIds: ReadonlySet<string>, observations: readonly FxReferenceObservation[]) {
  const rates = { ...frame.rates };
  const pegs = new Set([...Object.keys(rates), ...Object.keys(frame.fxObservations),
    ...priced.flatMap((asset) => pegOf(asset) ?? [])].map(normalizePegType));
  const refs: Record<string, FxReferenceEvidence> = {};
  for (const peg of pegs) {
    if (!peg || !marketOf(peg)) continue;
    const at = frame.generationAt ?? frame.at;
    const captured = frame.fxObservations[peg];
    const ref = captured && (captured.publishedAtSec ?? captured.observedAtSec) <= at &&
      captured.contributors?.some((row) => row.observedAtSec == null || row.observedAtSec > at) !== true
      ? captured : referenceEvidence(peg, at, observations);
    if (ref) refs[peg] = ref;
  }
  const eligible = priced.filter((asset) => !hasIncompatibleParityPrice(asset) &&
    (asset.id !== "xagm-matrixdock" || observationPegMeta(asset, PSI_ELIGIBLE_META_BY_ID.get(asset.id))));
  const derived = derivePegRates(eligible, PSI_ELIGIBLE_META_BY_ID, rates, refs, frame.at);
  const contributors: NonNullable<PegRatesResult["contributors"]> = {};
  for (const peg of pegs) {
    if (!peg || derived.sources[peg] !== "median") continue;
    contributors[peg] = derived.observations?.[peg]?.source === "peer-median"
      ? derived.contributors?.[peg] : selectedMedian(frame, eligible, peg, derived);
  }
  const generation = frame.generationAt === null ? undefined : `${frame.source}@${frame.generationAt}`;
  const selected = { observations: derived.observations, contributors };
  const referenceContext = attachDetectionReferenceContext(derived.rates, eligible, PSI_ELIGIBLE_META_BY_ID,
    openIds, null, undefined, derived.counts, selected);
  referenceContext.generation = generation;
  return { ...derived, ...selected, referenceContext, generation };
}

function hydrateReplayFx(rates: Record<string, number>, at: number, metadata: object) {
  const value = JSON.stringify(rates);
  return hydrateFxRateState({ value, updatedAt: at }, {
    value: JSON.stringify({ ...metadata, ratesSha256: createHash("sha256").update(value).digest("hex") }), updatedAt: at,
  });
}

function replayReferenceSelection(derived: ReturnType<typeof replayReferences>, pegKey: string, at: number) {
  const generation = derived.generation ?? `replay:${at}`;
  const kind = derived.sources[pegKey];
  const usdPerUnit = derived.rates[pegKey];
  if (kind === "median") {
    const contributors = derived.contributors[pegKey];
    return contributors?.length ? { kind, pegKey, generation, usdPerUnit, contributors } : undefined;
  }
  const reference = derived.observations?.[pegKey];
  if (!kind || !reference || reference.pegKey !== pegKey || reference.usdPerUnit !== usdPerUnit ||
    reference.source === "peer-median") return undefined;
  const { repricing } = reference;
  return getPublishedReferenceEvidence({
    kind, generation, observation: reference, repricing: repricing && { ...repricing, source: reference.source },
  }, generation, at);
}

type OpenRow = NonNullable<DecisionInput["existing"]>;
type SimulatorDb = Parameters<typeof buildConfirmationPlan>[0]["db"];

async function loadCapturedDex(db: SimulatorDb, frame: Frame) {
  await db.prepare("DELETE FROM dex_prices").run();
  for (const [id, { dexAggregate: dex }] of Object.entries(frame.evidence)) {
    if (!dex || dex.publishedAtSec > frame.at) continue;
    const symbol = frame.assets.find((asset) => asset.id === id)?.symbol;
    if (!symbol) continue;
    await db.prepare(`INSERT INTO dex_prices (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl,
      deviation_from_primary_bps, price_sources_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, symbol, dex.priceUsd, dex.sourcePoolCount, dex.sourceTotalTvl, dex.deviationFromPrimaryBps,
        JSON.stringify({ aggregateObservedAt: dex.aggregateObservedAt ?? null, aggregateContributors: dex.aggregateContributors,
          pricePoolKeys: dex.pricePoolKeys, upstreamKeys: dex.upstreamKeys, sources: dex.sources }), dex.publishedAtSec).run();
  }
  return loadDexPrices(db, frame.at);
}

function freshUsdQuote<T extends z.output<typeof usdQuoteSchema>>(quote: T | undefined, now: number): T | undefined {
  return quote && quote.observedAtSec <= now && now - quote.observedAtSec <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC ? quote : undefined;
}

async function collectCapturedConfirmation(args: ConfirmationEvidenceInput, offchain: Evidence["offchain"]) {
  if (!offchain) return collectConfirmationEvidence(args);
  const previousFetch = globalThis.fetch;
  // The Worker transport consumes a recorded response. No request in this scope can leave Node.
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://api.coingecko.com" || url.pathname !== "/api/v3/simple/price" ||
      url.searchParams.get("ids") !== offchain.geckoId || url.searchParams.get("vs_currencies") !== "usd") {
      throw new Error("Unexpected transport request during offline confirmation replay");
    }
    return Response.json({ [offchain.geckoId]: { usd: offchain.priceUsd, last_updated_at: offchain.observedAtSec } });
  };
  try {
    return await collectConfirmationEvidence({ ...args, coingeckoAllowed: true });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function runDetector(input: DecisionInput, db: SimulatorDb, evidence: Evidence | undefined) {
  const decision = decideDepegAsset(input);
  const attempt = decision.commands.find((command) => command.type === "upsert-pending");
  const attempted = attempt?.payload.seenAt ?? null;
  const gaps: string[] = [];
  if (decision.observation?.kind !== "below-floor") {
    if (evidence?.dexAggregate !== null && (!input.dexRow || !isAffirmativeDexPriceRow(input.dexRow, input.now, "depeg") ||
      (input.protocolSources?.length ?? 0) !== evidence?.dexAggregate?.sources.length)) gaps.push("dex-evidence-unavailable");
    if (!evidence?.challengerPools || input.challengerPools?.length !== evidence.challengerPools.length) {
      gaps.push("pool-evidence-unavailable");
    }
    const native = input.nativePegQuote;
    const nativeReadComplete = evidence?.nativePegQuote === null || native != null && native.geckoId === input.meta?.geckoId &&
      (native.derivation?.kind === "conversion" || getClockedTradedNativeQuote(native, input.now) != null);
    if (input.meta?.geckoId && getNativePegQueryCurrencies(input.meta.flags.pegCurrency).length && !nativeReadComplete) {
      gaps.push("native-evidence-unavailable");
    }
  }
  const commands = [...decision.commands];
  if (input.existing && decision.priceCoverage) {
    commands.unshift({ type: "record-price-coverage", id: input.existing.id, coverage: decision.priceCoverage,
      referenceHold: decision.referenceHold, admittedCoverage: decision.admittedCoverage });
  }
  await persistDepegCommands(db, commands);
  const pending = await db.prepare(`${SELECT_PENDING_CONFIRMATION_SQL} WHERE pending.stablecoin_id = ?`)
    .bind(input.asset.id).first<PendingDepegRow>();
  if (!pending) return { decision, opened: null, attempted, gaps };

  const existing = await db.prepare("SELECT id FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL")
    .bind(input.asset.id).first<{ id: number }>();
  const plan = buildConfirmationPlan({
    db, row: pending, pendingState: normalizePendingDepegRow(pending),
    asset: input.asset, meta: input.meta, pegRates: input.pegRates, pegRateSources: input.pegRateSources,
    pegRateCounts: input.pegRateCounts, nativePegQuote: input.nativePegQuote,
    openSet: new Set(existing ? [input.asset.id] : []), challengerPools: input.challengerPools,
    referenceContext: input.referenceContext, now: input.now,
  });
  let statements;
  if (plan.kind === "mutate") {
    statements = plan.statements;
  } else if (plan.kind === "wait") {
    const heldAt = plan.reason === "reference-market-closed" && !plan.legacyClosure ? input.now : null;
    if (plan.reason === "peg-reference-unavailable") gaps.push(plan.reason);
    statements = buildPendingClosureHoldStatements(db, pending, heldAt);
  } else {
    const id = input.asset.id;
    const symbol = input.asset.symbol.toUpperCase();
    const binance = BINANCE_SYMBOLS.has(symbol) ? freshUsdQuote(evidence?.binance, input.now) : undefined;
    const offchain = freshUsdQuote(evidence?.offchain, input.now);
    const confirmation = plan.independentBasis ? plan.evidence : await collectCapturedConfirmation({
      ...plan, db, now: input.now,
      dexPriceRows: new Map(input.dexRow ? [[id, input.dexRow]] : []),
      dexPriceSources: new Map(input.protocolSources ? [[id, input.protocolSources]] : []),
      poolChallengers: new Map(input.challengerPools ? [[id, input.challengerPools]] : []),
      cexAllowed: true, cexPrices: binance ? new Map([[symbol, binance.priceUsd]]) : null,
      coingeckoAllowed: false, coingeckoApiKey: null, signal: undefined,
    }, offchain?.geckoId === input.meta?.geckoId ? offchain : undefined);
    gaps.push(...confirmation.circuitOpenSources);
    for (const source of confirmation.unavailableSources) {
      if (source.endsWith(":usd-native-origin") || (source === "pool:challenger" && input.challengerPools?.length === 0) ||
        (source === plan.nativeSourceKey && evidence?.nativePegQuote === null) ||
        (source === "dex:aggregate" && evidence?.dexAggregate === null)) continue;
      gaps.push(source);
    }
    statements = evaluatePromotionDecision({ db, plan, now: input.now, evidence: confirmation });
    statements.unshift(...buildPendingClosureHoldStatements(db, pending, null));
  }
  if (statements.length) await db.batch(statements);
  const opened = existing ? null : await db.prepare(
    "SELECT * FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
  ).bind(input.asset.id).first<OpenRow>();
  return { decision, opened, attempted, gaps };
}

type OpenSeedEvent = z.output<typeof openSeedSchema>["rows"][number];

function boundaryQuoteMode(event: OpenSeedEvent) {
  return event.quoteMode !== undefined ? event.quoteMode : event.provenance?.quoteMode;
}

function boundaryOpenRow(event: OpenSeedEvent): OpenRow {
  const coverage = event.priceCoverage;
  return {
    id: event.id, stablecoin_id: event.stablecoinId, symbol: event.symbol, peg_type: event.pegType, direction: event.direction,
    started_at: event.startedAt, ended_at: null, start_price: event.startPrice, peak_price: event.peakPrice,
    recovery_price: null, peak_deviation_bps: event.peakDeviationBps,
    peg_reference: event.pegReference, source: event.source, pending_reason: event.pendingReason,
    confirmation_sources: event.confirmationSources,
    peak_peg_reference: event.peakPegReference, peak_quote_domain: event.peakQuoteDomain,
    admitted_coverage_json: event.admittedCoverage ? JSON.stringify(event.admittedCoverage) : null,
    disposition: event.disposition, peer_basis_json: event.peerBasisJson, reference_hold_json: event.referenceHoldJson,
    price_coverage_json: coverage ? serializeDepegPriceCoverage(coverage) : null,
    last_trusted_price_at: coverage?.lastTrustedObservationAt ?? null,
    price_coverage_gap_started_at: coverage?.gapStartedAt ?? null,
    recovery_first_seen_at: event.recoveryFirstSeenAt, recovery_last_seen_at: event.recoveryLastSeenAt,
    recovery_evidence_source: event.recoveryEvidenceSource,
    recovery_usd_first_seen_at: event.recoveryUsdFirstSeenAt, recovery_usd_observed_at: event.recoveryUsdObservedAt,
  };
}

async function seedClosure(db: SimulatorDb, at: number, market: ReferenceMarket, openSeed: Frame["openSeed"], seed: Frame["pendingSeed"]) {
  let complete = openSeed !== undefined && seed !== undefined;
  const rows = (openSeed?.rows ?? []).filter((event) => {
    const meta = PSI_ELIGIBLE_META_BY_ID.get(event.stablecoinId);
    if (marketOf(event.pegType) !== market) return false;
    const first = event.recoveryFirstSeenAt;
    const last = event.recoveryLastSeenAt;
    const firstUsd = event.recoveryUsdFirstSeenAt;
    const lastUsd = event.recoveryUsdObservedAt;
    const clocks = [first, last, firstUsd, lastUsd];
    const quoteMode = boundaryQuoteMode(event);
    if (event.startedAt > at || event.endedAt !== null || (event.priceCoverage?.lastTrustedObservationAt ?? 0) > at ||
      (event.priceCoverage?.gapStartedAt ?? 0) > at ||
      event.priceCoverage?.intervals.some(([, end]) => end > at) ||
      event.priceCoverage?.atParIntervals?.some(([, end]) => end > at) ||
      event.admittedCoverage?.some(({ toSec }) => toSec > at) ||
      clocks.some((clock) => clock != null && (clock < event.startedAt || clock > at)) ||
      (first != null && last != null && first > last) || (firstUsd != null && lastUsd != null && firstUsd > lastUsd) ||
      (quoteMode != null && !DepegEventQuoteDomainSchema.safeParse(quoteMode).success)) {
      throw new Error("Invalid open incident in boundary snapshot");
    }
    complete &&= clocks.every((clock) => clock !== undefined) && (first == null) === (last == null)
      && (firstUsd == null) === (lastUsd == null) && quoteMode !== undefined && event.recoveryEvidenceSource !== undefined
      && (event.recoveryEvidenceSource == null || first != null) && (firstUsd == null || event.recoveryEvidenceSource === "native")
      && (!parsePendingReason(event.pendingReason).has("peer-relative") || !!readPendingObservationReceipt(event.peerBasisJson)?.onset);
    return meta != null && !meta.flags.navToken;
  });
  const open = rows.map(boundaryOpenRow);
  for (const [index, row] of open.entries()) {
    await db.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
      started_at, start_price, peak_price, peg_reference, source, pending_reason, confirmation_sources,
      price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at, peak_peg_reference, peak_quote_domain,
      admitted_coverage_json, disposition, peer_basis_json, reference_hold_json, recovery_first_seen_at,
      recovery_last_seen_at, recovery_evidence_source, recovery_usd_first_seen_at, recovery_usd_observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.stablecoin_id, row.symbol, row.peg_type, row.direction, row.peak_deviation_bps,
        row.started_at, row.start_price, row.peak_price, row.peg_reference, row.source, row.pending_reason,
        row.confirmation_sources, row.price_coverage_json ?? null, row.last_trusted_price_at ?? null,
        row.price_coverage_gap_started_at ?? null, row.peak_peg_reference ?? null, row.peak_quote_domain ?? null,
        row.admitted_coverage_json ?? null, row.disposition ?? null, row.peer_basis_json ?? null, row.reference_hold_json ?? null,
        row.recovery_first_seen_at ?? null, row.recovery_last_seen_at ?? null, row.recovery_evidence_source ?? null,
        row.recovery_usd_first_seen_at ?? null, row.recovery_usd_observed_at ?? null).run();
    const quoteMode = boundaryQuoteMode(rows[index]);
    if (quoteMode != null) {
      await db.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, row.source, quoteMode, at, at).run();
    }
  }
  await persistDepegCommands(db, buildDuplicateOpenEventRepair(open).commands);
  for (const row of seed?.rows ?? []) {
    if (marketOf(row.peg_type) !== market) continue;
    const receipt = readPendingObservationReceipt(row.peer_basis_json);
    const onset = receipt?.onset;
    const firstObservationAt = onset?.seenAt === row.first_seen_at ? onset.observedAt : row.first_seen_at;
    if (row.first_seen_at > row.last_seen_at || row.last_seen_at > at || (row.reference_market_held_at ?? 0) > at ||
      [onset, receipt?.latest, receipt?.peak].some((point) => point && (
        point.observedAt < firstObservationAt || point.observedAt > (point.seenAt ?? at) ||
        (point.seenAt != null && (point.seenAt < row.first_seen_at || point.seenAt > row.last_seen_at))))) {
      throw new Error("Pending seed observation is outside its boundary");
    }
    complete &&= !(isNativeOriginPending(row.reason) || parsePendingReason(row.reason).has("peer-relative"))
      || (onset?.seenAt ?? onset?.observedAt) === row.first_seen_at;
    await db.prepare(`INSERT INTO depeg_pending (stablecoin_id, symbol, peg_type, direction, first_seen_bps,
      first_seen_at, first_price, last_seen_bps, last_seen_at, last_price, peak_seen_bps, peak_price,
      peg_reference, reason, updated_at, peer_basis_json, reference_market_held_at, peak_peg_reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.stablecoin_id, row.symbol, row.peg_type, row.direction, row.first_seen_bps, row.first_seen_at,
        row.first_price, row.last_seen_bps, row.last_seen_at, row.last_price, row.peak_seen_bps,
        row.peak_price, row.peg_reference, row.reason, row.last_seen_at, row.peer_basis_json ?? null,
        row.reference_market_held_at ?? null, row.peak_peg_reference ?? null).run();
  }
  return complete;
}

function replayArchivedOnset(event: DepegEventEntry, observations: readonly FxReferenceObservation[]) {
  const peg = normalizePegType(event.pegType) ?? event.pegType;
  const meta = PSI_ELIGIBLE_META_BY_ID.get(event.stablecoinId);
  const observation = referenceEvidence(peg, event.startedAt, observations);
  const kind = marketOf(peg) === "metal" ? "fallback" : "fx";
  const native = isNativeOriginPending(event.pendingReason) || isNativePegEvent({
    source: event.source, peg_type: peg, peg_reference: event.pegReference, quote_mode: event.provenance?.quoteMode,
  });
  const admission = evaluateReferenceAdmission({
    ...(observation ? { kind, observation } : { kind: "none" }),
    quoteObservedAtSec: null, decisionAtSec: event.startedAt, rawDeviationBps: null, purpose: "detection",
    generation: `archive-event-${event.id}`,
  });
  // A ledger onset supplies an event time without the deciding quote clock, cap or corroborating prints.
  const result = decideDepegAsset({
    now: event.startedAt,
    asset: { id: event.stablecoinId, symbol: event.symbol, pegType: peg, price: native ? null : event.startPrice },
    meta, pegRates: observation ? { [peg]: observation.usdPerUnit } : {},
    pegRateSources: observation ? { [peg]: kind } : {}, pegRateCounts: {},
  });
  return {
    id: event.id, stablecoinId: event.stablecoinId, startedAt: event.startedAt, endedAt: event.endedAt,
    peakBps: event.peakDeviationBps, confirmationSources: event.confirmationSources,
    onsetReferenceAdmission: admission, detectorOutcome: result.observation ?? null,
  };
}

function dewsDivergence(frame: Frame, asset: Asset, peg: string, meta: NonNullable<DecisionInput["meta"]>,
  derived: ReturnType<typeof replayReferences>, dexRow: DecisionInput["dexRow"],
  prior: { at: number; current: number | null; reference: DEWSInput["carriedReferenceDivergence"] } | undefined) {
  const evidence = frame.evidence[asset.id];
  const capturedSelection = frame.dewsReferences.get(peg);
  const selection = capturedSelection ?? replayReferenceSelection(derived, peg, frame.at);
  const referenceTrusted = selection && isAuthoritativeDepegPegReference({
    pegCurrency: meta.flags.pegCurrency, pegType: peg, pegRateSource: selection.kind,
    pegRateContributorCount: selection.kind === "median" ? selection.contributors.length : undefined,
  });
  const ouncesAt = (quoteObservedAtSec: number | null) => getCommodityOuncesAtQuote(meta.commodityOunces, {
    assetId: asset.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec,
  });
  const primaryClock = getDewsPrimaryQuoteClock(asset as StablecoinData, frame.at);
  const dexQuote = dexRow && isAffirmativeDexPriceRow(dexRow, frame.at, "depeg") ? {
    dexPriceUsd: dexRow.dex_price_usd, updatedAt: dexRow.aggregateObservedAt!, sourceTotalTvl: dexRow.source_total_tvl,
    aggregateFamilies: readDewsDexAggregateFamilies(evidence?.dexAggregate?.aggregateContributors, dexRow.source_pool_count),
  } : null;
  const standalone = evidence?.dexAggregate == null ? freshUsdQuote(evidence?.dex, frame.at) : undefined;
  const dexClock = dexQuote?.updatedAt ?? standalone?.observedAtSec ?? null;
  const primaryOunces = ouncesAt(primaryClock);
  const dexOunces = ouncesAt(dexClock);
  const price = isObservedPrice(asset) ? asset.price ?? null : null;
  const dexPriceUsd = dexQuote?.dexPriceUsd ?? standalone?.priceUsd ?? null;
  const ounces = primaryOunces ?? dexOunces;
  const pegRef = referenceTrusted && selection && ounces != null
    ? getPegReference(peg, { [peg]: selection.usdPerUnit }, ounces) : null;
  const leg = (value: number | null, quoteObservedAtSec: number | null, ounces: number | null) => {
    const raw = value != null && pegRef != null && ounces != null ? deriveDepegSignal(value, pegRef)?.rawBps : null;
    return evaluateReferenceAdmission({
      ...(selection && pegRef != null && ounces != null ? selection : { kind: "none" }),
      decisionAtSec: frame.at, generation: capturedSelection?.generation ?? derived.generation, quoteObservedAtSec,
      rawDeviationBps: raw == null ? null : asRawDeviationBps(raw),
    });
  };
  const referenceAdmission = { primary: leg(price, primaryClock, primaryOunces), dex: leg(dexPriceUsd, dexClock, dexOunces) };
  const session = getReferenceSessionState(marketOf(peg)!, frame.at);
  const carriedReferenceDivergence = !session.open && prior?.reference &&
    prior.reference.observedAtSec >= session.closureStartSec - REFERENCE_INTRADAY_BUDGET_SEC ? prior.reference : undefined;
  const venueSpreadBps = primaryClock != null && primaryOunces != null && dexOunces != null
    && price != null && dexQuote && hasIndependentDewsVenues(asset as StablecoinData, dexQuote)
    ? deriveDepegSignal(price, dexQuote.dexPriceUsd)?.absBps ?? null : null;
  const smoothing = prior != null && frame.at - prior.at <= TWO_HOURS ? prior.current : null;
  return computeDivergSignal({
    price, pegType: peg, pegRef: pegRef ?? 0, dexPriceUsd, referenceAdmission, carriedReferenceDivergence, venueSpreadBps,
    pegReferenceUnavailableReason: session.open ? (price != null ? referenceAdmission.primary.reason : referenceAdmission.dex.reason)
      : "reference-market-closed",
    prevDivergValue: smoothing ?? undefined, prevDivergAvailable: smoothing != null,
  } as DEWSInput);
}

type Sample = {
  at: number; source: string; id: string; admission: ReturnType<typeof evaluateReferenceAdmission>;
  selectedReference: { kind: string; usdPerUnit: number } | null;
  quoteObservedAtSec: number | null; quoteTiming: "measured" | "unmeasurable";
  detectorOutcome: string | null; pending: boolean; candidateObservedAt: number | null; opened: OpenRow | null;
  lifecycleCommands: string[];
  peerBps: number | null; pair: { bps: number; observedAtSec: number } | null;
  peerObservation: { subjectAt: number; contributors: { id: string; observedAtSec: number }[] } | null;
  pairCoverage: Evidence["tradedPairCoverage"] | null;
  observationUsable: boolean; confirmationComplete: boolean; coverageGaps: string[];
  psiCarry: { priorAdmittedAt: number | null; replayBps: number | null; incumbentBps: number | null; deltaBps: number | null } | null;
  dewsDivergence: { baseline: number | null; replay: number | null; delta: number | null;
    signal: ReturnType<typeof dewsDivergence> };
};

const DETECTOR_INTERVAL = CRON_INTERVALS["sync-stablecoins"];
const quoteClock = (asset: Asset) => asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;

function hasQuoteClock(asset: Asset, at: number): boolean {
  const clock = quoteClock(asset);
  return clock !== null && Number.isSafeInteger(clock) && clock > 0 && clock <= at;
}

function frameCoverage(times: number[], from: number, to: number): boolean {
  return to - from >= DEPEG_PENDING_MIN_AGE_SEC && times.length >= 2
    && times[0] - from <= DETECTOR_INTERVAL && to - times.at(-1)! <= DETECTOR_INTERVAL
    && times.at(-1)! - times[0] >= DEPEG_PENDING_MIN_AGE_SEC
    && times.every((at, index) => index === 0 || at - times[index - 1] <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC);
}

function matchedRisk(frame: Frame, evidence: z.output<typeof matchedRiskSchema> | undefined): boolean {
  return frame.generationAt !== null && evidence?.decisionAtSec === frame.at && evidence.generationAtSec === frame.generationAt;
}

function matchNative(asset: Asset, peg: string, at: number, quote: Evidence["nativePegQuote"]) {
  // The production matcher reads only the pending row's identity and peg type.
  const identity = { stablecoin_id: asset.id, peg_type: peg } as PendingDepegRow;
  if (!quote || quote.updatedAt > at || !isNativeQuoteForPending(identity, quote)
    || (quote.vsCurrency != null && pegTypeFromCurrency(quote.vsCurrency) !== peg)) return undefined;
  return quote;
}

function readOpenRows(db: SimulatorDb) {
  return db.prepare(`SELECT e.*, COALESCE(p.quote_mode, CASE WHEN e.source = 'live' AND e.pending_reason IS NOT NULL
    THEN CASE WHEN instr('+' || e.pending_reason || '+', '+native-origin+') > 0 THEN 'native-peg' ELSE 'usd' END
    END) AS quote_mode FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id WHERE e.ended_at IS NULL`).all<OpenRow>();
}

function assessedReference(input: DecisionInput, meta: DecisionInput["meta"],
  signal: ReturnType<typeof deriveAuthoritativePegSignal> | null) {
  return meta ? assessDetectionReference({ ...input, meta, signal: signal?.kind === "signal" ? signal.signal : null }) : null;
}

function psiObservation(input: DecisionInput, derived: ReturnType<typeof replayReferences>, peg: string, market: ReferenceMarket,
  event: OpenRow, reference: ReturnType<typeof assessedReference>) {
  const { asset, now, nativePegQuote, challengerPools, meta } = input;
  if (now < event.started_at) return null;
  if (parsePendingReason(event.pending_reason).has("peer-relative")) {
    const onset = readAdmittedPeerOnset(event);
    if (!onset) return null;
    const current = reference && assessIndependentPeerMove({
      reference, asset, native: null, pools: challengerPools, now,
      threshold: getDepegThresholdBps(peg), recoveryThreshold: getDepegRecoveryThresholdBps(peg),
    });
    const at = sourceObservationClock(asset);
    return current && at != null && at >= event.started_at && at > onset.quoteObservedAt
      ? { at, bps: current.signal.rawBps } : { at: onset.quoteObservedAt, bps: onset.rawBps };
  }
  if (isNativePegEvent(event)) {
    const traded = getClockedTradedNativeQuote(nativePegQuote, now);
    const quote = getNativeEventPriceObservation(event, now, traded
      ? { value: traded.price, observedAt: traded.updatedAt, source: "coingecko", derivation: traded.derivation } : null);
    const session = getReferenceSessionState(market, now);
    if (quote && (quote.observedAt === traded?.updatedAt || (session.open && quote.observedAt >= session.sessionOpenedAtSec))) {
      const signal = deriveDepegSignal(quote.value, event.peg_reference);
      if (signal && quote.observedAt >= event.started_at) return { at: quote.observedAt, bps: signal.bps };
    }
  }
  const selection = replayReferenceSelection(derived, peg, now);
  const at = asset.priceObservedAt ?? null;
  const pegRef = selection && getPegReference(peg, { [peg]: selection.usdPerUnit }, meta?.commodityOunces, {
    assetId: asset.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec: at,
  });
  const signal = pegRef != null && asset.price != null && isObservedPrice(asset) &&
    !hasIncompatibleParityPrice(asset) && asset.priceSource !== "coingecko-native-implied"
    ? deriveDepegSignal(asset.price, pegRef) : null;
  const raw = signal && Number.isFinite(signal.rawBps) ? asRawDeviationBps(signal.rawBps) : null;
  const admission = evaluateReferenceAdmission({
    ...(selection ?? { kind: "none" }), quoteObservedAtSec: at, decisionAtSec: now, rawDeviationBps: raw,
  });
  const bps = admittedDeviationBps(raw, admission);
  return bps != null && at != null && at >= event.started_at ? { at, bps } : null;
}

async function replayClosure(closure: Closure, events: DepegEventEntry[],
  frames: Frame[], observations: readonly FxReferenceObservation[]) {
  const { market, from, to } = closure;
  const end = to + REFERENCE_MARKET_REOPEN_GRACE_SEC;
  const ledger = events.filter((event) => marketOf(event.pegType) === market && event.startedAt < end
    && (event.endedAt === null || event.endedAt >= from)
    && (event.startedAt >= from || (event.endedAt !== null && event.endedAt < end)));
  const scoped = frames.filter((frame) => frame.at >= from - REFERENCE_INTRADAY_BUDGET_SEC && frame.at < end + TWO_HOURS);
  const seed = scoped.find((frame) => frame.pendingSeed?.at === from)?.pendingSeed;
  const openSeed = scoped.find((frame) => frame.openSeed?.at === from)?.openSeed;
  const simulator = openSeed || seed || scoped.some((frame) => frame.assets.length && frame.at >= from && frame.at < end)
    ? createLatestSchemaSqlite() : null;
  const db = simulator?.db as unknown as SimulatorDb | undefined;
  const lastAdmitted = new Map<number, { at: number; bps: number; startedAt: number }>();
  const priorDews = new Map<string, { at: number; current: number | null; reference: DEWSInput["carriedReferenceDivergence"] }>();
  const samples: Sample[] = [];
  const seen = new Set<string>();
  const completeFrames = new Set<number>();
  let boundaryOpenCount: number | null = null;
  let initialStateKnown = false;
  try {
    if (db) {
      initialStateKnown = await seedClosure(db, from, market, openSeed, seed);
      if (openSeed) boundaryOpenCount = (await db.prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE ended_at IS NULL")
        .first<{ count: number }>())?.count ?? null;
    }
    for (const frame of scoped) {
      if (!frame.assets.length) continue;
      const loadedDex = db && frame.at < end ? await loadCapturedDex(db, frame) : null;
      const pendingIds = db && frame.censusComplete ? (await db.prepare(
        "SELECT stablecoin_id FROM depeg_pending",
      ).all<{ stablecoin_id: string }>()).results : [];
      const openRows = db ? (await readOpenRows(db)).results : [];
      const open = new Map(openRows.map((row) => [row.stablecoin_id, row]));
      const priced = frame.assets.map((asset) => {
        const pegType = pegOf(asset);
        return hasQuoteClock(asset, frame.at) ? { ...asset, pegType } : { ...asset, pegType, price: null, priceObservedAt: null };
      });
      const derived = replayReferences(frame, priced, new Set(open.keys()), observations);
      const assetsInFrame = new Set(frame.assets.map((asset) => asset.id));
      let complete = frame.censusComplete && [...open.keys(), ...pendingIds.map(({ stablecoin_id }) => stablecoin_id)]
        .every((id) => assetsInFrame.has(id));
      let eligible = 0;
      for (const [index, captured] of frame.assets.entries()) {
        const peg = pegOf(captured);
        const meta = PSI_ELIGIBLE_META_BY_ID.get(captured.id);
        if (!peg || marketOf(peg) !== market || !meta || meta.flags.navToken) continue;
        const key = `${captured.id}/${frame.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        eligible++;
        const asset = priced[index];
        const evidence = frame.evidence[asset.id];
        const native = matchNative(asset, peg, frame.at, evidence?.nativePegQuote);
        const nativePegQuote = native && frame.at - native.updatedAt <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC ? native : undefined;
        const print = getClockedTradedNativeQuote(native, native?.updatedAt ?? frame.at);
        const printedBps = print?.vsCurrency != null ? deriveDepegSignal(print.price, 1)?.rawBps ?? null : null;
        const pair = print && printedBps !== null ? { bps: printedBps, observedAtSec: print.updatedAt } : null;
        const dexRow = loadedDex?.dexPriceRows.get(asset.id);
        const dewsBaseline = matchedRisk(frame, evidence?.incumbentDews) ? evidence?.incumbentDews : undefined;
        const dewsSignal = dewsDivergence(frame, asset, peg, meta, derived, dexRow, priorDews.get(asset.id));
        const baseline = dewsBaseline?.divergence ?? null;
        const replayDews = dewsSignal.available ? dewsSignal.value : null;
        priorDews.set(asset.id, {
          at: frame.at,
          current: (frame.at < from ? dewsBaseline?.currentDivergenceValue : undefined) ?? dewsSignal.currentDivergenceValue ?? null,
          reference: frame.at < from && dewsBaseline?.referenceDivergence &&
            dewsBaseline.referenceDivergence.observedAtSec <= frame.at ? dewsBaseline.referenceDivergence : dewsSignal.referenceDivergence,
        });

        const active = open.get(asset.id);
        const challengerPools = evidence?.challengerPools?.filter((pool) => pool.observedAt <= frame.at &&
          frame.at - pool.observedAt <= DEX_FRESHNESS_SEC && pool.tvlUsd >= POOL_CHALLENGE_MIN_TVL);
        const input = {
          now: frame.at, asset, meta, existing: active, pegRates: derived.rates,
          pegRateSources: derived.sources, pegRateCounts: derived.counts, nativePegQuote,
          referenceContext: derived.referenceContext, dexRow,
          protocolSources: loadedDex?.dexPriceSources.get(asset.id), challengerPools,
        };
        const observedMeta = observationPegMeta(asset, meta);
        const signal = observedMeta && !hasIncompatibleParityPrice(asset) ? deriveAuthoritativePegSignal({
          price: asset.price, pegType: peg, pegCurrency: observedMeta.flags.pegCurrency, commodityOunces: observedMeta.commodityOunces,
          pegRates: derived.rates, pegRateSources: derived.sources, pegRateCounts: derived.counts,
        }) : null;
        const reference = assessedReference(input, observedMeta, signal);
        const peer = reference?.peer;
        const peerBps = peer && asset.price != null ? deriveDepegSignal(asset.price, peer.reference)?.rawBps ?? null : null;

        let psiHeld = false;
        let psiPrior: { at: number; bps: number; startedAt: number } | undefined;
        if (active) {
          const previous = lastAdmitted.get(active.id);
          const current = psiObservation(input, derived, peg, market, active, reference);
          if (previous?.startedAt === active.started_at && previous.at <= frame.at) psiPrior = previous;
          if (current && (!psiPrior || current.at > psiPrior.at)) {
            lastAdmitted.set(active.id, { ...current, startedAt: active.started_at });
          } else {
            psiHeld = true;
          }
        }
        if (frame.at < from) continue;

        const result = db && frame.at < end ? await runDetector(input, db, evidence) : null;
        const observation = result?.decision.observation;
        const detectorOutcome = observation?.kind === "unavailable" ? observation.reason : observation?.kind ?? null;
        const observationUsable = observation?.kind === "below-floor" || observation?.kind === "observed"
          || detectorOutcome === "reference-market-closed";
        const confirmationComplete = observationUsable && result?.gaps.length === 0;
        complete &&= confirmationComplete;
        const carry = psiPrior?.bps ?? null;
        const psiBaseline = matchedRisk(frame, evidence?.incumbentPsi) ? evidence!.incumbentPsi!.contributionBps : null;
        const pairCoverage = evidence?.tradedPairCoverage;
        samples.push({
          at: frame.at, source: frame.source, id: asset.id,
          admission: reference?.verdict ?? evaluateReferenceAdmission({ kind: "none", decisionAtSec: frame.at,
            quoteObservedAtSec: sourceObservationClock(asset), rawDeviationBps: null, generation: derived.generation }),
          selectedReference: derived.rates[peg] == null ? null : { kind: derived.sources[peg], usdPerUnit: derived.rates[peg] },
          quoteObservedAtSec: quoteClock(captured), quoteTiming: hasQuoteClock(captured, frame.at) ? "measured" : "unmeasurable",
          detectorOutcome, pending: result?.attempted != null, candidateObservedAt: result?.attempted ?? null,
          opened: result?.opened ?? null, lifecycleCommands: result?.decision.commands.map(({ type }) => type) ?? [],
          peerBps, pair,
          peerObservation: peer && asset.priceObservedAt != null ? { subjectAt: asset.priceObservedAt,
            contributors: peer.contributors.map(({ id, observedAtSec }) => ({ id, observedAtSec })) } : null,
          pairCoverage: pairCoverage && pairCoverage.fromSec <= pairCoverage.toSec && pairCoverage.toSec <= frame.at ? pairCoverage : null,
          observationUsable, confirmationComplete, coverageGaps: result?.gaps ?? [],
          psiCarry: psiHeld ? {
            priorAdmittedAt: psiPrior?.at ?? null, replayBps: carry, incumbentBps: psiBaseline,
            deltaBps: carry != null && psiBaseline != null ? carry - psiBaseline : null,
          } : null,
          dewsDivergence: { baseline, replay: replayDews, delta: baseline != null && replayDews != null ? replayDews - baseline : null,
            signal: dewsSignal },
        });
      }
      if (complete && eligible && frame.at >= from && frame.at < to) completeFrames.add(frame.at);
    }
  } finally {
    simulator?.sqlite.close();
  }

  const measured = samples.filter((sample) => sample.at < end);
  const byCoin: Record<string, { samples: number; usable: number; pending: number; wouldOpen: number; held: number; staleReference: number; unavailable: number }> = {};
  for (const sample of measured) {
    const count = byCoin[sample.id] ??= { samples: 0, usable: 0, pending: 0, wouldOpen: 0, held: 0, staleReference: 0, unavailable: 0 };
    count.samples++;
    if (sample.observationUsable) count.usable++;
    if (sample.pending) count.pending++;
    if (sample.opened && sample.at < to) count.wouldOpen++;
    if (sample.admission.status === "held-closed-session" || sample.detectorOutcome === "reference-market-closed") count.held++;
    if (sample.admission.status === "stale-reference") count.staleReference++;
    if (sample.admission.status === "unavailable") count.unavailable++;
  }
  const promotions = measured.flatMap((sample) => sample.opened ? [{ sample, event: sample.opened }] : []);
  const inWindow = promotions.filter(({ sample }) => sample.at < to);
  const onsetCohort = promotions.filter(({ event }) => event.started_at >= from && event.started_at < to);
  const frameTimes = [...new Set(scoped.filter(({ at, assets }) => assets.length && at >= from && at < to).map(({ at }) => at))];
  const complete = initialStateKnown && frameTimes.every((at) => completeFrames.has(at))
    && frameCoverage([...completeFrames], from, to);
  const volume = complete ? inWindow.length : null;
  const falseOpen = inWindow.map(({ sample, event }) => classifyFalseOpen(sample, event, samples, ledger));
  const caughtReal = ledger.flatMap((event) => {
    const label = REVIEWED.get(event.id);
    if (!label || event.startedAt < from || event.startedAt >= to) return [];
    const until = Math.min(to, event.endedAt ?? to);
    const hits = onsetCohort.filter(({ event: opened }) => opened.stablecoin_id === event.stablecoinId
      && opened.direction === event.direction && opened.started_at >= event.startedAt && opened.started_at < until);
    const hit = hits.find(({ sample }) => sample.at < until);
    const coinHistory = measured.filter((row) => row.id === event.stablecoinId && row.at < until);
    const coinSamples = coinHistory.filter((row) => row.at >= event.startedAt);
    const complete = initialStateKnown && coinHistory.every((row) => row.confirmationComplete) &&
      frameCoverage(coinHistory.map((row) => row.at), from, until) &&
      frameCoverage(coinSamples.map((row) => row.at), event.startedAt, until);
    const throughPromotion = hit ? coinHistory.filter((row) => row.at <= hit.sample.at) : [];
    const caught = initialStateKnown && hit !== undefined &&
      throughPromotion.some((row) => row.candidateObservedAt === hit.event.started_at) &&
      throughPromotion.every((row) => row.confirmationComplete) &&
      frameCoverage(throughPromotion.map((row) => row.at), from, hit.sample.at);
    return [{
      eventId: event.id, label, verdict: caught ? "caught" : complete ? "not-reproduced" : "unmeasurable",
      sampled: coinSamples.length, confirmationCoverageComplete: caught || complete, detectedAt: caught ? hit.sample.at : null,
      observedPromotionAt: hit?.sample.at ?? null,
      postReopenPromotionAt: hits.find(({ sample }) => sample.at >= to)?.sample.at ?? null,
    }];
  });
  return {
    ...closure, labels: [...closure.labels], volume,
    observedPromotions: inWindow.length,
    onsetCohort: { promotedDuringClosure: onsetCohort.filter(({ sample }) => sample.at < to).length,
      promotedAfterReopen: onsetCohort.filter(({ sample }) => sample.at >= to).length },
    coverage: { complete, frames: frameTimes.length, completeFrames: completeFrames.size,
      openSeedAvailable: openSeed !== undefined, pendingSeedAvailable: seed !== undefined, initialStateKnown, boundaryOpenCount },
    falseOpen: { count: complete && falseOpen.every((row) => row.verdict !== "unmeasurable")
      ? falseOpen.filter((row) => row.verdict === "false-open").length : null,
      observedCount: falseOpen.filter((row) => row.verdict === "false-open").length,
      unknown: falseOpen.filter((row) => row.verdict === "unmeasurable").length, opens: falseOpen },
    caughtReal, byCoin,
    ledger: ledger.map((event) => replayArchivedOnset(event, observations)),
    samples: measured,
  };
}

function classifyFalseOpen(sample: Sample, open: OpenRow, samples: Sample[], ledger: DepegEventEntry[]) {
  const start = open.started_at;
  const end = start + TWO_HOURS;
  const sign = open.direction === "above" ? 1 : -1;
  const followup = samples.filter((row) => row.id === sample.id && row.at >= start);
  const onset = followup.find((row) => row.at === start);
  const threshold = getDepegThresholdBps(open.peg_type);
  const recovery = getDepegRecoveryThresholdBps(open.peg_type);
  const print = followup.some(({ pair }) => pair != null && pair.observedAtSec >= start &&
    pair.observedAtSec <= end && pair.bps * sign >= threshold);
  const real = ledger.some((row) => REVIEWED.has(row.id) && row.stablecoinId === sample.id
    && row.direction === open.direction && row.startedAt <= start && (row.endedAt === null || start < row.endedAt));
  const noDivergence = onset?.peerBps != null && onset.peerBps * sign < threshold;
  const windowPeers = followup.filter(({ peerObservation: peer }) => peer && peer.subjectAt > start && peer.subjectAt <= end &&
    peer.contributors.every(({ observedAtSec }) => observedAtSec >= start && observedAtSec <= end &&
      Math.abs(observedAtSec - peer.subjectAt) <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC));
  const reversed = windowPeers.some((row) => row.peerBps != null && row.peerBps * sign <= recovery);
  const ranges = followup.flatMap(({ pairCoverage }) => pairCoverage ? [pairCoverage] : []).sort((a, b) => a.fromSec - b.fromSec);
  let coveredThrough = start;
  for (const { fromSec, toSec } of ranges) {
    if (fromSec > coveredThrough) break;
    coveredThrough = Math.max(coveredThrough, toSec);
  }
  const checkedThrough = coveredThrough >= end;
  const peerTimes = [...new Set(windowPeers.map((row) => row.peerObservation!.subjectAt))].sort((a, b) => a - b);
  const verdict = real ? "real" : noDivergence || (reversed && !print && checkedThrough) ? "false-open"
    : onset?.peerBps != null && (print || (checkedThrough && frameCoverage(peerTimes, start, end)))
      ? "not-false-open" : "unmeasurable";
  return { stablecoinId: sample.id, startedAt: start, promotedAt: sample.at, verdict, noDivergence, reversed, print, checkedThrough };
}

function replayFx(frames: Frame[]) {
  const selected = ["d3-stablecoins-0822.json", "d3-gho-pre0949-list.json", "d3-gho-post1034-list.json"]
    .map((file) => frames.find((frame) => frame.source.endsWith(`/${file}`)));
  function run(prior: ReturnType<typeof hydrateFxRateState>, at: number) {
    return new FxSyncRunState({ prevState: prior, syncStartSec: at, expectedPegKeys: [BRL], initialSources: {},
      validateRate: (_peg, rate) => Number.isFinite(rate) && rate > 0 });
  }
  const persist = (state: FxSyncRunState) => {
    state.enforcePublicationOrder();
    return hydrateReplayFx(state.usableRates, state.syncStartSec, state.buildPersistedMeta());
  };
  const read = (state: ReturnType<typeof persist>) => ({
    value: state?.rates[BRL] ?? null, observedAtSec: state?.sourceUpdatedAtByPeg[BRL] ?? null,
    cadence: state?.sourceCadenceByPeg[BRL] ?? null, observation: state?.observations?.[BRL] ?? null,
    sessionEvidence: state?.referenceSessionEvidenceByPeg?.[BRL] ?? null,
  });
  const date = "2026-11-12";
  const mapping = { BRL };
  const [first, middle, last] = selected;
  const daily = first?.rates[BRL];
  const intraday = middle?.rates[BRL];
  let sequence = null;
  if (first && middle && last && daily && intraday) {
    const states = [run(null, first.generationAt ?? first.at)];
    states[0].applyFrankfurterRates({ BRL: 1 / daily }, date, mapping);
    const overlayAt = middle.generationAt ?? middle.at;
    const overlay = run(persist(states[0]), overlayAt);
    overlay.applyFrankfurterRates({ BRL: 1 / daily }, date, mapping);
    overlay.applyRealtimeOverlayRates({ rates: new Map([[BRL, intraday]]), observedAt: overlayAt - 60 });
    const intervening = run(persist(overlay), last.generationAt ?? last.at);
    intervening.applyFrankfurterRates({ BRL: 1 / daily }, date, mapping);
    states.push(overlay, intervening);
    const replay = states.map((state) => read(persist(state)));
    const [, selectedOverlay, selectedIntervening] = replay;
    sequence = {
      evidence: "Published rates are recorded. Daily/OXR source assignment and intraday observation clock are fixture assumptions.",
      captured: [first, middle, last].map((frame) => ({
        at: frame.at, generationAt: frame.generationAt, rate: frame.rates[BRL], source: frame.source,
        brzQuoteObservedAtSec: quoteClock(frame.assets.find((asset) => asset.id === "brz-transfero") ?? { id: "", symbol: "" }),
      })),
      replay, retainedIntraday: selectedOverlay.cadence === "intraday"
        && selectedOverlay.observedAtSec === selectedIntervening.observedAtSec
        && selectedOverlay.value === selectedIntervening.value && selectedIntervening.cadence === "intraday",
    };
  }
  const fixing = run(null, sec("2026-11-13T17:00:00Z"));
  fixing.applyFrankfurterRates({ BRL: 5.6 }, "2026-11-13", mapping);
  const expected = sec("2026-11-13T13:10:00Z");
  const session = getReferenceSessionState("fx", sec("2026-11-15T20:00:00Z"));
  if (session.open) throw new Error("Post-reopen fixture no longer starts inside the closure");
  const firstInSession = session.nextOpenSec + 60;
  const lastBeforeClose = session.closureStartSec - 60;
  const unchanged = 0.178;
  let before = run(null, lastBeforeClose);
  before.applyFrankfurterRates({ BRL: 1 / unchanged }, "2026-11-13", mapping);
  const replay = [lastBeforeClose, firstInSession, firstInSession + HOUR_SECONDS].map((at) => {
    const next = run(persist(before), at);
    next.applyFrankfurterRates({ BRL: 1 / unchanged }, "2026-11-13", mapping);
    next.applyRealtimeOverlayRates({ rates: new Map([[BRL, unchanged]]), observedAt: at });
    before = next;
    return read(persist(next));
  });
  const afterReopen = replay.slice(1).map((selected, index) => {
    const at = firstInSession + index * HOUR_SECONDS;
    return evaluateReferenceAdmission({
      ...(selected.observation ? { kind: "fx" as const, observation: selected.observation, ...selected.sessionEvidence } : { kind: "none" }),
      quoteObservedAtSec: at, decisionAtSec: at, rawDeviationBps: asRawDeviationBps(0),
      generation: "fixture:unchanged-post-reopen", purpose: "current",
    });
  });
  const expectedClockInputs = [firstInSession, firstInSession + HOUR_SECONDS].map((at) => evaluateReferenceAdmission({
    kind: "fx",
    observation: { pegKey: BRL, source: "openExchangeRates", cadence: "intraday", usdPerUnit: unchanged, observedAtSec: at },
    quoteObservedAtSec: at, decisionAtSec: at, rawDeviationBps: asRawDeviationBps(0), preCloseUsdPerUnit: unchanged,
    firstInSessionObservedAtSec: firstInSession, generation: "fixture:unchanged-post-reopen-clocked", purpose: "current",
  }));
  const observed = read(persist(fixing));
  return {
    sequence,
    ecbConcertation: { expected, observed: observed.observedAtSec, publishedAtSec: observed.observation?.publishedAtSec ?? null,
      matches: observed.observedAtSec === expected },
    unchangedPostReopen: {
      producerSamples: replay, admissions: afterReopen, expectedClockInputs,
      matches: afterReopen[0].status === "stale-reference"
        && afterReopen[0].reason === "reference-not-repriced" && afterReopen[1].status === "admitted",
    },
  };
}

async function main() {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    out: { type: "string" }, captures: { type: "string" }, "reference-cache": { type: "string" },
    d1: { type: "boolean" }, "fx-producer": { type: "boolean" },
  } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const out = requireCliString(values.out, "--out");
  const { frames, untimed } = loadFrames(typeof values.captures === "string" ? resolve(values.captures) : resolve(ROOT, "agents/captures"));
  const fx = replayFx(frames);
  const archive = values["fx-producer"] ? null : loadArchive();
  const observations = typeof values["reference-cache"] === "string"
    ? z.array(FxReferenceObservationSchema).parse(readJson(resolve(values["reference-cache"])))
      .map((row) => ({ ...row, pegKey: normalizePegType(row.pegKey) ?? row.pegKey }))
      .sort((a, b) => a.observedAtSec - b.observedAtSec || (a.publishedAtSec ?? a.observedAtSec) - (b.publishedAtSec ?? b.observedAtSec))
    : [];
  const d1 = archive && values.d1 ? loadD1Events() : null;
  const events = new Map<number, DepegEventEntry>();
  const removedIds = new Set(archive?.deleted.map((row) => row.id));
  for (const row of [...archive?.events ?? [], ...d1 ?? []]) {
    if (removedIds.has(row.id)) continue;
    if (marketOf(row.pegType) && !events.has(row.id)) events.set(row.id, row);
  }
  const canonical = [...events.values()];
  const eventList = [...canonical, ...archive?.deleted ?? []];
  const closures = [];
  if (archive) {
    for (const closure of discoverClosures(eventList, frames, observations)) {
      closures.push(await replayClosure(closure, eventList, frames, observations));
    }
  }
  const shown = closures.filter((row) => row.labels.length > 0 || row.samples.length > 0);
  const report = {
    schemaVersion: 4, acceptance: "owner-review-required", captureCount: frames.length,
    detectorAdapter: "integrated-worker-detector-and-confirmer",
    captures: frames.map(({ source, at, generationAt }) => ({ source, at, generationAt })), untimedCaptures: untimed,
    referenceObservationCount: observations.length,
    referenceCache: values["reference-cache"] ?? null, archiveIdentity: archive?.identity ?? null,
    archiveRows: archive?.events.length ?? null, deletedRows: archive?.deleted.map((row) => row.id) ?? [],
    deletedFrom: `${REMOVED_BY}^`, remoteD1Rows: d1?.length ?? null, fxProducer: fx, closures,
  };
  const markdown = [
    "# Reference closure replay", "",
    `Reviewed ${closures.length} closure windows, ${frames.length} capture files and ${observations.length} clocked reference observations.`,
    `Measured volume in ${closures.filter((row) => row.volume !== null).length} of ${closures.length} windows.`,
    "Volume counts promotions during the closure when capture coverage is complete. The JSON also reports observed promotions and the reopening cohort. Missing coverage is unmeasurable.",
    "PSI carry and DEWS divergence deltas require matched incumbent evidence.", "",
    ...renderMarkdownRows({
      headings: ["Window", "Market", "UTC", "Archived rows", "Observed opens", "Volume", "False opens", "Caught real"],
      rows: shown, pipeStyle: "wrapped", empty: "No closure replay requested.",
      cells: (row) => [
        row.labels.join(", ") || "Recorded closure", row.market, `${iso(row.from)} → ${iso(row.to)}`, row.ledger.length,
        row.observedPromotions, row.volume ?? "unmeasurable",
        row.falseOpen.count ?? `unmeasurable (${row.falseOpen.observedCount} observed)`,
        row.caughtReal.map((event) => `#${event.eventId} ${event.verdict}`).join(", "),
      ],
    }), "", "## FX producer", "",
    `- BRL carry between polls: ${fx.sequence == null ? "unmeasurable" : fx.sequence.retainedIntraday ? "retained" : "regressed"}.`,
    `- ECB observation stamp: ${fx.ecbConcertation.matches ? "matches" : "differs from"} the concertation fixture.`,
    `- Unchanged post-reopen reference: ${fx.unchangedPostReopen.admissions.map(({ status, reason }) => `${status} (${reason})`).join(" → ")}.`,
    `- Shared admission with the fixture’s provider clocks: ${fx.unchangedPostReopen.expectedClockInputs.map(({ status, reason }) => `${status} (${reason})`).join(" → ")}.`, "",
  ].join("\n");
  writeFileResolved(join(out, "receipt.json"), JSON.stringify(report) + "\n");
  writeFileResolved(join(out, "summary.md"), markdown);
  console.log(`Replay receipt written to ${resolve(out)}`);
}

runDirectCli(import.meta.url, main, { label: "replay-reference-closures", usage: USAGE });
