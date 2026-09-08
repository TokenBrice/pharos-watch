import { vi } from "vitest";
import type { ChainRpcConfig } from "../../../../lib/chain-registry";
import type * as FetchRetry from "../../../../lib/fetch-retry";
import { throwIfAborted } from "../../../../lib/abort";
import { readResponseJsonWithinLimitWithSignal, readResponseTextWithinLimitWithSignal } from "../../../../lib/response-body";

const rpcMocks = vi.hoisted(() => ({
  getChainRpcMock: vi.fn(),
  fetchWithRetryMock: vi.fn(),
}));

export const { getChainRpcMock, fetchWithRetryMock } = rpcMocks;

vi.mock("../../../../lib/chain-registry", () => ({
  getChainRpc: getChainRpcMock,
  getAlchemyAuthHeaders: () => undefined,
}));

vi.mock("../../../../lib/fetch-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof FetchRetry>();
  // The transport seam represents an exhausted retry operation; use the real
  // bounded body readers, without introducing another parser or retry loop.
  const readBody = async (
    reader: (response: Response, maxBytes: number, signal?: AbortSignal) => Promise<unknown>,
    ...args: Parameters<typeof actual.fetchTextWithRetry>
  ) => {
    const signal = args[1]?.signal ?? undefined;
    const options = args[3];
    const maxBytes = options?.maxResponseBytes ?? actual.DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError(`maxResponseBytes must be a non-negative safe integer; received ${maxBytes}`);
    }
    throwIfAborted(signal);
    try {
      const response = await fetchWithRetryMock(...args);
      if (!response) return null;
      return { response, body: await reader(response, maxBytes, signal) };
    } catch (error) {
      if (signal?.aborted || options?.throwOnFinalNetworkError) throw error;
      return null;
    }
  };
  return {
    ...actual,
    fetchWithRetry: fetchWithRetryMock,
    fetchJsonWithRetry: (...args: Parameters<typeof actual.fetchJsonWithRetry>) =>
      readBody(readResponseJsonWithinLimitWithSignal, ...args),
    fetchTextWithRetry: (...args: Parameters<typeof actual.fetchTextWithRetry>) =>
      readBody(readResponseTextWithinLimitWithSignal, ...args),
  };
});

export const testChainRpcs = new Map<string, ChainRpcConfig>([
  [
    "ethereum",
    {
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example",
      explorerUrl: "https://etherscan.io",
    },
  ],
]);
const baselineChainRpcs = structuredClone(testChainRpcs);

export function resetRpcMocks(): void {
  vi.clearAllMocks();
  getChainRpcMock.mockReset();
  fetchWithRetryMock.mockReset();
  testChainRpcs.clear();
  for (const [chainId, config] of baselineChainRpcs) {
    testChainRpcs.set(chainId, structuredClone(config));
  }
  getChainRpcMock.mockImplementation((_chainRpcs: Map<string, unknown>, chainId: string) => testChainRpcs.get(chainId));
}
