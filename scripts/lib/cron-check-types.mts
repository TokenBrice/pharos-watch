export interface CronJobDefinitionForCheck {
  job: string;
}

export interface CronGrowthTopologyPolicyForCheck {
  maxPhysicalTriggersBeforeRebalance: number;
}

export interface CronConnectionBudgetEntryForCheck {
  job: string;
  maxConnections: number;
  connectionGroup?: string;
  scheduleKey: string;
  statusTracked: boolean;
}

export interface CronConnectionBudgetConfigForCheck {
  maxPerTrigger: number;
  failAt: number;
  fullForNewFetchHeavyWorkAt: number;
}

export interface CronGrowthHeadroomPolicyForCheck {
  maxFetchCapableEntriesBeforeRebalance: number;
  maxHeadroomFullTriggersBeforeRebalance: number;
  queuesOrWorkflowsReview: {
    connectionPressureAt: number;
    fanoutPerRun: number;
    p95DurationMs: number;
  };
}

export interface ScheduledSlotPlanForCheck {
  schedule?: string;
  triggerSchedules?: readonly string[];
  jobChains: readonly (readonly string[])[];
  budgetOnlyJobs?: readonly string[];
}
