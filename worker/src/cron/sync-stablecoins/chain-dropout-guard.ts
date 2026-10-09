import { z } from "zod";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalizeChainCirculating, normalizeChainSupplyValue } from "@shared/lib/chains/circulating";
import { CHAIN_META } from "@shared/types/chain-identity";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getCirculatingRawOrNull, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import type { SupplyChainGuardProvenance } from "@shared/types/market";
import { buildChainRpcs, registryRpcUrls, type ChainRpcConfig } from "../../lib/chain-registry";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import { fetchErc20TotalSupply } from "../reserve-adapters/onchain";
import { getPegReferencePriceUsd } from "./supply-gap-reconciliation";
import type { PeggedAsset } from "./enrich-prices-shared";
import { CHAIN_DROPOUT_SEED, CHAIN_DROPOUT_SEED_OBSERVED_AT, CHAIN_DROPOUT_SEED_VALID_UNTIL } from "./chain-dropout-seed";

const CHAIN_DROPOUT_STATE_KEY = "sync-stablecoins:chain-dropout-state";
export const CHAIN_DROPOUT_POLICY = {
  minBaselineUsd: 1_000_000,
  collapseRatio: 0.5,
  quarantineDeficitRatio: 0.02,
  chartMaxAgeSec: 48 * 3600,
  chartRefetchSec: 3600,
  maxHistoryFetches: 8,
} as const;

// Reviewed issuer-native Paxos deployments, not bridge representations. Contracts/decimals are catalog-owned.
export const CHAIN_DROPOUT_ONCHAIN_ROSTER = [
  { assetId: "usdg-paxos", chainId: "xlayer" },
  { assetId: "usdg-paxos", chainId: "ink" },
] as const;
const REVIEWED_CHAIN_SUPPLY_COLLAPSES: readonly {
  assetId: string; chainId: string; reviewedAt: number; evidenceUrl: string;
}[] = [];

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
  heldTotalUsd: z.number().finite().nonnegative().optional(),
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
  candidate.resolved = true;
}

