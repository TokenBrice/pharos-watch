import type { ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";

interface ExecutionFenceIdentity {
  readonly scheduleKey: string;
  readonly slotStartedAt: number;
  readonly invocationId: string;
  readonly owner: string;
  readonly generation: number;
  readonly workerRole: ScheduledWorkerRole;
}

export type ScheduledExecutionFence = ExecutionFenceIdentity & (
  | { readonly kind?: "scheduled"; readonly deliveryId?: never }
  | { readonly kind: "reserve-continuation"; readonly deliveryId: string }
);

