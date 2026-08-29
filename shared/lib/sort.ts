/**
 * Create a descending comparator for a finite numeric field.
 *
 * Non-finite values sort after finite values. Equal values remain equal unless
 * the caller supplies an explicit secondary comparator, so Array.sort keeps
 * its existing insertion-order tie behavior by default.
 */
export function compareFiniteDesc<T>(
  getValue: (value: T) => number,
  compareSecondary?: (left: T, right: T) => number,
): (left: T, right: T) => number {
  return (left, right) => {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    const leftFinite = Number.isFinite(leftValue);
    const rightFinite = Number.isFinite(rightValue);

    if (leftFinite && rightFinite) {
      const difference = rightValue - leftValue;
      if (difference !== 0) return difference;
    } else if (leftFinite !== rightFinite) {
      return leftFinite ? -1 : 1;
    }

    return compareSecondary?.(left, right) ?? 0;
  };
}
