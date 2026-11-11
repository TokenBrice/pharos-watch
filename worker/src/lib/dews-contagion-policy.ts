

/** Cross-asset contagion amplifier applied to a same-peg-type coin when another is DANGER. */
export const CONTAGION_BUMP_DANGER = 1.15;

/** Cross-asset contagion amplifier applied to a same-peg-type coin when another is WARNING. */
export const CONTAGION_BUMP_WARNING = 1.08;

/** Upper cap on the cross-asset contagion amplifier (applied after bump selection). */
export const CONTAGION_AMPLIFIER_CAP = 1.2;
