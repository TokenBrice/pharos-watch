import { z } from "zod";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalizeChainCirculating, normalizeChainSupplyValue } from "@shared/lib/chains/circulating";
import { CHAIN_META } from "@shared/types/chain-identity";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getCirculatingRawOrNull, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC, SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC } from "@shared/lib/supply";
import { selectCuratedAggregateOnchainSupplyProbeContracts } from "@shared/lib/onchain-supply-probe";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { SupplyChainGuardProvenance } from "@shared/types/market";
import { buildChainRpcs, registryRpcEndpoints, type ChainRpcConfig } from "../../lib/chain-registry";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import { fetchErc20TotalSupply } from "../reserve-adapters/onchain";
import { fetchSolanaTokenSupply } from "../reserve-adapters/token-supply";
import { getPegReferencePriceUsd } from "./supply-gap-reconciliation";
import { supplyObservationClock } from "./shared";
import type { PeggedAsset } from "./enrich-prices-shared";
import { CHAIN_DROPOUT_SEED, CHAIN_DROPOUT_SEED_OBSERVED_AT, CHAIN_DROPOUT_SEED_VALID_UNTIL } from "./chain-dropout-seed";
import { fetchCuratedAggregateOnChainMcap, toPublicChainCirculating } from "./supplemental-assets/onchain-supply";

const CHAIN_DROPOUT_STATE_KEY = "sync-stablecoins:chain-dropout-state";
export const CHAIN_DROPOUT_POLICY = {
  minBaselineUsd: 1_000_000,
  collapseRatio: 0.5,
  quarantineDeficitRatio: 0.02,
  // Past the carry ceiling, a deficit at most this share of the vetted whole-asset total publishes
  // the observed remainder as explicit partial coverage; a larger share keeps supply unavailable.
  partialCoverageMaxDeficitRatio: 0.05,
  chartMaxAgeSec: 48 * 3600,
  chartRefetchSec: 3600,
  maxHistoryFetches: 8,
  solanaReadTimeoutMs: 20_000,
} as const;

// Reviewed issuer-native deployments, not bridge representations. Contracts/decimals are catalog-owned.
export const CHAIN_DROPOUT_ONCHAIN_ROSTER = [
  { assetId: "usdg-paxos", chainId: "xlayer" },
  { assetId: "usdg-paxos", chainId: "ink" },
  // Issuer confirms native Solana XUSD and the catalog mint: https://www.straitsx.com/blog-post/xsgd-and-xusd-live-on-solana
  { assetId: "xusd-straitsx", chainId: "solana" },
] as const;
const REVIEWED_CHAIN_SUPPLY_COLLAPSES: readonly {
  assetId: string; chainId: string; reviewedAt: number; evidenceUrl: string;
}[] = [
  // 2026-10-16 06:18 UTC: Arbitrum block 515293481 confirms 1,155,833.488355934
  // satUSD, matching the lower list/history stock after the October 11 reduction.
  {
    assetId: "satusd-river", chainId: "arbitrum",
    reviewedAt: Date.parse("2026-10-16T06:18:46Z") / 1000,
    evidenceUrl: "https://arbiscan.io/token/0xb4818bb69478730ef4e33cc068dd94278e2766cb",
  },
  // Polygon block 95617466: 533,719.13 EURS total minus 100,000 issuer inventory
  // equals the list's 433,719.13 EUR. Ethereum gains the corresponding bridge unwind;
  // accepting the observed lower chain stock avoids adding it back a second time.
  {
    assetId: "eurs-stasis", chainId: "polygon",
    reviewedAt: Date.parse("2026-10-16T06:18:46Z") / 1000,
    evidenceUrl: "https://polygonscan.com/token/0xe111178a87a3bff0c8d18decba5798827539ae99",
  },
  // 2026-10-29 10:50 UTC: finalized Polygon block 96377093 confirms
  // 365,027.867025281274675608 SBC, matching the list's lower 365,027 stock.
  {
    assetId: "sbc-brale", chainId: "polygon",
    reviewedAt: Date.parse("2026-10-29T10:50:19Z") / 1000,
    evidenceUrl: "https://polygonscan.com/token/0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798",
  },
];

