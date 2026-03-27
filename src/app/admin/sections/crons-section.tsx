import type { StatusResponse } from "@shared/types";
import { CronCard } from "@/components/status/cron-card";
import { StatusSection, SummaryBadge } from "@/components/status/page-primitives";

export interface CronGroup {
  key: string;
  title: string;
  badge: string;
  description: string;
  entries: [string, StatusResponse["crons"][string]][];
}

export interface CronsSectionProps {
  data: StatusResponse;
  runningCrons: number;
  activeCronGroups: CronGroup[];
  healthyCronGroups: CronGroup[];
  isHealthyCronGroupsOpen: boolean;
  setIsHealthyCronGroupsOpen: (open: boolean) => void;
}

function CronGroupCard({ group, nowSeconds }: { group: CronGroup; nowSeconds: number }) {
  return (
    <div key={group.key} className="rounded-[1.25rem] border border-border/60 bg-background/35 p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold tracking-tight text-foreground">{group.title}</h3>
          <span className="rounded-full border border-border/60 bg-background/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {group.badge}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{group.description}</p>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {group.entries.map(([job, cron]) => (
          <CronCard key={job} job={job} cron={cron} nowSeconds={nowSeconds} />
        ))}
      </div>
    </div>
  );
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
      title="Worker job lanes"
      description="Unhealthy and degraded lanes stay on top. Healthy lanes collapse until you need them."
      accentClassName="border-l-orange-500"
      summary={
        <>
          <SummaryBadge label="Unhealthy" value={String(data.summary.unhealthyCrons)} />
          <SummaryBadge label="Degraded" value={String(data.summary.degradedCrons)} />
          <SummaryBadge label="Running" value={String(runningCrons)} />
        </>
      }
    >
      <div className="space-y-4">
        {activeCronGroups.length > 0 ? (
          activeCronGroups.map((group) => (
            <CronGroupCard key={group.key} group={group} nowSeconds={data.timestamp} />
          ))
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
            </summary>
            <div className="mt-4 space-y-4">
              {healthyCronGroups.map((group) => (
                <CronGroupCard key={group.key} group={group} nowSeconds={data.timestamp} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </StatusSection>
  );
}
