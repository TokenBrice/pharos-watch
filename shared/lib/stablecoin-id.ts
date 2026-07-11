export function isCanonicalStablecoinId(value: string): boolean {
  if (!value || value.startsWith("-") || value.endsWith("-")) return false;

  let previousWasHyphen = false;
  for (const char of value) {
    const isLowerAlpha = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";
    const isHyphen = char === "-";
    if (!isLowerAlpha && !isDigit && !isHyphen) return false;
    if (isHyphen && previousWasHyphen) return false;
    previousWasHyphen = isHyphen;
  }
  return true;
}