const TimestampSchema = z.number().int().nonnegative();
const PairStateSchema = z.object({
  assetId: z.string(),
  chainLabel: z.string(),
  chainId: z.string().optional(),
  baselineUsd: z.number().finite().nonnegative(),
  baselineObservedAt: TimestampSchema,
  baselineSource: z.enum(["state", "seed", "list-prev-day"]),
  quarantinedSince: TimestampSchema.nullable(),
  chartPoint: z.object({ valueUsd: z.number().finite().nonnegative(), pointDate: TimestampSchema, fetchedAt: TimestampSchema }).optional(),
  // Failed/invalid chart reads also consume the hourly attempt budget, without claiming an observation.
  chartAttemptedAt: TimestampSchema.optional(),
  // Set when a flagged pair is released at a confirmed level (corroboration, reviewed release or
  // immaterial chart release). Such a pair is never pruned, so a confirmed low baseline is never
  // replaced by the stale incident seed or an aged previous-day value.
  releasedAt: TimestampSchema.optional(),
  // Attribution became ambiguous (a concurrent healthy-chain gain could explain the drop). While the
  // pair stays flagged, repairs stay withheld and a material drop holds this pre-ambiguity vetted
  // whole-asset total: once the inflated healthy chain becomes its own baseline, the gain is invisible.
  ambiguousSince: TimestampSchema.optional(),
  // `null`: no complete coherent total was available when attribution became ambiguous (R1), so a
  // material drop publishes unavailable supply rather than a partial sum.
  heldTotalUsd: z.number().finite().nonnegative().nullable().optional(),
}).strict();
export const ChainDropoutStateSchema = z.object({ version: z.literal(1), pairs: z.record(z.string(), PairStateSchema) }).strict();
export type ChainDropoutState = z.infer<typeof ChainDropoutStateSchema>;
type PairState = z.infer<typeof PairStateSchema>;
type ChainEvidence = SupplyChainGuardProvenance["chains"][number];
export interface SupplyChainGuardResult {
  flagged: number;
  repaired: number;
  quarantinedAssetIds: string[];
  unavailableAssetIds: string[];
  historyFetches: number;
  stateReadFailed: boolean;
  state: ChainDropoutState;
}

function pairKey(assetId: string, identity: string): string {
  return JSON.stringify([assetId, identity]);
}
function findSeed(assetId: string, chainId: string | undefined, chainLabel: string, now: number) {
  if (now >= CHAIN_DROPOUT_SEED_VALID_UNTIL) return undefined;
  return CHAIN_DROPOUT_SEED.find((entry) => entry.assetId === assetId && (entry.chainId ? entry.chainId === chainId : entry.chainLabel === chainLabel));
}
function warn(event: string, message: string, metadata: Record<string, unknown>, error?: unknown): void {
  logWorkerEvent({ scope: "lib", job: "sync-stablecoins", level: "warn", event, message, metadata, ...(error ? { error } : {}) });
}

export async function loadChainDropoutState(db: D1Database, signal?: AbortSignal): Promise<{ state: ChainDropoutState; stateReadFailed: boolean }> {
  try {
    const cached = await getCache(db, CHAIN_DROPOUT_STATE_KEY, signal);
    return { state: cached ? ChainDropoutStateSchema.parse(JSON.parse(cached.value)) : { version: 1, pairs: {} }, stateReadFailed: false };
  } catch (error) {
    rethrowIfAborted(error, signal);
    warn("supply-chain-guard-state-read-failed", "Chain dropout state unavailable; bootstrap only and retain persisted state", { reason: "state-read-failed" }, error);
    return { state: { version: 1, pairs: {} }, stateReadFailed: true };
  }
}

/** Call only after this generation's stablecoins cache write succeeds (not a CAS skip). */
export async function persistChainDropoutState(db: D1Database, result: SupplyChainGuardResult, observedAt: number, signal?: AbortSignal): Promise<void> {
  if (result.stateReadFailed) return;
  try {
    await setCacheIfNewer(db, CHAIN_DROPOUT_STATE_KEY, JSON.stringify(ChainDropoutStateSchema.parse(result.state)), observedAt, signal);
  } catch (error) {
    rethrowIfAborted(error, signal);
    warn("supply-chain-guard-state-write-failed", "Published supply but could not persist chain dropout state", { reason: "state-write-failed" }, error);
  }
}

interface Candidate {
  asset: PeggedAsset;
  labels: string[];
  pegKey: string;
  state: PairState;
  evidence: ChainEvidence;
  resolved: boolean;
  /** First-detection clock of the pair's current flag; survives a release that is later withheld. */
  firstFlaggedAt: number;
}

function setChainCurrent(candidate: Candidate, value: number | null): void {
  const rows = candidate.asset.chainCirculating!;
  // Alias rows represent one canonical pair. Allocate the single admitted repair once, never per alias.
  const weights = candidate.labels.map((label) => normalizeChainSupplyValue(rows[label].circulatingPrevDay) ?? 0);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  candidate.labels.forEach((label, index) => {
    rows[label].current = value == null ? null : weightTotal > 0 ? value * weights[index] / weightTotal : index === 0 ? value : 0;
  });
}
function repair(candidate: Candidate, valueUsd: number, observedAt: number, resolution: "onchain-total-supply" | "defillama-chain-history"): void {
  setChainCurrent(candidate, valueUsd);
  candidate.asset.circulating![candidate.pegKey] = (candidate.asset.circulating![candidate.pegKey] ?? 0) + valueUsd - (candidate.evidence.listCurrentUsd ?? 0);
  candidate.evidence.resolution = resolution;
  candidate.evidence.repairedCurrentUsd = valueUsd;
  candidate.evidence.observedAt = observedAt;
  candidate.evidence.observedAtKind = resolution === "onchain-total-supply" ? "local-read" : "upstream";
  candidate.resolved = true;
}

