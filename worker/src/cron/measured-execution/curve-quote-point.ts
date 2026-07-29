import { DEX_MEASURED_MAX_COST_BPS } from "@shared/types/measured-execution";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import type { DexMeasuredRawQuotePoint } from "./profiles";
import { rawAmountToUsdOrNull as rawAmountToUsd } from "./fixed-point";

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
  const inputUsd = rawAmountToUsd(
    request.amountInRaw,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  const outputUsd = rawAmountToUsd(
    amountOutRaw,
    request.target.tokenOut.decimals,
    request.target.tokenOut.referencePriceUsd,
  );
  if (inputUsd == null || inputUsd <= 0 || outputUsd == null) {
    return { failureReason: failureReasons.malformedPoolReturn };
  }
  const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
  return {
    point: {
      amountInRaw: request.amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: request.callData,
      returnData: result.returnData.toLowerCase() as `0x${string}`,
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
      adapterMetadata,
    },
  };
}
