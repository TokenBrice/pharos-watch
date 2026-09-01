import {
  DEX_EXACT_QUOTE_ADAPTER_IDS,
  projectDexMeasuredExecutionProfileToV2,
  type DexExecutionProfileV2,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { getUniswapV4Deployment, type UniswapV4Deployment } from "../uniswap-v4";

export function resolveUniswapV4AdapterDeployment(
  target: DexMeasuredExecutionTarget,
): UniswapV4Deployment | null {
  return getUniswapV4Deployment(target.chain);
}

export function projectUniswapV4ProfileToV2(
  profile: DexMeasuredExecutionProfile,
): DexExecutionProfileV2 | null {
  const projected = projectDexMeasuredExecutionProfileToV2(profile);
  return projected.adapterId === DEX_EXACT_QUOTE_ADAPTER_IDS.uniswapV4
    ? projected
    : null;
}
