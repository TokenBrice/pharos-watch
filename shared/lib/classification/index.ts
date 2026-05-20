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
export * from "./mechanism-archetypes";
