import type { Infrastructure } from "../types";
import { INFRASTRUCTURE_LABELS } from "../types/core";

export function getInfrastructureLabel(value: Infrastructure): string {
  return INFRASTRUCTURE_LABELS[value];
}
