/**
 * Shared CLI helpers for tsx/.mjs scripts.
 *
 * Re-exports from smoke-runtime.mjs. New scripts should import directly
 * from smoke-runtime.mjs; this file is kept for backwards compatibility.
 */

export {
  parseCliOptions,
  readCliValue,
  sleep,
  parseCheckMode,
  getArgValue,
} from "./smoke-runtime.mjs";
