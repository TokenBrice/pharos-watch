/**
 * Shared CLI helpers for tsx/.mjs scripts.
 *
 * Re-exports parseCliOptions from smoke-runtime.mjs so the canonical
 * argv dispatcher has a single home; new scripts should import from here.
 * Existing smoke-runtime consumers continue to work unchanged.
 */

export { parseCliOptions, readCliValue } from "./smoke-runtime.mjs";

/**
 * Returns true if `--check` appears in `argv`. Standard convention across
 * maintenance scripts that support a no-op verification mode.
 */
export function parseCheckMode(argv) {
  return argv.includes("--check");
}

/**
 * Look up a single `--name <value>` style argument in the provided argv.
 * Returns the next token, or null if the flag isn't present.
 */
export function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}
