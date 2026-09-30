import { z } from "zod";

/** Explicit experiment assumptions, not parameters of the scoring policy.
 * Duration does not fabricate historical peg performance or a collateral haircut.
 * The one-hour (3,600 sec) and one-day (86,400 sec) templates both hold
 * historical pegScore and exit facts fixed during the event.
 */
const ContagionShockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("score-limit"), assetId: z.string().min(1), dimension: z.enum(["final", "backing"]), limit: z.number().finite().min(0).max(100) }).strict(),
  z.object({ kind: z.literal("depeg"), assetId: z.string().min(1), activeDepegBps: z.number().finite().positive(), template: z.enum(["one-hour-history-and-exit-held", "one-day-history-and-exit-held"]) }).strict(),
  // Active compromise of the reviewed mint authority. If no mint control is
  // captured, the experiment assumes a global, unbounded EOA mint authority
  // with zero delay. This is an explicit hypothetical capability, not evidence
  // that such a capability exists on the canonical asset.
  z.object({ kind: z.literal("mint-control-compromise"), assetId: z.string().min(1) }).strict(),
]);
export const ContagionScenarioSchema = z.object({ id: z.string().min(1), shocks: z.array(ContagionShockSchema) }).strict();
export type ContagionShock = z.output<typeof ContagionShockSchema>;
export type ContagionScenario = z.output<typeof ContagionScenarioSchema>;
export const ContagionResultSchema = z.object({
  schemaVersion: z.literal(1), hypothetical: z.literal(true),
  provenance: z.object({ origin: z.literal("scenario-assumptions"), scenario: ContagionScenarioSchema }),
  identity: z.object({ publicationGenerationId: z.string().min(1), policyDigest: z.string(), evaluationBuildDigest: z.string(), factSetDigest: z.string(), asOfSec: z.number().int() }),
  manifest: z.object({ evaluated: z.number().int(), unchanged: z.number().int(), nr: z.number().int(), failed: z.number().int() }),
  rows: z.array(z.object({
    coinId: z.string(), baselineScore: z.number().nullable(), baselineGrade: z.string(), scenarioScore: z.number().nullable(), scenarioGrade: z.string(), delta: z.number().nullable(), shortestHop: z.number().int().nullable(),
    changedDimensions: z.array(z.enum(["final", "backing", "exit", "control"])), bindingCause: z.string().nullable(), nr: z.boolean(), failure: z.string().nullable(),
  })),
}).strict();
export type V9ContagionScenarioResult = z.output<typeof ContagionResultSchema>;
