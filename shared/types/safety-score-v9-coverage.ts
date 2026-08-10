/**
 * Fail-closed publication floor: V9 cannot publish when the rateable-asset
 * count falls below this value. The broader coverage cluster was deleted
 * 2026-08-09/10; re-add any field only with the check that reads it.
 */
export const V9_MINIMUM_RATEABLE_ASSETS = 271;
