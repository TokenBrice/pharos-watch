import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../lib/env";

export class SafetyScoreV9PublicationWorkflow extends WorkflowEntrypoint<
  Env,
  unknown
> {
  async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const { runSafetyScoreV9PublicationWorkflow } = await import(
      "./safety-score-v9-publication"
    );
    return runSafetyScoreV9PublicationWorkflow(this.env, event, step);
  }
}
