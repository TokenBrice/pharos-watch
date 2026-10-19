import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
  EvmRpcOptions,
  EvmBlockHeader,
} from "../../lib/evm-rpc";
import type { ExecutableRedemptionObserverId } from "@shared/types/redemption";
import type { LiveReserveRedemptionTelemetryKnownFields } from "@shared/types/live-reserves";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { EvmCodeIdentityError } from "../../lib/evm-code-identity-error";
import { codeIdentityChecks, executeEvmObservationPlan } from "./evm-observation-plan";
import type {
  AnyEvmObservationField,
  EvmCodeIdentity,
  EvmObservationSnapshot,
} from "./evm-observation-plan";

type Hex = `0x${string}`;

export interface ExecutableRedemptionReadClient {
  blockNumber(options: EvmRpcOptions): Promise<number | null>;
  blockTimestamp(blockNumber: number, options: EvmRpcOptions): Promise<number | null>;
  blockHeader?(blockNumber: number, options: EvmRpcOptions): Promise<EvmBlockHeader | null>;
  codeHash(address: string, blockNumber: number, options: EvmRpcOptions): Promise<string | null>;
  storage(
    address: string,
    position: string,
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<Hex | null>;
  multicall(
    calls: readonly EvmMulticall3Call[],
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<EvmMulticall3Result[] | null>;
}

type ObserverWireFields = Required<Pick<LiveReserveRedemptionTelemetryKnownFields,
  "routeStatus" | "routeStatusReason" | "holderEligibility" |
  "blockNumber" | "sourceTimestamp" | "sourceUrls" | "outputAssetKeys"
>>;

export interface ExecutableRedemptionObservation extends ObserverWireFields {
  capacityRaw: bigint;
  capacitySource: string;
  /** A placeholder zero is never a measured zero. */
  capacityState: "measured" | "closed" | "unquantified";
  settlementBoundUnproven?: LiveReserveRedemptionTelemetryKnownFields["settlementBoundUnproven"];
  settlementDelaySec?: LiveReserveRedemptionTelemetryKnownFields["settlementDelaySec"];
  underlyingDecimals: number;
  capacityKind: Extract<NonNullable<LiveReserveRedemptionTelemetryKnownFields["capacityKind"]>, "live-direct-bounded">;
  /** Explicit execution cost proof; protocol fee alone does not include gas. */
  allInFeeBps?: NonNullable<LiveReserveRedemptionTelemetryKnownFields["feeBps"]> | null;
  freshnessKind: Extract<NonNullable<LiveReserveRedemptionTelemetryKnownFields["freshnessKind"]>, "same-run-onchain">;
  routeStatusSource: Extract<NonNullable<LiveReserveRedemptionTelemetryKnownFields["routeStatusSource"]>, "onchain">;
  feeBps: NonNullable<LiveReserveRedemptionTelemetryKnownFields["feeBps"]> | null;
  diagnostics: Record<string, unknown>;
}

export interface ExecutableRedemptionObserverDescriptor {
  observerId: ExecutableRedemptionObserverId;
  coinId: string;
  chain: string;
  inputContract: string;
  outputAssetKeys: readonly string[];
  capacityCapability: "diagnostic-only" | "measured";
  /** Reserve adapters retain their own lane and must not trigger duplicate direct reads. */
  sourceLane: "reserve-backed" | "direct";
  observe(
    blockNumber: number, blockTimestamp: number, rpcOptions: EvmRpcOptions,
    client: ExecutableRedemptionReadClient, ctx: AdapterContext | undefined, signal: AbortSignal,
  ): Promise<ExecutableRedemptionObservation>;
}

export interface ObserverOptions {
  client?: ExecutableRedemptionReadClient;
  nowSec?: number;
  extraRpcUrls?: string[];
  rpcOptions?: EvmRpcOptions;
}

export function fail(coinId: string, reason: string): never {
  throw new Error(`${coinId} executable redemption observer failed closed: ${reason}`);
}

export async function readStateWithPlan<Fields extends readonly AnyEvmObservationField[]>(
  coinId: string,
  stateLabel: string,
  fields: Fields,
  identities: readonly EvmCodeIdentity[],
  blockNumber: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<EvmObservationSnapshot<Fields>> {
  // Pass the caller's exact options through both identity and quantity reads.
  // A numbered/header pin alone must never be relabeled finalized here.
  const identityResult = await codeIdentityChecks(client, identities, {
    blockNumber,
    rpcOptions,
    readCode: (readClient, address, readBlock, readOptions) =>
      readClient.codeHash(address, readBlock, readOptions),
    readStorage: (readClient, address, position, readBlock, readOptions) =>
      readClient.storage(address, position, readBlock, readOptions),
    run: (label, factory) => runAdapterIo(ctx, label, factory, { signal }),
    codeLabel: (identity, kind) =>
      `${coinId}-redemption-code-${kind === "implementation" ? identity.implementationAddress : identity.address}`,
    storageLabel: (identity) => `${coinId}-redemption-implementation-${identity.address}`,
  });
  if (identityResult.status === "rejected") {
    throw new EvmCodeIdentityError(coinId, identityResult, blockNumber);
  }

  return executeEvmObservationPlan({
    adapterKey: coinId,
    fields,
    onFailure: (label) => fail(coinId, `${label} unavailable`),
    onDecodeError: (error) => {
      throw error;
    },
    read: (calls) => runAdapterIo(
      ctx,
      stateLabel,
      async () => {
        const results = await client.multicall(
          calls.map(({ label, contract, data, allowFailure }) => ({
            label,
            target: contract,
            callData: data,
            ...(allowFailure != null ? { allowFailure } : {}),
          })),
          blockNumber,
          rpcOptions,
        );
        if (!results) fail(coinId, "route state unavailable");
        return results;
      },
      { signal },
    ),
  });
}
