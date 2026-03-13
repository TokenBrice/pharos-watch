import {
  getCronJobMeta,
  type CronGroupKey,
  type CronTriggerMode,
} from "@shared/lib/cron-jobs";

export interface StatusCronDisplayMeta {
  group: CronGroupKey;
  label: string;
  schedule: string | null;
  triggerMode: CronTriggerMode | null;
}

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
