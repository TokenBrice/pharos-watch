import {
  TELEGRAM_RECAP_MAX_RECIPIENTS_PER_RUN,
  TELEGRAM_RECAP_PENDING_PRIORITY,
  TELEGRAM_RECAP_TTL_SEC,
} from "@shared/lib/telegram-recap-policy";
import {
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_LOAD_GUARD_ASSUMPTIONS,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_PENDING_PRIORITY,
} from "@shared/lib/telegram-delivery-policy";

export type TelegramRecapLoadScenarioId =
  | "recap-all-due"
  | "recap-plus-risk-burst"
  | "recap-plus-429-storm"
  | "recap-preset-heavy"
  | "recap-global-scope"
  | "recap-no-change"
  | "recap-stale-tape";

export interface TelegramRecapLoadScenarioResult {
  targetRecipients: number;
  scenarioId: TelegramRecapLoadScenarioId;
  scenarioLabel: string;
  dueRecipients: number;
  pendingEnqueued: number;
  scheduleAdvancements: number;
  plannerRuns: number;
  pendingDrainRuns: number;
  riskChunksAhead: number;
  outageUnavailableSeconds: number;
  estimatedCompletionSeconds: number;
  ttlSeconds: number;
  ttlMarginSeconds: number;
  ttlMarginFraction: number;
  peakPlannerCpuMs: number;
  peakDispatchCpuMs: number;
  priorityPreserved: boolean;
  aiCalls: 0;
  externalPlanningFetches: 0;
  exploratory: boolean;
}

const RECAP_PLANNER_CPU_MS_PER_RECIPIENT = 5;
const RECAP_PRESET_CPU_MULTIPLIER = 1.6;

function ceilRuns(items: number, capacity: number): number {
  return items <= 0 ? 0 : Math.ceil(items / capacity);
}

function buildRecapScenario(input: {
  targetRecipients: number;
  scenarioId: TelegramRecapLoadScenarioId;
  scenarioLabel: string;
  pendingEnqueued: number;
  scheduleAdvancements: number;
  riskChunksAhead?: number;
  outageUnavailableSeconds?: number;
  plannerCpuMultiplier?: number;
  staleGlobalGate?: boolean;
}): TelegramRecapLoadScenarioResult {
  const plannerRuns = input.staleGlobalGate
    ? 1
    : ceilRuns(input.targetRecipients, TELEGRAM_RECAP_MAX_RECIPIENTS_PER_RUN);
  const riskChunksAhead = input.riskChunksAhead ?? 0;
  const pendingDrainRuns = ceilRuns(riskChunksAhead + input.pendingEnqueued, TELEGRAM_PENDING_DRAIN_BUDGET);
  const planningSeconds = plannerRuns * TELEGRAM_DISPATCH_INTERVAL_SEC;
  const drainSeconds = pendingDrainRuns * TELEGRAM_DISPATCH_INTERVAL_SEC;
  // The planner is sequenced after dispatch. Summing the bounds is deliberately
  // conservative: production overlaps planning with earlier pending drains.
  const estimatedCompletionSeconds = planningSeconds + drainSeconds + (input.outageUnavailableSeconds ?? 0);
  const ttlMarginSeconds = TELEGRAM_RECAP_TTL_SEC - estimatedCompletionSeconds;
  const plannerRecipientsInPeakRun = input.staleGlobalGate
    ? 0
    : Math.min(input.targetRecipients, TELEGRAM_RECAP_MAX_RECIPIENTS_PER_RUN);
  const peakPlannerCpuMs = Math.ceil(
    plannerRecipientsInPeakRun * RECAP_PLANNER_CPU_MS_PER_RECIPIENT * (input.plannerCpuMultiplier ?? 1),
  );
  const peakDispatchCpuMs = Math.ceil(
    Math.min(input.pendingEnqueued, TELEGRAM_PENDING_DRAIN_BUDGET)
      * TELEGRAM_LOAD_GUARD_ASSUMPTIONS.sendCpuMsPerMessage,
  );

  return {
    targetRecipients: input.targetRecipients,
    scenarioId: input.scenarioId,
    scenarioLabel: input.scenarioLabel,
    dueRecipients: input.targetRecipients,
    pendingEnqueued: input.pendingEnqueued,
    scheduleAdvancements: input.scheduleAdvancements,
    plannerRuns,
    pendingDrainRuns,
    riskChunksAhead,
    outageUnavailableSeconds: input.outageUnavailableSeconds ?? 0,
    estimatedCompletionSeconds,
    ttlSeconds: TELEGRAM_RECAP_TTL_SEC,
    ttlMarginSeconds,
    ttlMarginFraction: ttlMarginSeconds / TELEGRAM_RECAP_TTL_SEC,
    peakPlannerCpuMs,
    peakDispatchCpuMs,
    priorityPreserved:
      TELEGRAM_RECAP_PENDING_PRIORITY > TELEGRAM_PENDING_PRIORITY.riskAlert
      && TELEGRAM_RECAP_PENDING_PRIORITY > TELEGRAM_PENDING_PRIORITY.adminBroadcast,
    aiCalls: 0,
    externalPlanningFetches: 0,
    exploratory: input.targetRecipients === TELEGRAM_LOAD_GUARD_ASSUMPTIONS.exploratoryTarget,
  };
}

export function simulateTelegramRecapLoadScenarios(
  targetRecipients: number,
  options: { riskBurstChunks?: number } = {},
): TelegramRecapLoadScenarioResult[] {
  const riskBurstChunks = Math.max(0, Math.floor(options.riskBurstChunks ?? targetRecipients));
  return [
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-all-due",
      scenarioLabel: "Personalized recap, all recipients due with material facts",
      pendingEnqueued: targetRecipients,
      scheduleAdvancements: targetRecipients,
    }),
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-plus-risk-burst",
      scenarioLabel: "Personalized recap behind a market-wide risk burst",
      pendingEnqueued: targetRecipients,
      scheduleAdvancements: targetRecipients,
      riskChunksAhead: riskBurstChunks,
    }),
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-plus-429-storm",
      scenarioLabel: "Personalized recap with a 15-minute Telegram 429 outage",
      pendingEnqueued: targetRecipients,
      scheduleAdvancements: targetRecipients,
      outageUnavailableSeconds: TELEGRAM_LOAD_GUARD_ASSUMPTIONS.telegram429StormSeconds,
    }),
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-preset-heavy",
      scenarioLabel: "Personalized recap with overlapping dynamic presets",
      pendingEnqueued: targetRecipients,
      scheduleAdvancements: targetRecipients,
      plannerCpuMultiplier: RECAP_PRESET_CPU_MULTIPLIER,
    }),
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-global-scope",
      scenarioLabel: "Personalized recap with global-family scope and capped facts",
      pendingEnqueued: targetRecipients,
      scheduleAdvancements: targetRecipients,
    }),
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-no-change",
      scenarioLabel: "Personalized recap with no material changes",
      pendingEnqueued: 0,
      scheduleAdvancements: targetRecipients,
    }),
    buildRecapScenario({
      targetRecipients,
      scenarioId: "recap-stale-tape",
      scenarioLabel: "Personalized recap blocked by stale Tape health",
      pendingEnqueued: 0,
      scheduleAdvancements: 0,
      staleGlobalGate: true,
    }),
  ];
}
