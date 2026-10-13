import type { StatusResponse } from "@shared/types";
import { StatusSection } from "@/components/status/page-primitives";
import { CronLaneTable } from "./cron-lane-table";
import type { CronGroup } from "./cron-lane-types";

export type { CronGroup } from "./cron-lane-types";

export interface CronsSectionProps {
  data: StatusResponse;
  cronGroups: CronGroup[];
}

/** Verdict counts live on the filter chips; the header carries no duplicate counters. */
export function CronsSection({ data, cronGroups }: CronsSectionProps) {
  return (
    <StatusSection
      id="crons"
      kicker="Schedulers"
      title="Crons"
      headingLevel="h1"
      variant="workspace"
    >
      <CronLaneTable
        groups={cronGroups}
        budgetOnlySurfaces={data.budgetOnlySurfaces}
        causes={data.causes.overall}
        nowSeconds={data.timestamp}
      />
    </StatusSection>
  );
}
