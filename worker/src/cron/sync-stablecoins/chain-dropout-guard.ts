import { z } from "zod";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalizeChainCirculating, normalizeChainSupplyValue } from "@shared/lib/chains/circulating";
import { CHAIN_META } from "@shared/types/chain-identity";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getCirculatingRawOrNull, SUPPLEMENTAL_RESTORE_MAX_AGE_SEC, SUPPLEMENTAL_RESTORE_MAX_FUTURE_SKEW_SEC } from "@shared/lib/supply";
import { selectCuratedAggregateOnchainSupplyProbeContracts } from "@shared/lib/onchain-supply-probe";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { FIXED_PEG_SEVERE_DOWNSIDE_RATIO } from "@shared/lib/pricing-source-policy";
import type { SupplyChainGuardProvenance } from "@shared/types/market";
import { buildChainRpcs, registryRpcEndpoints, type ChainRpcConfig } from "../../lib/chain-registry";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import { fetchErc20TotalSupply } from "../reserve-adapters/onchain";
import { fetchSolanaTokenSupply } from "../../lib/chain-observation";
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
  // Catalog mint-authority reviews identify independent issuer-native stocks; no bridge subtraction.
  { assetId: "moveusd-cfx", chainId: "solana" },
  { assetId: "rwausdi-multipli", chainId: "ethereum" },
  { assetId: "rwausdi-multipli", chainId: "base" },
  { assetId: "rwausdi-multipli", chainId: "monad" },
  { assetId: "rwausdi-multipli", chainId: "arbitrum" },
  { assetId: "rwausdi-multipli", chainId: "xlayer" },
  { assetId: "rwausdi-multipli", chainId: "robinhood" },
  // 2026-11-04: Pharos block 22082858 confirms 3,210,140 native tokens (rpc.pharos.xyz).
  { assetId: "rwausdi-multipli", chainId: "pharos" },
] as const;
const REVIEWED_CHAIN_SUPPLY_COLLAPSES: readonly {
  assetId: string; chainId: string; reviewedAt: number; evidenceUrl: string;
  /** Omitted-only release: exclude the unknown contribution until re-review, never value it at zero. */
  excludeOmittedUntil?: number;
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
  // 2026-11-06: Polygon block 96823850 confirms 363,068.694747281274675608 SBC
  // at the held baseline's own clock. Block 96856472 has 463,068.694747281274675608;
  // both disprove the held $1.846M level. Accept the provider's lower observation unchanged.
  {
    assetId: "sbc-brale", chainId: "polygon",
    reviewedAt: Date.parse("2026-11-06T18:42:00Z") / 1000,
    evidenceUrl: "https://polygonscan.com/token/0xfdcc3dd6671eab0709a4c0f3f53de9a333d80798",
  },
  // Finalized Solana slot 466634085 confirms 7,808,083.761641852 SBC, matching
  // the price-adjusted list's $7.798M rather than the held $15.916M baseline.
  {
    assetId: "sbc-brale", chainId: "solana",
    reviewedAt: Date.parse("2026-11-07T19:45:46Z") / 1000,
    evidenceUrl: "https://solscan.io/token/DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA",
  },
  // Ethereum block 26365071: 1,001,981.18 GBPA total; Etherscan holders confirms
  // the detail feed's 1,001,879.18 unreleased balance, leaving 102 circulating.
  {
    assetId: "gbpa-agant", chainId: "ethereum",
    reviewedAt: Date.parse("2026-11-07T19:45:46Z") / 1000,
    evidenceUrl: "https://etherscan.io/token/0xbbe6aab0ed76e90aea0d1cd978ec231c8adcdf8b#balances",
  },
  // Finalized Solana slot 466212454 confirms 2,153,029.477071 EUROP, matching
  // detail native supply. Ethereum block 26357578 has 9,824,599.672717 tokens;
  // the lower Solana stock is real, without claiming a matched cross-chain migration.
  {
    assetId: "europ-schuman", chainId: "solana",
    reviewedAt: Date.parse("2026-11-06T18:42:00Z") / 1000,
    evidenceUrl: "https://solscan.io/token/euro5sNHrZC2wu2RoLvy6xxoVMc3Qnd1vjxoWf4MftA",
  },
  // 2026-11-03 10:09 UTC: BOB block 40419289 (rpc.gobob.xyz) confirms
  // 1,322,822.22 satUSD, matching the lower list level after River's BOB
  // redemption; the persisted $15.26M baseline is a disproven pre-collapse level.
  {
    assetId: "satusd-river", chainId: "bob",
    reviewedAt: Date.parse("2026-11-03T10:09:25Z") / 1000,
    evidenceUrl: "https://explorer.gobob.xyz/token/0xecf21b335b41f9d5a89f6186a99c19a3c467871f",
  },
  // 2026-11-03 10:09 UTC: Base block 53455609 (mainnet.base.org) confirms
  // 239,013.52 satUSD, exactly the observed list current.
  {
    assetId: "satusd-river", chainId: "base",
    reviewedAt: Date.parse("2026-11-03T10:09:25Z") / 1000,
    evidenceUrl: "https://basescan.org/token/0x70654aad8b7734dc319d0c3608ec7b32e03fa162",
  },
  // 2026-11-03 10:09 UTC: Ethereum block 26333581 (ethereum-rpc.publicnode.com)
  // confirms 932,368.82 satUSD, exactly the observed list current.
  {
    assetId: "satusd-river", chainId: "ethereum",
    reviewedAt: Date.parse("2026-11-03T10:09:23Z") / 1000,
    evidenceUrl: "https://etherscan.io/token/0x1958853a8be062dc4f401750eb233f5850f0d0d2",
  },
  // 2026-11-03 10:16 UTC: Solana slot 464859942 (api.mainnet-beta.solana.com)
  // confirms 794,463.996947 DUSD, matching the lower list level after StandX's
  // Solana contraction from $3.01M.
  {
    assetId: "dusd-standx", chainId: "solana",
    reviewedAt: Date.parse("2026-11-03T10:16:00Z") / 1000,
    evidenceUrl: "https://solscan.io/token/DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM",
  },
  // 2026-11-04 00:05 UTC: Plasma block 36808012 (rpc.plasma.to) confirms
  // 13,372,760.551335 TRYB, matching the lower list level after BiLira's Plasma
  // burns (blocks 35221462 and 36085454); the $1.42M baseline is pre-burn.
  {
    assetId: "tryb-bilira", chainId: "plasma",
    reviewedAt: Date.parse("2026-11-04T00:05:26Z") / 1000,
    evidenceUrl: "https://plasmascan.to/token/0x90729a45948c3078890bc80f2a4e7870a2ea4c5e",
  },
  // 2026-11-04 09:03 UTC: finalized Ethereum block 26340352 confirms 2,000,000 USDQ,
  // matching list/detail after the reduction from the frozen 7M baseline.
  {
    assetId: "usdq-quantoz", chainId: "ethereum",
    reviewedAt: Date.parse("2026-11-04T09:03:51Z") / 1000,
    evidenceUrl: "https://etherscan.io/token/0xc83e27f270cce0a3a3a29521173a83f402c1768b",
  },
  // Finalized Base block 53496375 confirms 91,362.381965885876828965 USDGLO,
  // matching native detail and price-adjusted list stock, down from the $1.018M baseline.
  {
    assetId: "usdglo-glo", chainId: "base",
    reviewedAt: Date.parse("2026-11-04T09:03:51Z") / 1000,
    evidenceUrl: "https://basescan.org/token/0x4f604735c1cf31399c6e711d5962b2b3e0225ad3",
  },
  // Tempo absent from list/detail. Finalized block 47370052 confirms 17,161,941.91
  // BUIDL shares, not the stale $107.4M baseline. Owner accepts omission, never par-NAV valuation.
  {
    assetId: "buidl-blackrock", chainId: "tempo",
    reviewedAt: Date.parse("2026-11-04T09:03:53Z") / 1000,
    excludeOmittedUntil: Date.parse("2026-11-18T09:03:53Z") / 1000,
    evidenceUrl: "https://explorer.tempo.xyz/token/0xb5ff12bd8010baef823d1bfa2ce6bdc0109cbb24",
  },
  // Finalized Tempo block 47370053 confirms 1M fxUSD, also omitted by list/detail.
  // Catalog review identifies a lock/mint representation, ineligible for additive native repair.
  {
    assetId: "fxusd-f-x-protocol", chainId: "tempo",
    reviewedAt: Date.parse("2026-11-04T09:03:53Z") / 1000,
    excludeOmittedUntil: Date.parse("2026-11-18T09:03:53Z") / 1000,
    evidenceUrl: "https://explorer.tempo.xyz/token/0x20c000000000000000000000850e533bd762b72c",
  },
  // HyperEVM block 50654180 reads 43,067.502661 frxUSD, already included under
  // the provider's Hyperliquid L1 row; exclude the omitted old $3.749M identity.
  {
    assetId: "frxusd-frax", chainId: "hyperevm",
    reviewedAt: Date.parse("2026-11-07T19:45:46Z") / 1000,
    excludeOmittedUntil: Date.parse("2026-11-21T19:45:46Z") / 1000,
    evidenceUrl: "https://purrsec.com/token/0x80eede496655fb9047dd39d9f418d5483ed600df",
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
    rows[label].current = value == null ? null : weightTotal > 0 ? value * (weights[index] / weightTotal) : index === 0 ? value : 0;
  });
}
type ChainHistoryBucket = "circulatingPrevDay" | "circulatingPrevWeek" | "circulatingPrevMonth";
/**
 * The provider aggregate's history buckets sum only the chains present in this packet, while a carried
 * chain enters the headline at its frozen baseline. A bucket therefore keeps the provider's meaning only
 * when that chain's own packet row still observed exactly the carried baseline (the carried chain's
 * window change is then zero). An absent row (BUIDL/TRYB) or a bucket that has aged away from the
 * baseline would pair the carried total against a different composition and must stay unavailable (R1).
 */