async function readOnchain(candidate: Candidate, chainRpcs: Map<string, ChainRpcConfig>, signal?: AbortSignal): Promise<number | null> {
  const { assetId, chainId } = candidate.state;
  if (!CHAIN_DROPOUT_ONCHAIN_ROSTER.some((entry) => entry.assetId === assetId && entry.chainId === chainId)) return null;
  if (!chainId || !CHAIN_META[chainId]) return null;
  const contracts = ACTIVE_META_BY_ID.get(assetId)?.contracts?.filter((contract) => contract.chain === chainId) ?? [];
  const urls = registryRpcUrls(chainRpcs.get(chainId));
  const priceUsd = getPegReferencePriceUsd(assetId, candidate.pegKey);
  if (contracts.length !== 1 || urls.length === 0 || priceUsd == null) return null;
  const contract = contracts[0];
  if (contract.kind === "native-denom" || contract.decimals == null) return null;
  try {
    const raw = await fetchErc20TotalSupply({ kind: "onchain-evm", chain: chainId, rpcMode: "public-rpc" }, contract.address, signal ?? new AbortController().signal, undefined, urls[0], urls[1]);
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
            ...(heldTotal != null ? { heldTotalUsd: heldTotal } : {}),
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
  if (input.stateReadFailed && input.previousAssetsById) recoverStateFromPublication(state, input.previousAssetsById, now);
  const result: SupplyChainGuardResult = { flagged: 0, repaired: 0, quarantinedAssetIds: [], unavailableAssetIds: [], historyFetches: 0, stateReadFailed: input.stateReadFailed ?? false, state };
  const candidates: Candidate[] = [];
  // Per asset: same-run gains on healthy chains, and the pre-run vetted whole-asset total
  // (each chain at its persisted/seed/prev-day reference, before this run moves any baseline).
  const conservation = new Map<PeggedAsset, { gains: number; vettedTotal: number }>();
  for (const asset of input.assets) {
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));
    if (!meta || meta.detailProvider !== "defillama" || asset.frozen || asset.supplyRestored || input.skipAssetIds?.has(meta.id) || (asset.supplySource && asset.supplySource !== "defillama")) continue;
    const pegKey = asset.pegType ?? pegTypeFromCurrency(meta.flags.pegCurrency);
    if (!pegKey) continue;
    if (getCirculatingRawOrNull(asset) == null) continue;
    const rows = asset.chainCirculating ?? {};
    const canonical = canonicalizeChainCirculating(rows);
    const groups = new Map<string, { chainId?: string; labels: string[] }>();
    for (const [label, row] of Object.entries(rows)) {
      const chainId = canonicalizeChainCirculating({ [label]: row }).keys().next().value as string | undefined;
      const identity = chainId ?? `label:${label}`;
      const group = groups.get(identity);
      if (group) group.labels.push(label);
      else groups.set(identity, { chainId, labels: [label] });
    }
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
      const totals = conservation.get(asset) ?? { gains: 0, vettedTotal: 0 };
      totals.vettedTotal += baseline ?? observation.current ?? 0;
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
  // All network reads are strictly serial and consume bodies at the existing reader boundary.
  for (const candidate of candidates) {
    throwIfAborted(signal);
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
      warn("supply-chain-guard-collapse-corroborated", "Independent native supply corroborates real collapse; publishing native amount and releasing quarantine", { assetId: candidate.state.assetId, chainId: candidate.state.chainId, onchainUsd: onchain, listCurrentUsd: candidate.evidence.listCurrentUsd });
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
    let affected = candidates.filter((candidate) => candidate.asset === asset && (!candidate.resolved || candidate.evidence.repairedCurrentUsd != null));
    if (affected.length === 0) continue;
    let unrepaired = affected.filter((candidate) => !candidate.resolved);
    const pegKey = affected[0].pegKey;
    // Attribution ambiguity: any same-run gain on this asset's healthy chains may be the dropped supply
    // reattributed by the provider (e.g. a bridge representation moved back to its source chain), and a
    // concurrent mint cannot be told apart from that move. A gain of any size bounds how much of a repair
    // or carry could double count, so without reviewed bridge-aware accounting every additive repair and
    // carry is withheld (observed amounts stay in logs, never scaled or clamped), the dropped chains
    // publish unavailable, and a material drop holds the vetted whole-asset total from before the gain.
    const { gains, vettedTotal } = conservation.get(asset)!;
    const dropped = affected.reduce((sum, candidate) => sum + candidate.evidence.baselineUsd - (candidate.evidence.listCurrentUsd ?? 0), 0);
    const ambiguousNow = dropped > 0 && gains > 0;
    const persisted = affected.find((candidate) => candidate.state.ambiguousSince != null);
    const ambiguous = ambiguousNow || persisted != null;
    const heldTotal = persisted?.state.heldTotalUsd ?? vettedTotal;
    if (ambiguous) {
      for (const candidate of affected) {
        candidate.state.ambiguousSince ??= now;
        candidate.state.heldTotalUsd ??= heldTotal;
        if (candidate.evidence.repairedCurrentUsd == null) continue;
        asset.circulating![pegKey] = (asset.circulating![pegKey] ?? 0) - (candidate.evidence.repairedCurrentUsd - (candidate.evidence.listCurrentUsd ?? 0));
        warn("supply-chain-guard-repair-withheld", "Concurrent healthy-chain gain makes chain attribution ambiguous; repair withheld", {
          assetId: candidate.state.assetId, chainLabel: candidate.state.chainLabel, repairedCurrentUsd: candidate.evidence.repairedCurrentUsd, concurrentGainUsd: gains,
        });
        delete candidate.evidence.repairedCurrentUsd;
        delete candidate.evidence.observedAt;
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
      unrepaired = affected;
    }
    const repairs = affected.filter((candidate) => candidate.evidence.repairedCurrentUsd != null);
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
      asset.supplyRestored = true;
      result.quarantinedAssetIds.push(String(asset.id));
      asset.supplyObservedAt = Math.min(...unrepaired.map((candidate) => candidate.evidence.baselineObservedAt));
      if (now - quarantinedSince > SUPPLEMENTAL_RESTORE_MAX_AGE_SEC) {
        asset.circulating = {};
        status = "unavailable";
        result.unavailableAssetIds.push(String(asset.id));
      } else {
        asset.circulating![pegKey] = ambiguous ? heldTotal : (asset.circulating![pegKey] ?? 0) + deficit;
        status = "quarantined";
        for (const candidate of unrepaired) {
          candidate.evidence.resolution = "carried-baseline";
          candidate.evidence.observedAt = candidate.evidence.baselineObservedAt;
        }
      }
    } else {
      if (repairs.length > 0) {
        asset.supplySource = "defillama-chain-repair";
        asset.supplyObservedAt = Math.min(...repairs.map((candidate) => candidate.evidence.observedAt!));
      }
    }
    asset.supplyChainGuard = {
      reason: "supply-chain-dropout", status,
      ...(quarantinedSince != null ? { quarantinedSince } : {}),
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
