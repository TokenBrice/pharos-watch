import { handleHttpRequest } from "./handlers/http";
import { handleScheduledEvent } from "./handlers/scheduled";
import type { Env } from "./lib/env";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleScheduledEvent(event, env, ctx);
  },
};

export default worker;
