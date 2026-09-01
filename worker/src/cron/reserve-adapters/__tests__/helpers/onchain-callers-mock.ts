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

export function makeOnchainMulticall3Mock(options: {
  uint256: OnchainCallMock;
  raw: OnchainCallMock;
}) {
  return vi.fn(async (input: OnchainCallOptions & {
    calls: Array<{ label: string; contract: string; data: string }>;
    [key: string]: unknown;
  }) => Promise.all(input.calls.map(async (call) => {
    const request: OnchainCallRequest = { ...input, ...call };
    const value = call.data === "0xfeaf968c"
      ? await options.raw(request)
      : await options.uint256(request);
    return {
      label: call.label,
      success: value != null,
      returnData: typeof value === "bigint"
        ? `0x${value.toString(16).padStart(64, "0")}`
        : value ?? "0x",
    };
  })));
}

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
