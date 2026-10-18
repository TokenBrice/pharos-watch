import type { Env } from "./lib/env";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { handleHttpRequestImpl } = await import("./handlers/http/request-dispatch");
    return handleHttpRequestImpl(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const [{ handleScheduledEvent }, { PUBLIC_SLOT_RUNNER_LOADERS }] = await Promise.all([
      import("./handlers/scheduled"),
      import("./handlers/scheduled/public-runners"),
    ]);
    return handleScheduledEvent(event, env, ctx, "public", PUBLIC_SLOT_RUNNER_LOADERS);
  },
};

export default worker;
