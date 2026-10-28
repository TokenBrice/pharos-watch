import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonRpcTransportOutcome } from "./evm-rpc";

export type NativeRpcOutcome =
  | { status: "success" | "failure" | "neutral"; reason: string }
  | { status: "rpc-error"; error: { code?: number; message?: string } };

export interface RpcRequestObserver {
  beforeRequest: (url: string) => boolean;
  onOutcome: (url: string, outcome: JsonRpcTransportOutcome) => void;
  onNativeOutcome?: (provider: "dwellir" | "trongrid", outcome: NativeRpcOutcome) => void;
}

// Scope follows only the awaited producer, including its nested RPC helpers.
const rpcRequestObserver = new AsyncLocalStorage<RpcRequestObserver>();

export function withRpcRequestObserver<T>(observer: RpcRequestObserver, run: () => Promise<T>): Promise<T> {
  return rpcRequestObserver.run(observer, run);
}

export function getRpcRequestObserver(): RpcRequestObserver | undefined {
  return rpcRequestObserver.getStore();
}
