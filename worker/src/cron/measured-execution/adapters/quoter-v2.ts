import {
  DEX_EXACT_QUOTE_ADAPTER_IDS,
  projectDexMeasuredExecutionProfileToV2,
  type DexExecutionProfileV2,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  getDexMeasuredExecutionDeployment,
  type DexMeasuredExecutionDeployment,
} from "../registry";

export function resolveQuoterV2AdapterDeployment(
  target: DexMeasuredExecutionTarget,
): DexMeasuredExecutionDeployment | null {
  return getDexMeasuredExecutionDeployment(target.adapterProfileId, target.chain);
}

export function projectQuoterV2ProfileToV2(
  profile: DexMeasuredExecutionProfile,
): DexExecutionProfileV2 | null {
  const projected = projectDexMeasuredExecutionProfileToV2(profile);
  return projected.adapterId === DEX_EXACT_QUOTE_ADAPTER_IDS.quoterV2
    ? projected
    : null;
}
