import { vi } from "vitest";
import type { ChainRpcConfig } from "../../../../lib/chain-registry";

const rpcMocks = vi.hoisted(() => ({
  getChainRpcMock: vi.fn(),
  fetchWithRetryMock: vi.fn(),
}));

export const { getChainRpcMock, fetchWithRetryMock } = rpcMocks;

vi.mock("../../../../lib/chain-registry", () => ({
  getChainRpc: getChainRpcMock,
  getAlchemyAuthHeaders: () => undefined,
}));

vi.mock("../../../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
  fetchJsonWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args);
    if (!response) return null;
    return { response, body: await response.json() };
  },
  fetchTextWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args);
    if (!response) return null;
    return { response, body: await response.text() };
  },
}));

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

export function resetRpcMocks(): void {
  vi.clearAllMocks();
  getChainRpcMock.mockImplementation((_chainRpcs: Map<string, unknown>, chainId: string) => testChainRpcs.get(chainId));
}
