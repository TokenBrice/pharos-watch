import type { HeavyEnv } from "./lib/env";

export { SafetyScoreV9PublicationWorkflow } from "./workflows/safety-score-v9-publication.entry";

export default {
  async scheduled(event: ScheduledEvent, env: HeavyEnv, ctx: ExecutionContext): Promise<void> {
    // Preserve the public entry's lazy scheduled-graph boundary for isolate memory.
    const { handleScheduledEvent } = await import("./handlers/scheduled");
    return handleScheduledEvent(event, env, ctx, "heavy");
  },
};
