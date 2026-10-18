import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import type { SlotRunnerLoader } from "./runner-types";

// Compile-time import boundary, not a second schedule/ownership authority.
// Static runner imports would initialize compute/charts before admission and
// erase the measured cold-entry boundary; defer each registry-selected runner.
export const HEAVY_SLOT_RUNNER_LOADERS = {
  v9SupplyAttributionOffset: () =>
    import("./v9-supply-attribution").then((mod) => mod.runV9SupplyAttributionSlot),
  v9PublicationOffset: () =>
    import("./v9-publication").then((mod) => mod.runV9PublicationSlot),
  halfHourlyChartsOffset: () =>
    import("./half-hourly-charts").then((mod) => mod.runHalfHourlyChartsSlot),
} satisfies Partial<Record<CronScheduleKey, SlotRunnerLoader>>;
