import type { HeavyEnv } from "./lib/env";

const worker = {
  async scheduled(event: ScheduledEvent, env: HeavyEnv, ctx: ExecutionContext): Promise<void> {
    // Preserve the public entry's lazy scheduled-graph boundary for isolate memory.
    const { handleScheduledEvent } = await import("./handlers/scheduled");
    return handleScheduledEvent(event, env, ctx, "heavy");
  },
};

export default worker;
