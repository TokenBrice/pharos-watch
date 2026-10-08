import { makeIdempotentAdminRoute, type AdminRouteContext } from "../../lib/route-wrappers";
import { jsonResponse, errorResponse } from "../../lib/api-response";
import { readRequestTextBounded } from "../../lib/api-json-body";
import { bootstrapJltxxReserves } from "../../cron/bootstrap-jltxx-reserves";
import { createLeaseOwner, runCronWithLease } from "../../lib/cron-lease-primitives";
import { logCronRun } from "../../lib/cron-logger";
import { resolveCronTimeoutBudget } from "../../lib/cron-timeouts";
import { ScheduledFetchBudget } from "../../lib/scheduled-fetch-budget";
import { getScheduledTaskDescriptor } from "@shared/lib/scheduled-runner-registry";
import type { ChainRpcRouteFields } from "../../routes/shared";
import type { ProducerIdentity } from "../../lib/producer-history";

export const handleBootstrapJltxxReserves = makeIdempotentAdminRoute(
  "route-bootstrap-jltxx-reserves",
  "bootstrap-jltxx-reserves",
  async ({ db, request, chainRpcs }: AdminRouteContext & ChainRpcRouteFields) => {
    if (request.method !== "POST") return errorResponse(405, "JLTXX bootstrap requires POST");
    if (!request.headers.get("Idempotency-Key")?.trim()) return errorResponse(400, "Idempotency-Key is required for staged reserve capture");
    if (new URL(request.url).search) return errorResponse(400, "Bootstrap accepts no query overrides");
    const body = await readRequestTextBounded(request, 1024);
    if (body instanceof Response) return body;
    if (body.trim()) return errorResponse(400, "Bootstrap accepts no body, coin, config, RPC or admission overrides");
    const job = "sync-live-reserves";
    const descriptor = getScheduledTaskDescriptor("fourHourlyReserveSync", job);
    const timeoutBudget = resolveCronTimeoutBudget(job);
    const owner = createLeaseOwner("manual:bootstrap-jltxx-reserves");
    const producer: ProducerIdentity = {
      scheduleKey: "fourHourlyReserveSync", job, producerPath: "bootstrap-jltxx-reserves", producerKind: "admin-trigger",
      invocationId: owner, workerVersion: null, slotStartedAt: Math.floor(Date.now() / 1000), calendarPeriod: null,
    };
    const result = await new ScheduledFetchBudget().run(descriptor.maxConnections, request.signal, () =>
      logCronRun(db, job, async (signal, reportProgress) => {
        const lease = await runCronWithLease(db, job, async ({ signal: leaseSignal }) => {
          await reportProgress({ stage: "staged-jltxx-capture", leaseOwner: owner });
          const packet = await bootstrapJltxxReserves(db, chainRpcs, leaseSignal);
          return { status: packet.evidenceCaptured ? "ok" as const : "degraded" as const, itemCount: packet.evidenceCaptured ? 1 : 0, metadata: JSON.stringify(packet) };
        }, { owner, abortSignal: signal, timeoutBudget });
        if (lease.status !== "ok") return { status: lease.status, metadata: JSON.stringify({ reason: "lease-locked", admissionAllowed: false }) };
        return lease.result ?? { status: "degraded" as const, metadata: JSON.stringify({ reason: "staged-capture-unavailable", admissionAllowed: false }) };
      }, { timeoutBudget, abortSignal: request.signal, producer }),
    );
    const status = result?.status ?? "degraded";
    return jsonResponse({
      ok: status === "ok", status, admissionAllowed: false, runtimePriceMarketcapPass: false,
      itemCount: result?.itemCount ?? null, metadata: result?.metadata ?? null,
    }, { status: status === "skipped_locked" || status === "skipped_neutral" ? 409 : status === "ok" ? 200 : 503, noStore: true });
  },
);
