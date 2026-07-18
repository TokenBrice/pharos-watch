import type { Env } from "./lib/env";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { handleHttpRequestImpl } = await import("./handlers/http/request-dispatch");
    return handleHttpRequestImpl(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const { handleScheduledEvent } = await import("./handlers/scheduled");
    return handleScheduledEvent(event, env, ctx);
  },
};

export default worker;
