/**
 * Shared admin route gate constants.
 *
 * These live in shared/ so both the Pages Functions proxy layer and the
 * Worker API layer use the exact same values.  The gate *logic* stays
 * duplicated for defense-in-depth; only the constants are shared.
 */

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const X_PHAROS_ADMIN_HEADER = "X-Pharos-Admin";
