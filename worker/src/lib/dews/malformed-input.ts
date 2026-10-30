/**
 * Malformed persisted-input vocabulary shared by DEWS execution and the admin
 * refresh preview.
 */

/**
 * Only aggregate-scope malformed inputs degrade a DEWS run. Asset-scoped inputs
 * are quarantined individually, so execution and the refresh preview publish
 * one vocabulary (docs/dews.md#edge-cases).
 */
export function malformedInputDegradesRun(degradesRun: boolean, stablecoinId: string): boolean {
  return degradesRun && (!stablecoinId || stablecoinId === "aggregate");
}
