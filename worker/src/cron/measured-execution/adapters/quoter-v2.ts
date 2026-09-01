import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import {
  getDexMeasuredExecutionDeployment,
  type DexMeasuredExecutionDeployment,
} from "../registry";

export function resolveQuoterV2AdapterDeployment(
  target: DexMeasuredExecutionTarget,
): DexMeasuredExecutionDeployment | null {
  return getDexMeasuredExecutionDeployment(target.adapterProfileId, target.chain);
}
