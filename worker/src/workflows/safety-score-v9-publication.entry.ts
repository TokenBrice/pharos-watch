import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { HeavyEnv } from "../lib/env";

export class SafetyScoreV9PublicationWorkflow extends WorkflowEntrypoint<
  HeavyEnv,
  unknown
> {
  async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    // Keep the evaluator graph out of the scheduled entry's initial isolate imports.
    const { runSafetyScoreV9PublicationWorkflow } = await import(
      "./safety-score-v9-publication"
    );
    return runSafetyScoreV9PublicationWorkflow(this.env, event, step);
  }
}
