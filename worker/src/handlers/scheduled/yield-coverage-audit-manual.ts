import { makeIdempotentAdminRoute, type AdminRouteContext } from "../../lib/route-wrappers";
import { jsonResponse } from "../../lib/api-response";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { runYieldCoverageAudit } from "../../cron/yield-coverage-audit";
import { logCronRun } from "../../lib/cron-logger";
import { createLeaseOwner, runCronWithLease } from "../../lib/cron-lease-primitives";
import { resolveCronTimeoutBudget } from "../../lib/cron-timeouts";
import { normalizeCronMetadataWithLease } from "../../lib/cron-metadata";
import { ScheduledFetchBudget } from "../../lib/scheduled-fetch-budget";
import { utcCalendarMonth, type ProducerIdentity } from "../../lib/producer-history";
import { getScheduledTaskDescriptor } from "@shared/lib/scheduled-runner-registry";

interface TriggerYieldCoverageAuditContext extends AdminRouteContext {
  chainRpcs?: Map<string, ChainRpcConfig>;
}

export const handleTriggerYieldCoverageAudit = makeIdempotentAdminRoute(
  "route-trigger-yield-coverage-audit",
  "trigger-yield-coverage-audit",
  async ({ db, request, chainRpcs }: TriggerYieldCoverageAuditContext) => {
    const job = "yield-coverage-audit";
    const descriptor = getScheduledTaskDescriptor("monthlyYieldAudit", job);
    const timeoutBudget = resolveCronTimeoutBudget(job);
    const owner = createLeaseOwner(`manual:${job}`);
    const startedAtSec = Math.floor(Date.now() / 1000);
    const producer: ProducerIdentity = {
      scheduleKey: "monthlyYieldAudit",
      job,
      producerPath: descriptor.producerPath,
      producerKind: "admin-trigger",
      invocationId: owner,
      workerVersion: null,
      slotStartedAt: startedAtSec,
      calendarPeriod: utcCalendarMonth(startedAtSec),
    };
    // Keep the request open: waitUntil is capped at 30s after the response, and
    // signal cancellation must stop the recompute. The audit's own allocation
    // and lease also fence this run against the monthly slot.
    const result = await new ScheduledFetchBudget().run(descriptor.maxConnections, request.signal, () =>
      logCronRun(db, job, async (signal, reportProgress) => {
        const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
          await reportProgress({ stage: "lease-acquired", leaseOwner: owner });
          return runYieldCoverageAudit(db, leaseSignal, chainRpcs, reportProgress);
        }, { owner, abortSignal: signal, timeoutBudget });
        const leaseMeta = {
          leaseOwner: lease.leaseOwner,
          renewFailures: lease.renewFailures,
          leaseLost: lease.leaseLost ?? false,
          trigger: "manual",
        };
        if (lease.status === "skipped_locked") {
          return {
            status: "skipped_locked" as const,
            metadata: JSON.stringify({ reason: "lease-locked", ...leaseMeta }),
          };
        }
        const leaseResult = lease.result;
        if (!leaseResult) {
          return { metadata: JSON.stringify(leaseMeta) };
        }
        return { ...leaseResult, metadata: normalizeCronMetadataWithLease(leaseResult, leaseMeta) };
      }, { timeoutBudget, abortSignal: request.signal, producer }),
    );
    const status = result?.status ?? "ok";
    return jsonResponse(
      { ok: status === "ok", job, status, itemCount: result?.itemCount ?? null, metadata: result?.metadata ?? null },
      { status: status === "skipped_locked" ? 409 : status === "ok" ? 200 : 503, noStore: true },
    );
  },
);
