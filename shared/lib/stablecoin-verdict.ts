/**
 * Pure-derived stablecoin verdict archetype.
 *
 * Runtime-neutral: this module MUST NOT import anything from `@/` (frontend)
 * or `worker/`. It is reusable from the detail page, cemetery, compare, and
 * future scripts that need to label a coin without consulting curated prose.
 *
 * The v1 surface is an archetype label only — no chips, no scores. The
 * "uncategorized" archetype is honest emptiness; UI consumers render `null`
 * for that case rather than fabricating a label.
 *
 * Decision rule precedence (first match wins) is documented inline and
 * matches `agents/council13/research/06-detail-page.md` §"Decision rules".
 */

import type { MechanismArchetype, StablecoinStatus, StablecoinFlags } from "../types";
import type { ReportCardGrade } from "../types/report-card-grade";
import type { ThreatBand } from "./classification/risk";
import { RISKY_GRADES, SAFE_GRADES } from "./safety-grade-buckets";

export type StablecoinVerdictArchetype =
  | "pre-launch"
  | "quarantined-record"
  | "delisted-record"
  | "frozen-archive"
  | "distressed"
  | "low-safety-score"
  | "yield-bearing-hybrid"
  | "decentralized-benchmark"
  | "institutional-default"
  | "uncategorized";

export interface StablecoinVerdict {
  archetype: StablecoinVerdictArchetype;
  label: string;
}

export interface VerdictInputs {
  status: StablecoinStatus | undefined;
  reportCardGrade: ReportCardGrade | null;
  pegScore: number | null;
  dewsBand: ThreatBand | null;
  mechanismArchetype: MechanismArchetype | undefined;
  governance: StablecoinFlags["governance"];
  yieldBearing: boolean;
  navToken?: boolean;
  activeDepeg: boolean;
}

const VERDICT_LABELS: Record<StablecoinVerdictArchetype, string> = {
  "pre-launch": "Pre-launch",
  "quarantined-record": "Quarantined Record",
  "delisted-record": "Delisted Record",
  "frozen-archive": "Frozen Archive",
  distressed: "Distressed",
  "low-safety-score": "Low Safety Score",
  "yield-bearing-hybrid": "Yield-Bearing Hybrid",
  "decentralized-benchmark": "Decentralized Benchmark",
  "institutional-default": "Institutional Default",
  uncategorized: "Uncategorized",
};

// The safe/risky grade boundary lives once, in `safety-grade-buckets.ts`.
const DISTRESSED_BANDS: ReadonlySet<ThreatBand> = new Set(["WARNING", "DANGER"]);
const YIELD_HYBRID_ARCHETYPES: ReadonlySet<MechanismArchetype> = new Set([
  "synthetic-delta-neutral",
  "tbill",
]);

function buildVerdict(archetype: StablecoinVerdictArchetype): StablecoinVerdict {
  return { archetype, label: VERDICT_LABELS[archetype] };
}

export function deriveStablecoinVerdict(inputs: VerdictInputs): StablecoinVerdict {
  if (inputs.status === "pre-launch") {
    return buildVerdict("pre-launch");
  }

  if (inputs.status === "quarantined") {
    return buildVerdict("quarantined-record");
  }

  if (inputs.status === "delisted") {
    return buildVerdict("delisted-record");
  }

  if (inputs.status === "frozen") {
    return buildVerdict("frozen-archive");
  }

  const grade = inputs.reportCardGrade;
  // "Distressed" is reserved for *measured* distress: an active depeg or a
  // WARNING/DANGER DEWS band. Nothing else may claim it.
  if (
    inputs.activeDepeg
    || (inputs.dewsBand !== null && DISTRESSED_BANDS.has(inputs.dewsBand))
  ) {
    return buildVerdict("distressed");
  }

  const archetype = inputs.mechanismArchetype;
  if (inputs.navToken === true && inputs.yieldBearing) {
    return buildVerdict("yield-bearing-hybrid");
  }

  // A D/F grade is a statement about our evidence and our scoring, not a claim
  // that the asset is failing. It keeps its place in the precedence ladder — a
  // badly rated coin must still be flagged ahead of the yield/benchmark labels
  // — but it names the measurement instead of asserting a condition, and it
  // carries the `watch` tone. Red stays reserved for the measured-distress
  // branch above, consistent with the standing "red = active only" module rule.
  if (grade !== null && RISKY_GRADES.has(grade)) {
    return buildVerdict("low-safety-score");
  }

  if (inputs.yieldBearing && archetype !== undefined && YIELD_HYBRID_ARCHETYPES.has(archetype)) {
    return buildVerdict("yield-bearing-hybrid");
  }

  if (inputs.governance === "decentralized" && archetype === "cdp") {
    return buildVerdict("decentralized-benchmark");
  }

  if (
    archetype === "fiat-cash"
    && inputs.governance === "centralized"
    && grade !== null
    && SAFE_GRADES.has(grade)
  ) {
    return buildVerdict("institutional-default");
  }

  return buildVerdict("uncategorized");
}
