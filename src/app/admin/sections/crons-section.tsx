import type { StatusResponse } from "@shared/types";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";
import { CronLaneTable } from "./cron-lane-table";
import type { CronGroup } from "./cron-lane-types";

export type { CronGroup } from "./cron-lane-types";

export interface CronsSectionProps {
  data: StatusResponse;
  runningCrons: number;
  activeCronGroups: CronGroup[];
  healthyCronGroups: CronGroup[];
  isHealthyCronGroupsOpen: boolean;
  setIsHealthyCronGroupsOpen: (open: boolean) => void;
}

export function CronsSection({
  data,
  runningCrons,
  activeCronGroups,
  healthyCronGroups,
  isHealthyCronGroupsOpen,
  setIsHealthyCronGroupsOpen,
}: CronsSectionProps) {
  return (
    <StatusSection
      id="crons"
      kicker="Schedulers"
      title="Cron Lanes"
      accentClassName="border-l-orange-500"
      summary={
        <>
          <SummaryBadge label="Impacting" value={String(data.summary.availabilityImpactingUnhealthyCrons)} />
          <SummaryBadge label="Watch" value={String(data.summary.watchUnhealthyCrons)} />
          <SummaryBadge label="Degraded" value={String(data.summary.degradedCrons)} />
          <SummaryBadge label="Running" value={String(runningCrons)} />
        </>
      }
    >
      <div className="space-y-4">
        {activeCronGroups.length > 0 ? (
          <CronLaneTable
            groups={activeCronGroups}
            nowSeconds={data.timestamp}
            emptyLabel="No unhealthy cron lanes."
          />
        ) : (
          <div className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4 text-sm leading-relaxed text-muted-foreground">
            No unhealthy cron lanes. Healthy groups are collapsed below.
          </div>
        )}
        {healthyCronGroups.length > 0 ? (
          <details
            open={isHealthyCronGroupsOpen}
            onToggle={(event) => setIsHealthyCronGroupsOpen(event.currentTarget.open)}
            className="rounded-[1.25rem] border border-border/60 bg-background/30 p-4"
          >
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              Healthy lanes ({healthyCronGroups.length})
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {healthyCronGroups.reduce((sum, g) => sum + g.entries.length, 0)} jobs
              </span>
            </summary>
            <div className="mt-4 space-y-4">
              <CronLaneTable
                groups={healthyCronGroups}
                nowSeconds={data.timestamp}
                emptyLabel="No healthy lanes to show."
              />
            </div>
          </details>
        ) : null}
      </div>
    </StatusSection>
  );
}
