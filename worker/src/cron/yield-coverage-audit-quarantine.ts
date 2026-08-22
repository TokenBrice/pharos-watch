import { getChainRpc, type ChainRpcConfig } from "../lib/chain-registry";
import { fetchEvmUint256AtBlock } from "../lib/evm-rpc";
import { encodeUint256 } from "../lib/evm-selectors";
import { buildOnChainSourceKey } from "../lib/yield-utils";
import { resolveRpcUrls } from "./yield-sync/sources-helpers";
import { QUARANTINED_DETERMINISTIC_PROBE_CONFIGS } from "../lib/yield-config/yield-config-rate-sources";

const QUARANTINE_PROBE_RATE_ENVELOPE_MAX = 3;
const QUARANTINE_PROBE_REQUEST_TIMEOUT_MS = 6_000;

interface QuarantineProbeAdapter {
  stablecoinId: string;
  code: string;
  since: string;
  nextReviewAt?: string;
  note?: string;
}

export interface QuarantineRestoreCandidate extends QuarantineProbeAdapter {
  sourceKey: string;
  chain: string;
  contract: string;
  exchangeRate: number;
}

export interface QuarantineProbeSummary {
  configuredProbeCount: number;
  attemptedCount: number;
  readyToRestoreCount: number;
  skippedCount: number;
  failureCounts: Record<string, number>;
  skippedReason?: "chain-rpcs-unavailable";
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function buildProbeRpcUrls(rpc?: ChainRpcConfig): string[] {
  return resolveRpcUrls(rpc, { order: "fallback-first" });
}

function isUsableQuarantineProbeRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0 && rate <= QUARANTINE_PROBE_RATE_ENVELOPE_MAX;
}

async function fetchQuarantineProbeRate(params: {
  config: (typeof QUARANTINED_DETERMINISTIC_PROBE_CONFIGS)[number];
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
}): Promise<number | null> {
  const rpcUrls = buildProbeRpcUrls(getChainRpc(params.chainRpcs, params.config.chain));
  if (rpcUrls.length === 0) return null;

  const callData = params.config.selector + encodeUint256(BigInt(params.config.inputAmount));
  for (const rpcUrl of rpcUrls) {
    try {
      const raw = await fetchEvmUint256AtBlock(undefined, params.config.contract, callData, "latest", {
        extraRpcUrls: [rpcUrl],
        signal: params.signal,
        timeoutMs: QUARANTINE_PROBE_REQUEST_TIMEOUT_MS,
      });
      if (raw == null) continue;
      return Number(raw) / 10 ** params.config.decimals;
    } catch (error) {
      if (params.signal?.aborted) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  return null;
}

export async function probeQuarantinedDeterministicAdapters(params: {
  quarantinedAdapters: readonly QuarantineProbeAdapter[];
  chainRpcs?: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
}): Promise<{
  readyToRestore: QuarantineRestoreCandidate[];
  summary: QuarantineProbeSummary;
}> {
  const probeConfigsById = new Map(
    QUARANTINED_DETERMINISTIC_PROBE_CONFIGS.map((config) => [config.stablecoinId, config] as const),
  );
  const probeTargets = params.quarantinedAdapters.filter((adapter) => probeConfigsById.has(adapter.stablecoinId));
  const failureCounts: Record<string, number> = {};

  if (!params.chainRpcs) {
    return {
      readyToRestore: [],
      summary: {
        configuredProbeCount: probeTargets.length,
        attemptedCount: 0,
        readyToRestoreCount: 0,
        skippedCount: probeTargets.length,
        failureCounts,
        skippedReason: "chain-rpcs-unavailable",
      },
    };
  }

  const readyToRestore: QuarantineRestoreCandidate[] = [];
  let attemptedCount = 0;
  let skippedCount = 0;

  for (const adapter of probeTargets) {
    const config = probeConfigsById.get(adapter.stablecoinId);
    if (!config) {
      skippedCount += 1;
      incrementCount(failureCounts, "missing-probe-config");
      continue;
    }

    attemptedCount += 1;
    try {
      const rate = await fetchQuarantineProbeRate({
        config,
        chainRpcs: params.chainRpcs,
        signal: params.signal,
      });
      if (rate == null) {
        incrementCount(failureCounts, "empty-result");
        continue;
      }
      if (!isUsableQuarantineProbeRate(rate)) {
        incrementCount(failureCounts, "out-of-envelope");
        continue;
      }
      readyToRestore.push({
        ...adapter,
        sourceKey: buildOnChainSourceKey(adapter.stablecoinId),
        chain: config.chain,
        contract: config.contract,
        exchangeRate: Number(rate.toFixed(12)),
      });
    } catch (error) {
      if (params.signal?.aborted) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      incrementCount(failureCounts, "fetch-error");
    }
  }

  return {
    readyToRestore,
    summary: {
      configuredProbeCount: probeTargets.length,
      attemptedCount,
      readyToRestoreCount: readyToRestore.length,
      skippedCount,
      failureCounts,
    },
  };
}
