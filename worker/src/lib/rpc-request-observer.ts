import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonRpcTransportOutcome } from "./evm-rpc";

export interface RpcRequestObserver {
  beforeRequest: (url: string) => boolean;
  onOutcome: (url: string, outcome: JsonRpcTransportOutcome) => void;
}

// Scope follows only the awaited producer, including its nested RPC helpers.
const rpcRequestObserver = new AsyncLocalStorage<RpcRequestObserver>();

export function withRpcRequestObserver<T>(observer: RpcRequestObserver, run: () => Promise<T>): Promise<T> {
  return rpcRequestObserver.run(observer, run);
}

export function getRpcRequestObserver(): RpcRequestObserver | undefined {
  return rpcRequestObserver.getStore();
}
