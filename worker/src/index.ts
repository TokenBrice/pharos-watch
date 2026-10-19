import type { Env } from "./lib/env";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { handleHttpRequestImpl } = await import("./handlers/http/request-dispatch");
    return handleHttpRequestImpl(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const eventEntryMs = Date.now();
    const [{ handleScheduledEvent }, { PUBLIC_SLOT_RUNNER_LOADERS }] = await Promise.all([
      import("./handlers/scheduled"),
      import("./handlers/scheduled/public-runners"),
    ]);
    return handleScheduledEvent(event, env, ctx, "public", PUBLIC_SLOT_RUNNER_LOADERS, eventEntryMs);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const eventEntryMs = Date.now();
    // Keep the reserve/consumer graph out of HTTP and unrelated scheduled events.
    const { handleReserveContinuationBatch } = await import("./handlers/reserve-continuation");
    return handleReserveContinuationBatch(batch, env, ctx, eventEntryMs);
  },
};

export default worker;
