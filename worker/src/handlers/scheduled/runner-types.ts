import type { ScheduledRuntimeContext } from "./context";
import type { ScheduledSlotSummary } from "./slot-summary";

export type SlotRunner = (runtime: ScheduledRuntimeContext) =>
  Promise<ScheduledSlotSummary | void> | ScheduledSlotSummary | void;
export type SlotRunnerLoader = () => Promise<SlotRunner>;
