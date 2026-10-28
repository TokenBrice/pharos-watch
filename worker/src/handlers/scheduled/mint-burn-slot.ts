import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncMintBurn } from "../../cron/sync-mint-burn";
import type { MintBurnLane } from "../../lib/mint-burn-pipeline/types";
import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { recordOutcomeDecision, shouldAttemptFetch, type CircuitOutcomeDecision } from "../../lib/circuit-breaker";
import { getRpcAuth, type RpcOperator } from "../../lib/chain-registry";
import type { JsonRpcTransportOutcome } from "../../lib/evm-rpc";
import { withRpcRequestObserver } from "../../lib/rpc-request-observer";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  buildScheduledSlotSummary,
  summarizeCronResult,
} from "./slot-summary";
import { parseJsonObject } from "../../lib/json-parse";

interface MintBurnSlotOptions {
  lane: MintBurnLane;
  jobName: string;
  runSidecar?: (runtime: ScheduledRuntimeContext, signal: AbortSignal) => Promise<MintBurnSidecarOutcome>;
}

interface MintBurnProviderOutcome {
  provider: RpcOperator;
  circuitSource: string | null;
  successes: number;
  failures: number;
  neutral: number;
  blockedRequests: number;
  reasons: Record<string, number>;
}

const RPC_RATE_LIMIT_MESSAGE = /rate[- ]?limit|too many requests|throughput|quota (?:exceeded|exhausted)/i;

function isSemanticRpcError({ code, message = "" }: { code?: number; message?: string }): boolean {
  return !RPC_RATE_LIMIT_MESSAGE.test(message) && (code === 3 || code === -32601 || code === -32602 || code === -32005
    || /execution reverted|does not support|not supported|unsupported|block range|block limit|out of range|range (?:is )?(?:too|exceed)|too many logs|max(?:imum)? results|query returned more than|response size/i.test(message));
}

function providerDecision(outcome: JsonRpcTransportOutcome): { decision: CircuitOutcomeDecision; reason: string } {
  if (outcome.status === "control-error") return { decision: "neutral", reason: "request-not-completed" };
  if (outcome.status === "transport-error" || outcome.status === "parse-error"
    || outcome.status === "invalid-envelope") {
    return { decision: "failure", reason: outcome.status };
  }
  if (outcome.invalidRows > 0 || outcome.rows.size === 0) return { decision: "failure", reason: "invalid-envelope" };
  const rows = [...outcome.rows.values()];
  if (outcome.status === "http-error") {
    const status = outcome.response.status;
    // Providers may return a valid request/config rejection with HTTP 400. Auth, throttle and outage status wins.
    const semanticClientError = status >= 400 && status < 500 && ![401, 402, 403, 408, 429].includes(status)
      && rows.every((row) => row.error && isSemanticRpcError(row.error));
    return semanticClientError
      ? { decision: "neutral", reason: "rpc-semantic-error-or-unavailable-result" }
      : { decision: "failure", reason: "http-error" };
  }
  for (const row of rows) {
    if (!row.error) continue;
    const { code, message = "" } = row.error;
    if (RPC_RATE_LIMIT_MESSAGE.test(message)) {
      return { decision: "failure", reason: "rpc-rate-limited" };
    }
    // These errors describe the request/config or its supported range, even when a provider uses -32603.
    if (isSemanticRpcError(row.error)) continue;
    if (code === -32603 || /internal (?:server )?error|server error|service unavailable|overload|timed? out|timeout/i.test(message)) {
      return { decision: "failure", reason: "rpc-server-error" };
    }
  }
  // Other semantic failures and absent objects are read evidence, without enough evidence to blame the provider.
  if (rows.some((row) => row.error || row.result == null)) {
    return { decision: "neutral", reason: "rpc-semantic-error-or-unavailable-result" };
  }
  return { decision: "success", reason: "rpc-response" };
}

