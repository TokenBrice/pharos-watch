/**
 * Binary search a sorted array for the element nearest to a target value.
 *
 * @param arr     Array sorted in ascending order by `getKey`
 * @param target  The value to search for
 * @param getKey  Accessor that extracts the numeric sort key from each element
 * @returns       The element whose key is closest to `target`, or `undefined` if `arr` is empty
 */
export function binarySearchNearest<T>(
  arr: T[],
  target: number,
  getKey: (item: T) => number,
): T | undefined {
  if (arr.length === 0) return undefined;

  let lo = 0;
  let hi = arr.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (getKey(arr[mid]) < target) lo = mid + 1;
    else hi = mid;
  }

  if (lo > 0) {
    const distCurr = Math.abs(getKey(arr[lo]) - target);
    const distPrev = Math.abs(getKey(arr[lo - 1]) - target);
    if (distPrev < distCurr) return arr[lo - 1];
  }

  return arr[lo];
}
