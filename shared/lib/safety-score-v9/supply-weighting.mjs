/**
 * Sum selected supply observations without treating an unknown observation as zero.
 *
 * @param {Iterable<number | null>} supplies
 * @returns {number | null}
 */
export function sumKnownSupplyUsdOrNull(supplies) {
  let total = 0;
  for (const supply of supplies) {
    if (supply === null) return null;
    total += supply;
  }
  return total;
}