export interface MintBurnSidecarOutcome {
  name: string;
  status: "ok" | "degraded" | "error";
  itemCount: number;
  reason: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

function appendSidecarOutcome(result: CronResult, sidecar: MintBurnSidecarOutcome): CronResult {
  let metadata: Record<string, unknown> = {};
  if (result.metadata) {
    const parsed = parseJsonObject(result.metadata);
    if (parsed) {
      metadata = parsed;
    } else {
      metadata.rawMetadata = result.metadata;
    }
  }
  const status = sidecar.status === "ok"
    ? result.status
    : result.status === "error"
      ? "error"
      : "degraded";
  return {
    ...result,
    status,
    metadata: JSON.stringify({
      ...metadata,
      ...((result.status == null || result.status === "ok") && sidecar.status !== "ok"
        ? { reason: sidecar.reason } : {}),
      sidecars: [{
        name: sidecar.name,
        status: sidecar.status,
        itemCount: sidecar.itemCount,
        reason: sidecar.reason,
        error: sidecar.error ?? null,
        ...(sidecar.metadata ?? {}),
      }],
    }),
  };
}

export async function runMintBurnSlot(
  runtime: ScheduledRuntimeContext,
  options: MintBurnSlotOptions,
) {
  const result = await runtime.runLeasedCron(options.jobName, async (signal, reportProgress) => {
    const alchemyAllowed = await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.ALCHEMY);
    const endpoints = new Map([...runtime.chainRpcs.values()].flatMap((config) =>
      config.endpoints.map((endpoint) => [endpoint.url, endpoint.operator] as const)));
    const providerOutcomes = new Map<RpcOperator, MintBurnProviderOutcome>();
    const observationFor = (url: string): MintBurnProviderOutcome => {
      const provider = endpoints.get(url) ?? getRpcAuth(url)?.provider ?? "public";
      let observation = providerOutcomes.get(provider);
      if (!observation) {
        observation = { provider, circuitSource: provider === "alchemy" ? CIRCUIT_SOURCE.ALCHEMY
          : provider === "dwellir" ? CIRCUIT_SOURCE.DWELLIR_EVM : null,
        successes: 0, failures: 0, neutral: 0, blockedRequests: 0, reasons: {} };
        providerOutcomes.set(provider, observation);
      }
      return observation;
    };
    let primary: CronResult;
    try {
      primary = await withRpcRequestObserver({
        beforeRequest: (url) => {
          const observation = observationFor(url);
          if (observation.provider === "alchemy" && !alchemyAllowed) {
            observation.blockedRequests++;
            observation.reasons["circuit-open"] = (observation.reasons["circuit-open"] ?? 0) + 1;
            return false;
          }
          return true;
        },
        onOutcome: (url, outcome) => {
          const observation = observationFor(url);
          const { decision, reason } = providerDecision(outcome);
          if (decision === "success") observation.successes++;
          else if (decision === "failure") observation.failures++;
          else observation.neutral++;
          observation.reasons[reason] = (observation.reasons[reason] ?? 0) + 1;
        },
      }, () => syncMintBurn(runtime.db, runtime.env.ALCHEMY_API_KEY ?? null, {
        signal,
        disabledConfigIds: runtime.mintBurnDisabledIds,
        disabledSymbols: runtime.mintBurnDisabledSymbols,
        lane: options.lane,
        jobName: options.jobName,
        onProgress: reportProgress,
        chainRpcs: runtime.chainRpcs,
      }));
    } finally {
      for (const observation of providerOutcomes.values()) {
        if (!observation.circuitSource) continue;
        const decision = observation.failures > 0 ? "failure" : observation.successes > 0 ? "success" : "neutral";
        await recordOutcomeDecision(runtime.db, observation.circuitSource, decision).catch((error) => {
          logWorkerEvent({ scope: "handler", level: "error", event: "mint_burn_provider_outcome_write_failed",
            message: "Failed to record observed mint/burn RPC outcome", job: options.jobName,
            provider: observation.provider, error });
        });
      }
    }
    primary = { ...primary, metadata: JSON.stringify({
      ...(primary.metadata ? parseJsonObject(primary.metadata) ?? { rawMetadata: primary.metadata } : {}),
      providerOutcomes: [...providerOutcomes.values()],
    }) };
    if (!options.runSidecar || (primary.status !== undefined && primary.status !== "ok" && primary.status !== "degraded")) {
      return primary;
    }
    const sidecar = await options.runSidecar(runtime, signal);
    return appendSidecarOutcome(primary, sidecar);
  });
  return buildScheduledSlotSummary([summarizeCronResult(options.jobName, result)]);
}
