export type { V9CommodityClaimMechanismRiskReview } from "../../../types/safety-score-v9-backing";

/**
 * Direct commodity claims are evaluated by the simple-archetype descriptor
 * table in `./index.ts`. `physical-redemption` is a weighted mechanism
 * component there; the Exit pillar reads a projection of the same curated fact
 * rather than a second declaration, so the two pillars cannot disagree and the
 * fact is only ever authored once.
 */
