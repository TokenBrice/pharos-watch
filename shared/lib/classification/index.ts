/**
 * Compatibility facade for classification labels, badge colors, and style maps.
 *
 * Focused runtime-neutral modules own the concrete policy tables. Keep existing
 * consumers on this path unless they need a narrower import for new code.
 */

export * from "./domain";
export * from "./pegs";
export * from "./badges";
export * from "./risk";
export * from "./control-posture";
export * from "./grades";
export * from "./mechanism-archetypes";
export * from "./resolve-mechanism-archetype";
export * from "./resolve-implementation-launch-date";
export type { BadgeStyle } from "./common";
