import {
  CRON_GROUPS,
  getCronJobMeta,
  type CronGroupDefinition,
  type CronGroupKey,
  type CronTriggerMode,
} from "@shared/lib/cron-jobs";

export type StatusCronGroupKey = CronGroupKey;

export type StatusCronGroupDefinition = CronGroupDefinition;

export interface StatusCronDisplayMeta {
  group: StatusCronGroupKey;
  label: string;
  schedule: string | null;
  triggerMode: CronTriggerMode | null;
}

export const STATUS_CRON_GROUPS: readonly StatusCronGroupDefinition[] = CRON_GROUPS;

export function getStatusCronDisplay(job: string): StatusCronDisplayMeta {
  const definition = getCronJobMeta(job);
  if (!definition) {
    return {
      group: "other",
      label: job,
      schedule: null,
      triggerMode: null,
    };
  }

  return {
    group: definition.group,
    label: definition.label,
    schedule: definition.schedule,
    triggerMode: definition.triggerMode,
  };
}
