import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { ScheduledRuntimeContext } from "../context";
import type { ScheduledSlotSummary } from "../slot-summary";
import { SLOT_RUNNER_LOADER_BY_KEY } from "../../scheduled";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

/**
 * Dispatch contract for every slot in the registry: a slot leases the jobs its
 * plan declares, in the order each chain declares them, and reports each one.
 * The recorder never invokes a job body — each job's behaviour belongs to its
 * own cron suite, and mocking 23 module graphs to re-assert the plan is what
 * made this directory 29 near-identical files.
 */

/** `sync-stablecoins` publishes this capability; the quarter-hourly slot skips its cache-dependent members without it. */
const CAPABLE_RESULT_METADATA = JSON.stringify({
  downstreamSafe: true,
  capabilities: { stablecoinsCache: true, depegPipeline: true },
});

/**
 * Slots whose member set is decided from stored state this recorder does not
 * seed. Their gating is owned by the named suite; here they still may not
 * lease a job their plan does not declare.
 */
const RUN_TIME_GATED_SLOTS: Partial<Record<CronScheduleKey, string>> = {
  fiveMinuteTelegramAlerts: "dispatch lanes gate on circuit state and stored pending work (five-minute-telegram.test.ts)",
  digestTriggerPoll: "digest jobs run only for trigger requests stored by an earlier slot (digest-trigger-poll.test.ts)",
  fourHourlyReserveSync: "children resume only once the reserve queue checkpoint is exhausted (hourly-live-reserves.test.ts)",
};

const fixtures = createLatestSchemaFixtureTracker();

async function runSlot(scheduleKey: CronScheduleKey): Promise<{
  leased: string[];
  summary: ScheduledSlotSummary | undefined;
}> {
  const plan = SCHEDULED_SLOT_PLANS[scheduleKey];
  const leased: string[] = [];
  const runtime = makeScheduledRuntime({
    db: fixtures.open().db,
    scheduleKey,
    cron: plan.triggerSchedules[0],
    runLeasedCron: vi.fn(async (job: string) => {
      leased.push(job);
      return { status: "ok" as const, itemCount: 1, metadata: CAPABLE_RESULT_METADATA };
    }) as ScheduledRuntimeContext["runLeasedCron"],
  });
  const runner = await SLOT_RUNNER_LOADER_BY_KEY[plan.runnerKey]();
  const summary = (await runner(runtime)) ?? undefined;
  return { leased, summary };
}

describe("scheduled slot registry", () => {
  afterEach(() => {
    fixtures.closeAll();
  });

  it.each(Object.keys(SCHEDULED_SLOT_PLANS) as CronScheduleKey[])(
    "%s leases the jobs its registry plan declares, in chain order",
    // Each row imports a slot runner's real module graph.
    { timeout: 60_000 },
    async (scheduleKey) => {
      const plan = SCHEDULED_SLOT_PLANS[scheduleKey];
      const { leased, summary } = await runSlot(scheduleKey);
      const gatedReason = RUN_TIME_GATED_SLOTS[scheduleKey];

      for (const chain of plan.jobChains) {
        const expected = gatedReason ? chain.filter((job) => leased.includes(job)) : chain;
        expect(
          leased.filter((job) => chain.includes(job)),
          gatedReason ?? `${scheduleKey} must lease its chain in order`,
        ).toEqual(expected);
      }

      const planned = plan.jobChains.flat();
      expect(leased.filter((job) => !planned.includes(job))).toEqual([]);
      expect(summary?.jobs.map((job) => job.job)).toEqual(expect.arrayContaining(leased));
      const plannedOutcomes = (summary?.jobs ?? []).filter((job) => planned.includes(job.job));
      expect(plannedOutcomes.filter((job) => job.outcome === "error")).toEqual([]);
    },
  );
});
