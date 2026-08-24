/**
 * Shared machine-key to display-copy map for public V9 surfaces.
 *
 * One vocabulary across modules on purpose: cap kinds, failure domains and
 * attribution paths draw on overlapping producer keys, so a per-module map
 * would let the same key drift to different copy on the same page.
 */
import type { V9EvidenceResponsibility } from "@shared/types/safety-score-v9-facts";

/**
 * Who owns an unresolved or adverse fact. Pharos's own gaps are named as ours
 * rather than folded into a neutral "not measured" (owner decision 2026-07-28):
 * distinguishing "the issuer will not say" from "we have not looked" is the
 * point of the attribution split.
 */
const RESPONSIBILITY_LABELS = {
  "issuer-undisclosed": "The issuer has not disclosed this",
  "producer-failed": "Our data collection failed",
  "integration-missing": "We have not built this integration yet",
  "method-unsupported": "The method cannot evaluate this shape",
  "measured-adverse": "Measured and adverse",
  "published-evidence-expired": "This was published, but our copy is out of date",
} satisfies Record<V9EvidenceResponsibility, string>;

export const SAFETY_SCORE_V9_RESPONSIBILITY_LABELS: Readonly<Record<string, string>> =
  RESPONSIBILITY_LABELS;

/** Display order for responsibility groups; unlisted keys follow, first seen first. */
export const SAFETY_SCORE_V9_RESPONSIBILITY_ORDER: readonly string[] = [
  "issuer-undisclosed",
  "published-evidence-expired",
  "producer-failed",
  "integration-missing",
  "method-unsupported",
  "measured-adverse",
];
