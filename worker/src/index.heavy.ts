import type { HeavyEnv } from "./lib/env";

const worker = {
  async fetch(request: Request, env: HeavyEnv): Promise<Response> {
    // Lazy handler initialization keeps the scheduled-only heavy graphs cold
    // when serving the private service-binding canary (and vice versa).
    const { handlePlacedExecutorFetch } = await import("./handlers/scheduled/placed-executor");
    return handlePlacedExecutorFetch(request, env);
  },
  async scheduled(event: ScheduledEvent, env: HeavyEnv, ctx: ExecutionContext): Promise<void> {
    const eventEntryMs = Date.now();
    // Retain lazy entry initialization without reaching the public runner graph.
    const [{ handleScheduledEvent }, { HEAVY_SLOT_RUNNER_LOADERS }] = await Promise.all([
      import("./handlers/scheduled"),
      import("./handlers/scheduled/heavy-runners"),
    ]);
    return handleScheduledEvent(event, env, ctx, "heavy", HEAVY_SLOT_RUNNER_LOADERS, eventEntryMs);
  },
};

export default worker;
