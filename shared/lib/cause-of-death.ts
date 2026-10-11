import type { CauseOfDeath } from "../types/cause-of-death";
import { CAUSE_META } from "./classification";

export { CAUSE_OF_DEATH_VALUES } from "../types/cause-of-death";
export type { CauseOfDeath } from "../types/cause-of-death";
/** Labels, definitions and colours live in `classification.ts` (the single colour/label authority). */
export { CAUSE_HEX, CAUSE_HEX_DARK, CAUSE_META } from "./classification";

/** Canonical cause order for every UI surface (legends, strips, columns, filters). */
export const CAUSE_ORDER: readonly CauseOfDeath[] = [
  "abandoned",
  "counterparty-failure",
  "liquidity-drain",
  "algorithmic-failure",
  "regulatory",
];

/** Cause labels in `CAUSE_ORDER` as one prose list ("A, B, C, D, or E") for copy surfaces. */
export const CAUSE_LABEL_LIST = new Intl.ListFormat("en", { type: "disjunction" }).format(
  CAUSE_ORDER.map((cause) => CAUSE_META[cause].label),
);
