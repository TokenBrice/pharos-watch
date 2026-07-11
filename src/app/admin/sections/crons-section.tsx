import type { StatusResponse } from "@shared/types";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { CronLaneTable } from "./cron-lane-table";
import type { CronGroup } from "./cron-lane-types";

export type { CronGroup } from "./cron-lane-types";

export interface CronsSectionProps {
  data: StatusResponse;
  runningCrons: number;
  cronGroups: CronGroup[];
}

export function CronsSection({ data, runningCrons, cronGroups }: CronsSectionProps) {
  return (
    <StatusSection
      id="crons"
      kicker="Schedulers"
      title="Cron Lanes"
      headingLevel="h1"
      variant="workspace"
      summary={
        <>
          <SummaryBadge label="Impacting" value={String(data.summary.availabilityImpactingUnhealthyCrons)} />
          <SummaryBadge label="Watch" value={String(data.summary.watchUnhealthyCrons)} />
          <SummaryBadge label="Degraded" value={String(data.summary.degradedCrons)} />
          <SummaryBadge label="Running" value={String(runningCrons)} />
        </>
      }
    >
      <CronLaneTable groups={cronGroups} budgetOnlySurfaces={data.budgetOnlySurfaces} nowSeconds={data.timestamp} />
    </StatusSection>
  );
}
