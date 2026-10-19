import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";
import type { ChainRpcConfig } from "../chain-registry";

export type SupplyAttributionPhase = "observation" | "reference" | "holdings" | "pinning" |
  "conversions" | "pending" | "pending-authentication" | "pending-history" | "pending-discovery" | "recheck" | "derive";

export type SupplyAttributionPerformance = {
  elapsedMs: number;
  phaseElapsedMs: Partial<Record<SupplyAttributionPhase, number>>;
  evmRpcRequests: number;
  evmRpcCalls: number;
  providers: Record<string, number>;
  unlistedProviderRequests: number;
  lastRpc: { chainId: string; providerOrigin: string; method: string } | null;
  lastCursor: { observer: string; laneId: string | null; before: string | null;
    after: string | null; target: string | null; persisted: boolean } | null;
};

/** Bounded run metadata, not evidence admission or a persisted history checkpoint. */
export function createSupplyAttributionPerformance() {
  const startedAt = Date.now();
  let phase: SupplyAttributionPhase = "observation";
  let phaseStartedAt = startedAt;
  const restore: Array<() => void> = [];
  const data: SupplyAttributionPerformance = {
    elapsedMs: 0,
    phaseElapsedMs: {},
    evmRpcRequests: 0,
    evmRpcCalls: 0,
    providers: {},
    unlistedProviderRequests: 0,
    lastRpc: null,
    lastCursor: null,
  };
  const setPhase = (next: SupplyAttributionPhase) => {
    const now = Date.now();
    data.phaseElapsedMs[phase] = (data.phaseElapsedMs[phase] ?? 0) + Math.max(0, now - phaseStartedAt);
    phase = next;
    phaseStartedAt = now;
  };
  return {
    data,
    setPhase,
    recordDiagnostic(diagnostic: SupplyAttributionAttemptDiagnostic) {
      if (diagnostic.beforeCursor !== null || diagnostic.afterCursor !== null) {
        data.lastCursor = { observer: diagnostic.observer, laneId: diagnostic.laneId,
          before: diagnostic.beforeCursor, after: diagnostic.afterCursor,
          target: diagnostic.targetCursor, persisted: diagnostic.persisted };
      }
    },
    withRpcDiagnostics(chainRpcs: Map<string, ChainRpcConfig> | undefined, signal?: AbortSignal) {
      if (!chainRpcs) return undefined;
      // Keep map identity: provider demotion is keyed by this invocation's map.
      // Filter by the child signal so other slot readers are never attributed here.
      for (const [chainId, config] of chainRpcs) {
        const previous = config.onRpcRequest;
        config.onRpcRequest = request => {
          previous?.(request);
          if (request.signal !== signal) return;
          data.evmRpcRequests++;
          data.evmRpcCalls += request.rpcCalls;
          const origin = request.providerOrigin;
          if (Object.prototype.hasOwnProperty.call(data.providers, origin) || Object.keys(data.providers).length < 3) {
            data.providers[origin] = (data.providers[origin] ?? 0) + 1;
          } else {
            data.unlistedProviderRequests++;
          }
          data.lastRpc = { chainId, providerOrigin: origin, method: request.method };
        };
        restore.push(() => {
          if (previous) config.onRpcRequest = previous;
          else delete config.onRpcRequest;
        });
      }
      return chainRpcs;
    },
    finish() {
      setPhase(phase);
      data.elapsedMs = Math.max(0, Date.now() - startedAt);
      for (const cleanup of restore) cleanup();
      restore.length = 0;
    },
  };
}

export function emitSupplyAttributionDiagnostic(
  callback: ((diagnostic: SupplyAttributionAttemptDiagnostic) => void) | undefined,
  detail: Pick<SupplyAttributionAttemptDiagnostic, "observer" | "sourceId"> & Partial<SupplyAttributionAttemptDiagnostic>,
): void {
  callback?.({ laneId: null, chainId: null, providerOrigin: null, method: "unknown", phase: "observation", beforeCursor: null, afterCursor: null, targetCursor: null, pinObservedAtSec: null, finalizedLagBlocks: null, persisted: false, authenticatedCursorAdvanced: false, incompleteBootstrap: false, hardEvidenceFailure: false, failurePredicate: null, ...detail });
}