async function readOnchain(candidate: Candidate, chainRpcs: Map<string, ChainRpcConfig>, signal?: AbortSignal): Promise<number | null> {
  const { assetId, chainId } = candidate.state;
  if (!CHAIN_DROPOUT_ONCHAIN_ROSTER.some((entry) => entry.assetId === assetId && entry.chainId === chainId)) return null;
  if (!chainId || !CHAIN_META[chainId]) return null;
  const contracts = ACTIVE_META_BY_ID.get(assetId)?.contracts?.filter((contract) => contract.chain === chainId) ?? [];
  const urls = registryRpcEndpoints(chainRpcs.get(chainId)).filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);
  const priceUsd = getPegReferencePriceUsd(assetId, candidate.pegKey);
  if (contracts.length !== 1 || urls.length === 0 || priceUsd == null) return null;
  const contract = contracts[0];
  if (contract.kind === "native-denom" || contract.decimals == null) return null;
  try {
    const parentSignal = signal ?? new AbortController().signal;
    const readSignal = chainId === "solana"
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(CHAIN_DROPOUT_POLICY.solanaReadTimeoutMs)])
      : parentSignal;
    const raw = chainId === "solana"
      ? await fetchSolanaTokenSupply(contract.address, readSignal, undefined, urls[0], urls[1])
      : await fetchErc20TotalSupply({ kind: "onchain-evm", chain: chainId, rpcMode: "public-rpc" }, contract.address, readSignal, undefined, urls[0], urls[1]);
    throwIfAborted(readSignal);
    if (raw == null) return null;
    const usd = Number(raw) / 10 ** contract.decimals * priceUsd;
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    warn("supply-chain-guard-onchain-failed", "Reviewed chain supply read failed; trying chain history", { assetId, chainId }, error);
    return null;
  }
}

