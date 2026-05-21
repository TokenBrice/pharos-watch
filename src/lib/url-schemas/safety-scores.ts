/**
 * URL state schema for `/safety-scores/`.
 *
 * Today the only URL-bound state on this surface is the stress-test
 * simulator selection: which coin is being stressed (`stress`, encoded via
 * `encodeStablecoinUrlToken`) and the target grade for the simulation
 * (`grade`).
 *
 * Grade filter pills, sort key, and sort direction live in local React
 * state and are intentionally NOT in the URL — they're disposable
 * mid-session controls, not shareable views. Promoting them is a separate
 * product decision.
 *
 * The simulator URL contract is the contract the `/safety-scores/` page
 * needs to share. Capture only that.
 */
import type { UrlStateSchema } from "@/lib/url-state";

/** Grade buckets the simulator's grade-target picker exposes. */
export type SafetyStressGrade = "" | "A" | "B" | "C" | "D" | "F";

export const SAFETY_STRESS_GRADES = ["", "A", "B", "C", "D", "F"] as const satisfies readonly SafetyStressGrade[];

export interface SafetyScoresUrlValues {
  /**
   * URL-encoded coin token of the asset being stressed in the simulator.
   * Empty string means no stress simulation is active. Decode via
   * `decodeStablecoinUrlToken` to recover the canonical id.
   */
  stress: string;
  /** Target grade for the stress simulator. Empty string means no grade target. */
  grade: SafetyStressGrade;
}

export const SAFETY_SCORES_URL_SCHEMA: UrlStateSchema<SafetyScoresUrlValues> = {
  stress: {
    kind: "string",
    defaultValue: "",
  },
  grade: {
    kind: "enum",
    defaultValue: "",
    allowedValues: SAFETY_STRESS_GRADES,
  },
};
