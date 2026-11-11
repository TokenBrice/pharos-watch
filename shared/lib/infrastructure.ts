import type { Infrastructure } from "../types/stablecoin-taxonomy";
import { INFRASTRUCTURE_LABELS } from "./classification/domain";

export function getInfrastructureLabel(value: Infrastructure): string {
  return INFRASTRUCTURE_LABELS[value];
}
