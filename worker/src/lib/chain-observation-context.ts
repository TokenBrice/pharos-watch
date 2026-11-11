import type { ChainRpcConfig } from "./chain-registry";
import type { DwellirNativeCapability } from "./dwellir-native";
import type { JsonRequestExecutor } from "./json-request";

export interface ChainObservationContext {
  chainRpcs?: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  jsonRequestExecutor: JsonRequestExecutor;
}

export type ChainObservationOptions = Omit<ChainObservationContext, "jsonRequestExecutor"> & {
  jsonRequestExecutor?: JsonRequestExecutor;
};

export function getChainObservationRequests(ctx: ChainObservationContext): JsonRequestExecutor {
  return ctx.jsonRequestExecutor;
}
