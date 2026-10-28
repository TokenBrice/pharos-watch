import { DWELLIR_NATIVE_ENDPOINTS, type DwellirNativeNetwork } from "@shared/lib/dwellir-native-endpoints";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isTronJsonRpcRead, tronRpcResponseByteLimit } from "@shared/lib/tron-jsonrpc";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../cron/reserve-adapters/request";
import type { AdapterContext } from "../cron/reserve-adapters/types";
import { recordDwellirCredits } from "./rpc-provider-budget";
import { isResponseBodyTooLargeError } from "./response-body";

/** Opaque transport capability, issued only after scheduled-runtime admission. */
export interface DwellirNativeCapability {
  isNetworkEnabled?(network: DwellirNativeNetwork): boolean;
  readJson<T>(
    network: DwellirNativeNetwork,
    path: string,
    signal: AbortSignal,
    ctx?: AdapterContext,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T>;
}

/** The caller owns admission; this transport never reads budget/circuit state. */
export function createDwellirNativeCapability(
  apiKey: string,
  disabledNetworks?: ReadonlySet<string>,
): DwellirNativeCapability {
  if (!apiKey.trim()) throw new Error("Dwellir native transport requires an admitted credential");
  return {
    isNetworkEnabled: (network) => !disabledNetworks?.has(network),
    async readJson<T>(network: DwellirNativeNetwork, path: string, signal: AbortSignal,
      ctx?: AdapterContext, body?: unknown, timeoutMs = 10_000): Promise<T> {
      if (disabledNetworks?.has(network)) throw new Error(`Dwellir native routing disabled for ${network}`);
      const endpoint = DWELLIR_NATIVE_ENDPOINTS.find((entry) => entry.network === network)!;
      const isMoveRead = endpoint.protocol === "aptos-rest" && body === undefined && (
        path === "" || /^\/blocks\/by_version\/[0-9]+\?with_transactions=false$/.test(path) ||
        /^\/accounts\/0x[0-9a-fA-F]{1,64}\/resource\/[0-9a-zA-Z_:]+\?ledger_version=[0-9]+$/.test(path)
      );
      const isTronRead = endpoint.protocol === "tron-http" && (
        (path === endpoint.allowedPath && body !== undefined)
        || (path === endpoint.jsonRpcPath && isTronJsonRpcRead(body))
        || (path === endpoint.solidHeadPath && body != null && typeof body === "object"
          && !Array.isArray(body) && Object.keys(body).length === 0)
      );
      const isStarknetRead = endpoint.protocol === "starknet-jsonrpc" && path === "" &&
        body !== null && typeof body === "object" && "method" in body && body.method === endpoint.allowedMethod;
      if (!isMoveRead && !isTronRead && !isStarknetRead) {
        throw new Error("Dwellir native read is outside the admitted state-read surface");
      }
      const url = `${endpoint.baseUrl}${path}`;
      const options = {
        headers: { "X-Api-Key": apiKey },
        // Workers has no redirect: "error"; manual keeps the credential on
        // this origin while the request helpers reject non-2xx responses.
        redirect: "manual" as const,
        maxResponseBytes: network === "tron" ? tronRpcResponseByteLimit(path, body) : 128 * 1024,
        maxRetries: 0,
        onResponse: () => recordDwellirCredits(1),
      };
      try {
        const result = body === undefined
          ? await fetchJsonWithRetry<T>(url, signal, timeoutMs, ctx, options)
          : await fetchJsonPostWithRetry<T>(url, body, signal, timeoutMs, ctx, options);
        // Keep the reader's RPC-error parser, but redact any credential echoed
        // by the provider before that parser constructs a diagnostic.
        if ((network === "starknet" || network === "tron") && result !== null && typeof result === "object" && "error" in result) {
          const rpcError = result.error;
          if (rpcError !== null && typeof rpcError === "object" && "message" in rpcError &&
              typeof rpcError.message === "string") {
            rpcError.message = rpcError.message.split(apiKey).join("[redacted]");
          }
        }
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (isResponseBodyTooLargeError(error)) throw error;
        // A provider's malformed JSON/error body must not echo a credential.
        throw new Error(toErrorMessage(error).split(apiKey).join("[redacted]"));
      }
    },
  };
}
