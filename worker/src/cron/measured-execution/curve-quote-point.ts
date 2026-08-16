import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import type { DexMeasuredRawQuotePoint } from "./profiles";
import { materializeEvmQuotePoint } from "./evm-quote-plan";

interface CurveMeasuredQuoteToken {
  decimals: number;
  referencePriceUsd: number;
}

interface CurveMeasuredQuoteRequest {
  amountInRaw: bigint;
  callData: string;
  inputIndex: number;
  outputIndex: number;
  blockNumber: number;
  endpointAddress: string;
  target: {
    tokenIn: CurveMeasuredQuoteToken;
    tokenOut: CurveMeasuredQuoteToken;
  };
}

export function decodeCurveMeasuredRawQuotePoint<TFailure extends string>(input: {
  request: CurveMeasuredQuoteRequest;
  result: EvmMulticall3Result;
  decodeAmountOutRaw: (returnData: `0x${string}`) => bigint | null;
  adapterMetadata: Record<string, string | number | boolean>;
  failureReasons: {
    poolRevert: TFailure;
    malformedPoolReturn: TFailure;
  };
}): { point?: DexMeasuredRawQuotePoint; failureReason?: TFailure } {
  const { request, result, decodeAmountOutRaw, adapterMetadata, failureReasons } = input;
  if (!result.success) return { failureReason: failureReasons.poolRevert };
  const amountOutRaw = decodeAmountOutRaw(result.returnData);
  if (amountOutRaw == null) return { failureReason: failureReasons.malformedPoolReturn };
  const point = materializeEvmQuotePoint({
    amountInRaw: request.amountInRaw,
    amountOutRaw,
    callData: request.callData,
    returnData: result.returnData,
    tokenIn: request.target.tokenIn,
    tokenOut: request.target.tokenOut,
    adapterMetadata,
  });
  return point ? { point } : { failureReason: failureReasons.malformedPoolReturn };
}
