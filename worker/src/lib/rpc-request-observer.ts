import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonRpcTransportOutcome } from "./evm-rpc";

export interface RpcRequestScope {
  kind: "config" | "config-attempt" | "operation" | "chain-head";
  key: string;
  affectsRun: boolean;
  configKey?: string;
}

export interface RpcRequestObserver {
  beforeRequest: (url: string) => boolean;
  onOutcome: (url: string, outcome: JsonRpcTransportOutcome, scope?: RpcRequestScope) => void;
  onScopeComplete?: (scope: RpcRequestScope, failed: boolean) => void;
  onScopeStart?: (scope: RpcRequestScope) => void;
  scope?: RpcRequestScope;
}

// Scope follows only the awaited producer, including its nested RPC helpers.
const rpcRequestObserver = new AsyncLocalStorage<RpcRequestObserver>();

export function withRpcRequestObserver<T>(observer: RpcRequestObserver, run: () => Promise<T>): Promise<T> {
  return rpcRequestObserver.run(observer, run);
}

export function getRpcRequestObserver(): RpcRequestObserver | undefined {
  return rpcRequestObserver.getStore();
}

/** Requests are diagnostic until their logical config/head operation returns a terminal failure.
 * Thrown local work never certifies provider causality; callers retain ordinary exception handling.
 */
export async function withRpcRequestScope<T>(
  scope: RpcRequestScope, run: () => Promise<T>, failed: (result: T) => boolean,
): Promise<T> {
  const observer = getRpcRequestObserver();
  if (!observer?.onScopeComplete) return run();
  const effectiveScope = { ...scope, affectsRun: scope.affectsRun && observer.scope?.affectsRun !== false };
  observer.onScopeStart?.(effectiveScope);
  let requestNotStarted = false;
  const result = await withRpcRequestObserver({
    ...observer,
    scope: effectiveScope,
    beforeRequest: (url) => {
      const allowed = observer.beforeRequest(url);
      requestNotStarted ||= !allowed;
      return allowed;
    },
    onOutcome: (url, outcome, nestedScope) => {
      if (nestedScope == null || nestedScope.affectsRun) requestNotStarted ||= outcome.status === "control-error";
      observer.onOutcome(url, outcome, nestedScope ?? effectiveScope);
    },
  }, run);
  observer.onScopeComplete(effectiveScope, !requestNotStarted && failed(result));
  return result;
}

export function withRpcRequestOperation<T>(configKey: string, operation: string, run: () => Promise<T>, failed: (result: T) => boolean): Promise<T> {
  return withRpcRequestScope({ kind: "operation", key: `${configKey}:${operation}`, configKey, affectsRun: true }, run, failed);
}
