import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { getUniswapV4Deployment, type UniswapV4Deployment } from "../uniswap-v4";

export function resolveUniswapV4AdapterDeployment(
  target: DexMeasuredExecutionTarget,
): UniswapV4Deployment | null {
  return getUniswapV4Deployment(target.chain);
}