async function readChart(candidate: Candidate, now: number, signal?: AbortSignal): Promise<void> {
  const llamaId = ACTIVE_META_BY_ID.get(candidate.state.assetId)?.llamaId;
  if (!llamaId) return;
  candidate.state.chartAttemptedAt = now;
  try {
    const result = await fetchTextWithRetry(`${DEFILLAMA_BASE}/stablecoincharts/${encodeURIComponent(candidate.state.chainLabel)}?stablecoin=${encodeURIComponent(llamaId)}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal }, 0);
    if (!result?.response.ok) return;
    const payload: unknown = JSON.parse(result.body);
    if (!Array.isArray(payload)) return;
    // The latest dated point must itself be valid: never walk back past a bad latest observation.
    let latest: { date: number; buckets: unknown } | undefined;
    for (const point of payload) {
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      const date = Number(point.date);
      const seconds = date > 1e12 ? date / 1000 : date;
      if (!Number.isInteger(seconds) || seconds < 0) continue;
      if (!latest || seconds > latest.date) latest = { date: seconds, buckets: point.totalCirculatingUSD };
    }
    if (!latest || !latest.buckets || typeof latest.buckets !== "object" || Array.isArray(latest.buckets)) return;
    const value = (latest.buckets as Record<string, unknown>)[candidate.pegKey];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
    candidate.state.chartPoint = { valueUsd: value, pointDate: latest.date, fetchedAt: now };
  } catch (error) {
    rethrowIfAborted(error, signal);
    warn("supply-chain-guard-history-failed", "Chain chart unavailable; retaining dropout quarantine", { assetId: candidate.state.assetId, chainLabel: candidate.state.chainLabel }, error);
  }
}

/**
 * R2: an unreadable state row must neither release quarantines nor resurrect disproven baselines.
 * Rebuild pairs from the last accepted publication: guarded chains from `supplyChainGuard` provenance
 * (frozen baseline, first detection, held ambiguous total, or a confirmed native-low level), then every
 * other published chain current as its accepted level — including a confirmed low/zero whose guard
 * sidecar disappeared once the chain stopped being flagged. Only unpublished chains bootstrap from seed.
 */
function recoverStateFromPublication(state: ChainDropoutState, previousAssetsById: ReadonlyMap<string, PeggedAsset>, now: number): void {
  for (const previous of previousAssetsById.values()) {
    const assetId = String(previous.id);
    const guard = previous.supplyChainGuard;
    if (guard) {
      const heldTotal = guard.concurrentGainUsd != null && guard.status === "quarantined" ? getCirculatingRawOrNull(previous) : null;
      for (const chain of guard.chains) {
        const key = pairKey(assetId, chain.chainId ?? `label:${chain.chainLabel}`);
        if (state.pairs[key]) continue;
        const identity = { assetId, chainLabel: chain.chainLabel, ...(chain.chainId ? { chainId: chain.chainId } : {}) };
        // A published native-low corroboration released the pair at the native amount: recover that
        // confirmed level, never the old positive baseline it disproved.
        const confirmedLow = chain.resolution === "onchain-total-supply" && chain.repairedCurrentUsd != null && chain.observedAt != null
          && chain.repairedCurrentUsd <= CHAIN_DROPOUT_POLICY.collapseRatio * chain.baselineUsd;
        state.pairs[key] = confirmedLow
          ? { ...identity, baselineUsd: chain.repairedCurrentUsd!, baselineObservedAt: chain.observedAt!, baselineSource: "state", quarantinedSince: null, releasedAt: chain.observedAt! }
          : {
            ...identity,
            baselineUsd: chain.baselineUsd,
            baselineObservedAt: chain.baselineObservedAt,
            baselineSource: "state",
            quarantinedSince: guard.quarantinedSince ?? now,
            ...(guard.concurrentGainUsd != null ? { ambiguousSince: guard.quarantinedSince ?? now } : {}),
            ...(guard.concurrentGainUsd != null ? { heldTotalUsd: heldTotal } : {}),
          };
      }
    }
    const rows = previous.chainCirculating ?? {};
    const canonical = canonicalizeChainCirculating(rows);
    const observedAt = previous.supplyObservedAt ?? now;
    for (const [label, row] of Object.entries(rows)) {
      const chainId = canonicalizeChainCirculating({ [label]: row }).keys().next().value as string | undefined;
      const key = pairKey(assetId, chainId ?? `label:${label}`);
      if (state.pairs[key]) continue;
      const current = chainId ? canonical.get(chainId)?.current : normalizeChainSupplyValue(row.current);
      if (current == null) continue;
      state.pairs[key] = { assetId, chainLabel: label, ...(chainId ? { chainId } : {}), baselineUsd: current, baselineObservedAt: observedAt, baselineSource: "state", quarantinedSince: null };
    }
  }
}

export async function guardChainDropouts(input: {
  assets: PeggedAsset[];
  now: number;
  state: ChainDropoutState;
  stateReadFailed?: boolean;
  /** Last accepted publication; recovers sticky quarantines when the persisted state is unreadable. */
  previousAssetsById?: ReadonlyMap<string, PeggedAsset>;
  skipAssetIds?: ReadonlySet<string>;
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
}): Promise<SupplyChainGuardResult> {
  const { now, signal } = input;
  // The caller owns this newly loaded generation; no module-global mutable state.
  const state = input.state;
  if (input.previousAssetsById) recoverStateFromPublication(state, input.previousAssetsById, now);
  const result: SupplyChainGuardResult = { flagged: 0, repaired: 0, quarantinedAssetIds: [], unavailableAssetIds: [], historyFetches: 0, stateReadFailed: input.stateReadFailed ?? false, state };
  const candidates: Candidate[] = [];
  // Per asset: same-run gains on healthy chains, and the pre-run vetted whole-asset total
  // (each chain at its persisted/seed/prev-day reference, before this run moves any baseline).
  const conservation = new Map<PeggedAsset, { gains: number; vettedTotal: number; vettedComplete: boolean }>();
  const knownPairsByAssetId = new Map<string, PairState[]>();
  for (const pair of Object.values(state.pairs)) {
    if (pair.baselineUsd < CHAIN_DROPOUT_POLICY.minBaselineUsd && pair.quarantinedSince == null) continue;
    const pairs = knownPairsByAssetId.get(pair.assetId) ?? [];
    pairs.push(pair);
    knownPairsByAssetId.set(pair.assetId, pairs);
  }
  for (const asset of input.assets) {
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));
    if (!meta || meta.detailProvider !== "defillama" || asset.frozen || asset.supplyRestored || input.skipAssetIds?.has(meta.id) || (asset.supplySource && asset.supplySource !== "defillama")) continue;
    const pegKey = asset.pegType ?? pegTypeFromCurrency(meta.flags.pegCurrency);
    if (!pegKey) continue;
    if (getCirculatingRawOrNull(asset) == null) continue;
    const rows = asset.chainCirculating ?? (asset.chainCirculating = {});
    const groups = new Map<string, { chainId?: string; labels: string[] }>();
    for (const [label, row] of Object.entries(rows)) {
      const chainId = canonicalizeChainCirculating({ [label]: row }).keys().next().value as string | undefined;
      const identity = chainId ?? `label:${label}`;
      const group = groups.get(identity);
      if (group) group.labels.push(label);
      else groups.set(identity, { chainId, labels: [label] });
    }
    // Omission is unavailable, not a release. Feed known material/quarantined
    // identities through exactly the same repair, ambiguity and carry policies.
    for (const pair of knownPairsByAssetId.get(meta.id) ?? []) {
      const identity = pair.chainId ?? `label:${pair.chainLabel}`;
      if (groups.has(identity)) continue;
      rows[pair.chainLabel] = { current: null };
      groups.set(identity, { chainId: pair.chainId, labels: [pair.chainLabel] });
      if (!asset.chains?.includes(pair.chainLabel)) asset.chains = [...(asset.chains ?? []), pair.chainLabel];
    }
    const canonical = canonicalizeChainCirculating(rows);
    for (const [identity, group] of groups) {
      const label = group.labels[0];
      const observation = group.chainId ? canonical.get(group.chainId)! : { current: normalizeChainSupplyValue(rows[label].current), circulatingPrevDay: normalizeChainSupplyValue(rows[label].circulatingPrevDay) ?? undefined };
      const key = pairKey(meta.id, identity);
      const previous = state.pairs[key];
      const seed = findSeed(meta.id, group.chainId, label, now);
      const baseline = previous?.baselineUsd ?? seed?.baselineUsd ?? observation.circulatingPrevDay;
      const baselineSource = previous ? "state" : seed ? "seed" : "list-prev-day";
      const pair: PairState = previous ?? { assetId: meta.id, chainLabel: label, ...(group.chainId ? { chainId: group.chainId } : {}), baselineUsd: baseline ?? 0, baselineObservedAt: seed ? CHAIN_DROPOUT_SEED_OBSERVED_AT : Math.max(0, now - 86400), baselineSource, quarantinedSince: null };
      const flagged = baseline != null && baseline >= CHAIN_DROPOUT_POLICY.minBaselineUsd && (observation.current == null || observation.current <= CHAIN_DROPOUT_POLICY.collapseRatio * baseline);
      const totals = conservation.get(asset) ?? { gains: 0, vettedTotal: 0, vettedComplete: true };
      // A chain with neither a reference nor a current observation leaves the vetted total unknown (R1).
      if (baseline == null && observation.current == null) totals.vettedComplete = false;
      else totals.vettedTotal += baseline ?? observation.current!;
      if (!flagged && observation.current != null && baseline != null && observation.current > baseline) {
        totals.gains += observation.current - baseline;
      }
      conservation.set(asset, totals);
      if (!flagged) {
        if (observation.current != null) {
          pair.baselineUsd = observation.current;
          pair.baselineObservedAt = now;
          pair.baselineSource = "state";
          pair.quarantinedSince = null;
          delete pair.chartPoint;
          delete pair.chartAttemptedAt;
          state.pairs[key] = pair;
          delete pair.ambiguousSince;
          delete pair.heldTotalUsd;
        }
        continue;
      }
      result.flagged++;
      pair.quarantinedSince ??= now;
      state.pairs[key] = pair;
      const reviewed = REVIEWED_CHAIN_SUPPLY_COLLAPSES.some((entry) => entry.assetId === meta.id && entry.chainId === group.chainId && entry.reviewedAt >= pair.quarantinedSince! && entry.reviewedAt <= now);
      if (reviewed && observation.current != null) {
        pair.baselineUsd = observation.current;
        pair.baselineObservedAt = now;
        pair.quarantinedSince = null;
        pair.releasedAt = now;
        continue;
      }
      candidates.push({ asset, labels: group.labels, pegKey, state: pair, resolved: false, firstFlaggedAt: pair.quarantinedSince!, evidence: { ...(group.chainId ? { chainId: group.chainId } : {}), chainLabel: pair.chainLabel, listCurrentUsd: observation.current, baselineUsd: pair.baselineUsd, baselineObservedAt: pair.baselineObservedAt, baselineSource, resolution: "unavailable" } });
    }
  }
  const chainRpcs = input.chainRpcs ?? buildChainRpcs();
  // A complete reviewed native/canonical aggregate can replace the whole
  // affected generation. Unlike an additive one-chain repair, this measures
  // every healthy leg too, so a persisted attribution hold cannot double count.
  const nativeRecovered = new Set<PeggedAsset>();
  const nativeAttempted = new Set<PeggedAsset>();
  for (const candidate of candidates) {
    if (nativeAttempted.has(candidate.asset)) continue;
    const meta = ACTIVE_META_BY_ID.get(candidate.state.assetId);
    const selected = meta ? selectCuratedAggregateOnchainSupplyProbeContracts(meta) : null;
    const priceUsd = getPegReferencePriceUsd(candidate.state.assetId, candidate.pegKey);
    if (!meta || !selected || priceUsd == null) continue;
    nativeAttempted.add(candidate.asset);
    const observed = await fetchCuratedAggregateOnChainMcap(meta, priceUsd, chainRpcs, signal);
    // Intake's `now` is sync-start, potentially minutes before these real reads.
    // Validate against the read phase without rewriting the observation clock.
    const nativeReadNow = Math.floor(Date.now() / 1000);
    if (!observed?.chainCirculating || observed.observedAt == null || !Number.isFinite(observed.mcap) || observed.mcap <= 0
      || observed.observedAt > nativeReadNow + SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC
      || nativeReadNow - observed.observedAt > 2 * CRON_INTERVALS["sync-stablecoins"]) continue;
    const rows = Object.values(observed.chainCirculating);
    if (rows.some((row) => !Number.isFinite(row.current) || row.current < 0)
      || selected.some(({ config }) => !rows.some((row) => row.chainId === config.chain))
      || rows.reduce((sum, row) => sum + row.current, 0) !== observed.mcap) continue;
    const affected = candidates.filter((entry) => entry.asset === candidate.asset);
    if (affected.some((entry) => !rows.some((row) => row.chainId === entry.state.chainId))) continue;
    for (const entry of affected) {
      const row = rows.find((value) => value.chainId === entry.state.chainId)!;
      repair(entry, row.current, observed.observedAt, "onchain-total-supply");
    }
    const asset = candidate.asset;
    asset.circulating = { [candidate.pegKey]: observed.mcap };
    asset.circulatingPrevDay = null;
    asset.circulatingPrevWeek = null;
    asset.circulatingPrevMonth = null;
    asset.chainCirculating = toPublicChainCirculating(observed.chainCirculating);
    asset.chains = Object.keys(asset.chainCirculating);
    asset.supplySource = observed.supplySource;
    asset.supplyObservedAt = observed.observedAt;
    delete asset.supplyRestored;
    delete asset.supplyGapFill;
    asset.supplyChainGuard = { reason: "supply-chain-dropout", status: "repaired", chains: affected.map((entry) => entry.evidence) };
    for (const pair of Object.values(state.pairs)) {
      if (pair.assetId !== candidate.state.assetId) continue;
      const row = rows.find((value) => value.chainId === pair.chainId);
      if (!row) continue;
      pair.baselineUsd = row.current;
      pair.baselineObservedAt = observed.observedAt;
      pair.baselineSource = "state";
      pair.quarantinedSince = null;
      pair.releasedAt = observed.observedAt;
      delete pair.ambiguousSince;
      delete pair.heldTotalUsd;
    }
    result.repaired += affected.length;
    nativeRecovered.add(asset);
  }
  // All network reads are strictly serial and consume bodies at the existing reader boundary.
  for (const candidate of candidates) {
    throwIfAborted(signal);
    if (nativeRecovered.has(candidate.asset)) continue;
    const onchain = await readOnchain(candidate, chainRpcs, signal);
    if (onchain == null) continue;
    if (onchain > CHAIN_DROPOUT_POLICY.collapseRatio * candidate.state.baselineUsd) {
      repair(candidate, onchain, now, "onchain-total-supply");
      result.repaired++;
    } else {
      // The native read is the vetted amount: publish it (not the disproven list value) and release.
      repair(candidate, onchain, now, "onchain-total-supply");
      result.repaired++;
      candidate.state.baselineUsd = onchain;
      candidate.state.baselineObservedAt = now;
      candidate.state.baselineSource = "state";
      candidate.state.quarantinedSince = null;
      candidate.state.releasedAt = now;
    }
  }
  candidates.sort((a, b) => (b.evidence.baselineUsd - (b.evidence.listCurrentUsd ?? 0)) - (a.evidence.baselineUsd - (a.evidence.listCurrentUsd ?? 0)));
  for (const candidate of candidates) {
    if (candidate.resolved) continue;
    const lastFetch = candidate.state.chartAttemptedAt ?? candidate.state.chartPoint?.fetchedAt;
    if ((lastFetch == null || now - lastFetch >= CHAIN_DROPOUT_POLICY.chartRefetchSec) && result.historyFetches < CHAIN_DROPOUT_POLICY.maxHistoryFetches) {
      result.historyFetches++;
      await readChart(candidate, now, signal);
    }
    const point = candidate.state.chartPoint;
    if (point && point.pointDate <= now && now - point.pointDate <= CHAIN_DROPOUT_POLICY.chartMaxAgeSec && point.valueUsd > CHAIN_DROPOUT_POLICY.collapseRatio * candidate.state.baselineUsd) {
      repair(candidate, point.valueUsd, point.pointDate, "defillama-chain-history");
      result.repaired++;
    }
  }
  for (const asset of input.assets) {
    if (nativeRecovered.has(asset)) continue;
    let affected = candidates.filter((candidate) => candidate.asset === asset && (!candidate.resolved || candidate.evidence.repairedCurrentUsd != null));
    if (affected.length === 0) continue;
    let unrepaired = affected.filter((candidate) => !candidate.resolved);
    const pegKey = affected[0].pegKey;
    // Attribution ambiguity: any same-run gain on this asset's healthy chains may be the dropped supply
    // reattributed by the provider (e.g. a bridge representation moved back to its source chain), and a
    // concurrent mint cannot be told apart from that move. A gain of any size bounds how much of a repair
    // or carry could double count, so without reviewed bridge-aware accounting every unconfirmed additive
    // repair and carry is withheld (observed amounts stay in logs, never scaled or clamped), the dropped chains
    // publish unavailable, and a material drop holds the vetted whole-asset total from before the gain.
    const { gains, vettedTotal, vettedComplete } = conservation.get(asset)!;
    // Native confirmations at/below an observed list value are non-additive. For an omitted chain,
    // a native-confirmed collapse also stands: its issuer-native stock replaces the disproven baseline.
    const confirmations = affected.filter((candidate) =>
      candidate.evidence.resolution === "onchain-total-supply" && candidate.evidence.repairedCurrentUsd != null
      && candidate.evidence.repairedCurrentUsd <= (candidate.evidence.listCurrentUsd
        ?? CHAIN_DROPOUT_POLICY.collapseRatio * candidate.evidence.baselineUsd));
    for (const candidate of confirmations) {
      delete candidate.state.ambiguousSince;
      delete candidate.state.heldTotalUsd;
    }
    const unresolved = affected.filter((candidate) => !confirmations.includes(candidate));
    const dropped = unresolved.reduce((sum, candidate) => sum + candidate.evidence.baselineUsd - (candidate.evidence.listCurrentUsd ?? 0), 0);
    const ambiguousNow = dropped > 0 && gains > 0;
    const persisted = unresolved.find((candidate) => candidate.state.ambiguousSince != null);
    const ambiguous = ambiguousNow || persisted != null;
    // The held total must not resurrect a chain whose redemption was natively confirmed: replace that
    // chain's contribution with its confirmed native amount. That contribution is exact only for a
    // total summed this run (its reference is the same pre-run baseline); a persisted packet froze an
    // earlier, unrecorded contribution that later baselines may have moved, so it becomes unknown (R1).
    // A negative remainder is inconsistent evidence, never clamped to a published zero (R7).
    const confirmedAdjustment = confirmations
      .reduce((sum, candidate) => sum + candidate.evidence.baselineUsd - candidate.evidence.repairedCurrentUsd!, 0);
    // A persisted hold (number, or null when it was unknown) wins over a re-summed total whose healthy
    // baselines may already have absorbed the reattributed supply.
    const heldBase = persisted ? persisted.state.heldTotalUsd ?? null : vettedComplete ? vettedTotal : null;
    const adjustedHeld = heldBase == null || (persisted != null && confirmations.length > 0) ? null : heldBase - confirmedAdjustment;
    const heldTotal = adjustedHeld != null && adjustedHeld >= 0 ? adjustedHeld : null;
    if (ambiguous) {
      for (const candidate of unresolved) {
        candidate.state.ambiguousSince ??= now;
        candidate.state.heldTotalUsd = heldTotal;
        if (candidate.evidence.repairedCurrentUsd == null) continue;
        result.repaired--;
        asset.circulating![pegKey] = (asset.circulating![pegKey] ?? 0) - (candidate.evidence.repairedCurrentUsd - (candidate.evidence.listCurrentUsd ?? 0));
        warn("supply-chain-guard-repair-withheld", "Concurrent healthy-chain gain makes chain attribution ambiguous; repair withheld", {
          assetId: candidate.state.assetId, chainLabel: candidate.state.chainLabel, repairedCurrentUsd: candidate.evidence.repairedCurrentUsd, concurrentGainUsd: gains,
        });
        delete candidate.evidence.repairedCurrentUsd;
        delete candidate.evidence.observedAt;
        delete candidate.evidence.observedAtKind;
        candidate.evidence.resolution = "unavailable";
        candidate.resolved = false;
        if (candidate.state.quarantinedSince == null) {
          // A native-low release this run is withheld with its publication: the pair stays flagged
          // against its vetted baseline and keeps its original first-detection clock.
          candidate.state.quarantinedSince = candidate.firstFlaggedAt;
          candidate.state.baselineUsd = candidate.evidence.baselineUsd;
          candidate.state.baselineObservedAt = candidate.evidence.baselineObservedAt;
          candidate.state.baselineSource = candidate.evidence.baselineSource;
          delete candidate.state.releasedAt;
        }
      }
      unrepaired = unresolved;
    }
    const repairs = affected.filter((candidate) => candidate.evidence.repairedCurrentUsd != null);
    for (const candidate of repairs) {
      if (candidate.evidence.resolution !== "onchain-total-supply" || candidate.state.releasedAt !== now || candidate.state.quarantinedSince != null) continue;
      warn("supply-chain-guard-collapse-corroborated", "Independent native supply corroborates real collapse; publishing native amount and releasing quarantine", { assetId: candidate.state.assetId, chainId: candidate.state.chainId, onchainUsd: candidate.evidence.repairedCurrentUsd, listCurrentUsd: candidate.evidence.listCurrentUsd });
    }
    const deficit = unrepaired.reduce((sum, candidate) => sum + candidate.evidence.baselineUsd - (candidate.evidence.listCurrentUsd ?? 0), 0);
    const aggregate = getCirculatingRawOrNull(asset)!;
    const material = deficit > 0 && deficit >= CHAIN_DROPOUT_POLICY.quarantineDeficitRatio * (aggregate + deficit);
    // Only immaterial chain-only holds can accept a later low daily observation. Assess materiality
    // before any release so same-provider history can never release a quarantined aggregate.
    if (!material) {
      for (const candidate of unrepaired) {
        const point = candidate.state.chartPoint;
        const firstFlaggedAt = candidate.state.quarantinedSince!;
        const listCurrent = candidate.evidence.listCurrentUsd;
        if (listCurrent == null || !point || point.pointDate <= firstFlaggedAt || point.pointDate > now
          || now - point.pointDate > CHAIN_DROPOUT_POLICY.chartMaxAgeSec
          || point.valueUsd > CHAIN_DROPOUT_POLICY.collapseRatio * candidate.state.baselineUsd) continue;
        candidate.state.baselineUsd = listCurrent;
        candidate.state.baselineObservedAt = now;
        candidate.state.baselineSource = "state";
        candidate.state.quarantinedSince = null;
        candidate.state.releasedAt = now;
        candidate.resolved = true;
        warn("supply-chain-guard-immaterial-chart-release", "Later daily series confirms lower immaterial chain level; accepting list observation", {
          assetId: candidate.state.assetId, chainLabel: candidate.state.chainLabel, firstFlaggedAt,
          chartPointDate: point.pointDate, listCurrentUsd: listCurrent,
        });
      }
      affected = affected.filter((candidate) => !candidate.resolved || candidate.evidence.repairedCurrentUsd != null);
      unrepaired = unrepaired.filter((candidate) => !candidate.resolved);
      if (affected.length === 0) continue;
    }
    for (const candidate of unrepaired) setChainCurrent(candidate, null);
    let status: SupplyChainGuardProvenance["status"] = unrepaired.length > 0 ? "chains-unavailable" : "repaired";
    let quarantinedSince: number | undefined;
    if (material) {
      quarantinedSince = Math.min(...unrepaired.map((candidate) => candidate.state.quarantinedSince!));
      result.quarantinedAssetIds.push(String(asset.id));
    }
    const carryExpired = quarantinedSince != null && now - quarantinedSince > SUPPLEMENTAL_RESTORE_MAX_AGE_SEC;
    // ADR-8(c) exception: an unrepaired deficit of at most 5% of the vetted whole-asset total never holds
    // the whole asset, not even inside the carry ceiling. The observed provider remainder publishes with
    // the row's own (provider) clock — never a synthesized restored clock — the dropped chains stay null,
    // the quarantine is retained and nothing is added, so reattributed supply cannot double count.
    const partialCoverage = material && deficit > 0 && deficit <= CHAIN_DROPOUT_POLICY.partialCoverageMaxDeficitRatio * (aggregate + deficit);
    if (material && !partialCoverage) {
      asset.supplyRestored = true;
      // The provider's aggregate history sums only the chains present in this
      // packet; the carried total re-adds the dropped chains, so pairing the two
      // would publish a synthetic move (R1: a carried generation keeps its own
      // history, and here that history is partial). The change stays unavailable
      // until a fresh observed packet lands.
      asset.circulatingPrevDay = null;
      asset.circulatingPrevWeek = null;
      asset.circulatingPrevMonth = null;
      const carriedClocks = unrepaired
        .map((candidate) => candidate.evidence.baselineObservedAt)
        .filter((clock): clock is number => typeof clock === "number" && Number.isSafeInteger(clock) && clock > 0);
      // R2: a carried baseline must name its own observation clock. When any carried baseline has none,
      // the aggregate clock stays missing — never 0/NaN and never another baseline's clock — and the
      // unclocked carry is withheld instead of being published under a synthesized observation time.
      if (carriedClocks.length !== unrepaired.length) {
        delete asset.supplyObservedAt;
        asset.circulating = {};
        status = "unavailable";
        result.unavailableAssetIds.push(String(asset.id));
      } else {
        const carriedClockSec = Math.min(...carriedClocks);
        asset.supplyObservedAt = carriedClockSec;
        if (carryExpired || (ambiguous && heldTotal == null)) {
          asset.circulating = {};
          status = "unavailable";
          result.unavailableAssetIds.push(String(asset.id));
        } else {
          asset.circulating![pegKey] = ambiguous ? heldTotal! : (asset.circulating![pegKey] ?? 0) + deficit;
          status = "quarantined";
          for (const candidate of unrepaired) {
            candidate.evidence.resolution = "carried-baseline";
            candidate.evidence.observedAt = candidate.evidence.baselineObservedAt;
          }
        }
      }
    } else {
      if (repairs.length > 0) {
        asset.supplySource = "defillama-chain-repair";
        // The aggregate clock is the oldest component observation: every admitted repair clock
        // (native local reads included — the repair names when its own read observed the value)
        // and, when the provider row names one, the incoming list clock. A repair without a usable
        // clock leaves the aggregate clock missing; it never borrows another component's clock and
        // is never synthesized as 0/NaN. A native-only repair therefore stamps the aggregate from
        // its own read instead of publishing an unclocked partially current total.
        const repairClocks = repairs
          .map((candidate) => candidate.evidence.observedAt)
          .filter((clock): clock is number => typeof clock === "number" && Number.isSafeInteger(clock) && clock > 0);
        if (repairClocks.length === repairs.length) {
          const incomingClock = supplyObservationClock(asset);
          asset.supplyObservedAt = Math.min(
            ...repairClocks,
            ...(incomingClock == null ? [] : [incomingClock]),
          );
        } else {
          delete asset.supplyObservedAt;
        }
      }
    }
    asset.supplyChainGuard = {
      reason: "supply-chain-dropout", status,
      ...(quarantinedSince != null ? { quarantinedSince } : {}),
      ...(partialCoverage ? { partialCoverage: true as const } : {}),
      ...(ambiguous ? { concurrentGainUsd: gains } : {}),
      chains: affected.map((candidate) => candidate.evidence),
    };
  }
  for (const [key, pair] of Object.entries(state.pairs)) {
    if (pair.baselineUsd < CHAIN_DROPOUT_POLICY.minBaselineUsd && pair.quarantinedSince == null && pair.releasedAt == null
      && !findSeed(pair.assetId, pair.chainId, pair.chainLabel, now)) delete state.pairs[key];
  }
  if (result.flagged > 0) warn("supply-chain-dropout", "Guarded anomalous DefiLlama chain supply observations", { reason: "supply-chain-dropout", flagged: result.flagged, repaired: result.repaired, quarantinedAssetIds: result.quarantinedAssetIds, unavailableAssetIds: result.unavailableAssetIds, historyFetches: result.historyFetches, stateReadFailed: result.stateReadFailed });
  return result;
}
