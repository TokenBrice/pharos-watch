import { vi } from "vitest";

type OnchainCallInput = {
  chain?: string;
  rpcMode?: unknown;
};

type OnchainCallOptions = {
  signal: AbortSignal;
  ctx?: unknown;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs?: number;
};

type OnchainCallRequest = OnchainCallOptions & {
  contract: string;
  data: string;
  rpcMode?: unknown;
  chain?: string;
};

type OnchainCallMock = (request: OnchainCallRequest) => unknown;

export function makeOnchainCallersMock(options: {
  uint256?: OnchainCallMock;
  raw?: OnchainCallMock;
} = {}) {
  const { uint256, raw } = options;
  return vi.fn((input: OnchainCallInput, callOptions: OnchainCallOptions) => ({
    uint256: uint256
      ? (contract: string, data: string) =>
          uint256({
            ...callOptions,
            contract,
            data,
            rpcMode: input.rpcMode,
            chain: input.chain,
          })
      : vi.fn(),
    raw: raw
      ? (contract: string, data: string) =>
          raw({
            ...callOptions,
            contract,
            data,
            rpcMode: input.rpcMode,
            chain: input.chain,
          })
      : vi.fn(),
  }));
}