function carriedHistoryBucketObserved(
  asset: PeggedAsset,
  unrepaired: readonly Candidate[],
  key: ChainHistoryBucket,
): boolean {
  const canonical = canonicalizeChainCirculating(asset.chainCirculating);
  return unrepaired.every((candidate) => {
    const bucket = candidate.state.chainId
      ? canonical.get(candidate.state.chainId)?.[key]
      : normalizeChainSupplyValue(asset.chainCirculating?.[candidate.state.chainLabel]?.[key]);
    return bucket != null && bucket === candidate.state.baselineUsd;
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
  const meta = ACTIVE_META_BY_ID.get(assetId);
  const contracts = meta?.contracts?.filter((contract) => contract.chain === chainId) ?? [];
  const config = chainRpcs.get(chainId);
  // Reviewed Pharos state-only routes are admitted solely for this roster's supply reads.
  const endpoints = assetId === "rwausdi-multipli" && chainId === "pharos"
    ? config?.endpoints.filter((endpoint) => endpoint.position === "supplemental" && endpoint.stateHistory === "archive"
      && endpoint.logsHistory === "none" && !endpoint.routingDisabled) ?? []
    : registryRpcEndpoints(config);
  const urls = endpoints.filter((endpoint) => endpoint.operator !== "dwellir").map((endpoint) => endpoint.url);
  const supplyFallback = meta && selectCuratedAggregateOnchainSupplyProbeContracts(meta)
    ?.find(({ config: profile }) => profile.chain === chainId)?.config.fallbackRpcUrl;
  const fallbackUrl = urls[1] ?? (supplyFallback !== urls[0] ? supplyFallback : undefined);
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
      ? await fetchSolanaTokenSupply(contract.address, readSignal, undefined, urls[0], fallbackUrl)
      : await fetchErc20TotalSupply({ kind: "onchain-evm", chain: chainId, rpcMode: "public-rpc" }, contract.address, readSignal, undefined, urls[0], fallbackUrl);
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
            quarantinedSince: chain.reviewedExclusion?.quarantinedSince ?? guard.quarantinedSince ?? now,
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
  const fillDefaultAssets = new Map<PeggedAsset, number>();
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
    if (meta.flags.pegCurrency === "USD" && asset.priceListFillDefault
      && asset.priceListFillDefault.value < FIXED_PEG_SEVERE_DOWNSIDE_RATIO) fillDefaultAssets.set(asset, getCirculatingRawOrNull(asset)!);
    conservation.set(asset, { gains: 0, vettedTotal: 0, vettedComplete: true });
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
      const reviewed = REVIEWED_CHAIN_SUPPLY_COLLAPSES.find((entry) => entry.assetId === meta.id && entry.chainId === group.chainId
        && entry.reviewedAt >= (pair.quarantinedSince ?? now) && entry.reviewedAt <= now);
      if (observation.current == null && reviewed?.excludeOmittedUntil != null && now < reviewed.excludeOmittedUntil) {
        // Retain the original incident and baseline for expiry/recovery; neither enters this generation's totals.
        pair.quarantinedSince ??= now;
        state.pairs[key] = pair;
        candidates.push({ asset, labels: group.labels, pegKey, state: pair, resolved: true, firstFlaggedAt: pair.quarantinedSince,
          evidence: { chainId: group.chainId, chainLabel: label, listCurrentUsd: null, baselineUsd: pair.baselineUsd,
            baselineObservedAt: pair.baselineObservedAt, baselineSource, resolution: "unavailable",
            reviewedExclusion: { reason: "reviewed-excluded", reviewedAt: reviewed.reviewedAt, expiresAt: reviewed.excludeOmittedUntil,
              quarantinedSince: pair.quarantinedSince, evidenceUrl: reviewed.evidenceUrl } } });
        continue;
      }
      const flagged = baseline != null && baseline >= CHAIN_DROPOUT_POLICY.minBaselineUsd && (observation.current == null || observation.current <= CHAIN_DROPOUT_POLICY.collapseRatio * baseline);
      const totals = conservation.get(asset)!;
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
      if (reviewed && reviewed.excludeOmittedUntil == null && observation.current != null) {
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
    if (candidate.resolved) continue;
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
    if (candidate.resolved || nativeRecovered.has(candidate.asset)) continue;
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
    let affected = candidates.filter((candidate) => candidate.asset === asset && (!candidate.resolved || candidate.evidence.repairedCurrentUsd != null || candidate.evidence.reviewedExclusion != null));
    if (affected.length === 0) continue;
    let unrepaired = affected.filter((candidate) => !candidate.resolved);
    const exclusions = affected.filter((candidate) => candidate.evidence.reviewedExclusion != null);
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
    const unresolved = affected.filter((candidate) => !confirmations.includes(candidate) && !exclusions.includes(candidate));
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
    const adjustedHeld = heldBase == null || (persisted != null && (confirmations.length > 0 || exclusions.length > 0)) ? null : heldBase - confirmedAdjustment;
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
    if (!material && !fillDefaultAssets.has(asset)) {
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
      affected = affected.filter((candidate) => !candidate.resolved || candidate.evidence.repairedCurrentUsd != null || candidate.evidence.reviewedExclusion != null);
      unrepaired = unrepaired.filter((candidate) => !candidate.resolved);
      if (affected.length === 0) continue;
    }
    for (const candidate of unrepaired) setChainCurrent(candidate, null);
    let status: SupplyChainGuardProvenance["status"] = unrepaired.length > 0 || exclusions.length > 0 ? "chains-unavailable" : "repaired";
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
      // would publish a synthetic move (R1). An observed bucket that already
      // equals the carried baseline keeps its provider history (the carried
      // chain's change is zero); an absent chain, an aged-away bucket or an
      // ambiguous held total leaves the change unavailable until a fresh packet.
      for (const bucket of ["circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"] as const) {
        if (ambiguous || !carriedHistoryBucketObserved(asset, unrepaired, bucket)) asset[bucket] = null;
      }
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
    // An exclusion-only row still names its incident; each exclusion also retains its own recovery clock.
    quarantinedSince ??= exclusions.length > 0 ? Math.min(...exclusions.map((candidate) => candidate.firstFlaggedAt)) : undefined;
    asset.supplyChainGuard = {
      reason: "supply-chain-dropout", status,
      ...(quarantinedSince != null ? { quarantinedSince } : {}),
      ...(partialCoverage || exclusions.length > 0 ? { partialCoverage: true as const } : {}),
      ...(ambiguous ? { concurrentGainUsd: gains } : {}),
      chains: affected.map((candidate) => candidate.evidence),
    };
  }
  // The same fill price rescales every list bucket, including history. A sub-$1M chain or an
  // already-rescaled baseline cannot detect that collapse; admit only native evidence or bounded guard carry.
  for (const [asset, listTotal] of fillDefaultAssets) {
    asset.circulatingPrevDay = null;
    asset.circulatingPrevWeek = null;
    asset.circulatingPrevMonth = null;
    const rows = Object.entries(asset.chainCirculating ?? {});
    for (const [, row] of rows) {
      row.circulatingPrevDay = null;
      row.circulatingPrevWeek = null;
      row.circulatingPrevMonth = null;
    }
    if (asset.supplyChainGuard?.status === "quarantined" && asset.supplyRestored && getCirculatingRawOrNull(asset) != null) continue;
    const nativeComplete = nativeRecovered.has(asset) || (rows.length > 0 && rows.every(([label, row]) =>
      asset.supplyChainGuard?.chains.some((chain) => chain.chainLabel === label && chain.resolution === "onchain-total-supply"
        && chain.repairedCurrentUsd != null && chain.repairedCurrentUsd === normalizeChainSupplyValue(row.current)))
      && Math.abs(rows.reduce((sum, [, row]) => sum + normalizeChainSupplyValue(row.current)!, 0) - getCirculatingRawOrNull(asset)!) <= 0.01);
    if (nativeComplete) continue;
    // A reviewed census may lose a small leg; publish only its native remainder, never the rescaled list residue.
    const affected = candidates.filter((candidate) => candidate.asset === asset);
    const native = affected.filter((candidate) => candidate.evidence.resolution === "onchain-total-supply");
    const missing = affected.filter((candidate) => !candidate.resolved);
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));
    const selected = meta && selectCuratedAggregateOnchainSupplyProbeContracts(meta);
    const nativeTotal = native.reduce((sum, candidate) => sum + candidate.evidence.repairedCurrentUsd!, 0);
    const missingBaseline = missing.reduce((sum, candidate) => sum + candidate.evidence.baselineUsd, 0);
    const missingListShare = listTotal > 0 && missing.every((candidate) => candidate.evidence.listCurrentUsd != null)
      ? missing.reduce((sum, candidate) => sum + candidate.evidence.listCurrentUsd!, 0) / listTotal
      : null;
    if (asset.supplyChainGuard?.status === "chains-unavailable" && asset.supplyChainGuard.concurrentGainUsd == null
      && selected?.length === affected.length && rows.length === affected.length
      && selected.every(({ config }) => affected.some((candidate) => candidate.state.chainId === config.chain))
      && missing.length > 0 && native.length + missing.length === affected.length && nativeTotal > 0
      && missingListShare != null && missingListShare <= CHAIN_DROPOUT_POLICY.partialCoverageMaxDeficitRatio
      && missingBaseline <= CHAIN_DROPOUT_POLICY.partialCoverageMaxDeficitRatio * (nativeTotal + missingBaseline)) {
      asset.circulating = { [affected[0].pegKey]: nativeTotal };
      asset.supplyObservedAt = Math.min(...native.map((candidate) => candidate.evidence.observedAt!));
      asset.supplyChainGuard.partialCoverage = true;
      asset.supplyChainGuard.quarantinedSince = Math.min(...missing.map((candidate) => candidate.firstFlaggedAt));
      warn("supply-list-fill-default-partial-native", "Publishing only the observed native remainder of a fill-default asset", {
        assetId: asset.id, missingChainIds: missing.map((candidate) => candidate.state.chainId), missingListShare,
      });
      continue;
    }
    asset.circulating = {};
    for (const [, row] of rows) row.current = null;
    delete asset.supplyRestored;
    delete asset.supplyObservedAt;
    asset.supplyUnavailableReason = "supply-chain-dropout";
    if (asset.supplyChainGuard) {
      asset.supplyChainGuard.status = "unavailable";
      delete asset.supplyChainGuard.partialCoverage;
    }
    if (!result.unavailableAssetIds.includes(String(asset.id))) result.unavailableAssetIds.push(String(asset.id));
    warn("supply-list-fill-default-withheld", "Rescaled list supply lacks complete native corroboration; publishing unavailable supply", { assetId: asset.id, reason: "supply-chain-dropout" });
  }
  for (const [key, pair] of Object.entries(state.pairs)) {
    if (pair.baselineUsd < CHAIN_DROPOUT_POLICY.minBaselineUsd && pair.quarantinedSince == null && pair.releasedAt == null
      && !findSeed(pair.assetId, pair.chainId, pair.chainLabel, now)) delete state.pairs[key];
  }
  if (result.flagged > 0) warn("supply-chain-dropout", "Guarded anomalous DefiLlama chain supply observations", { reason: "supply-chain-dropout", flagged: result.flagged, repaired: result.repaired, quarantinedAssetIds: result.quarantinedAssetIds, unavailableAssetIds: result.unavailableAssetIds, historyFetches: result.historyFetches, stateReadFailed: result.stateReadFailed });
  return result;
}
