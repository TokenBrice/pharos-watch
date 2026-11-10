function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

export function isUnsignedDecimalLiteral(value: string): boolean {
  let index = 0;
  let hasMantissaDigit = false;

  while (index < value.length && isAsciiDigit(value[index])) {
    hasMantissaDigit = true;
    index++;
  }

  if (value[index] === ".") {
    index++;
    while (index < value.length && isAsciiDigit(value[index])) {
      hasMantissaDigit = true;
      index++;
    }
  }

  if (!hasMantissaDigit) return false;
  if (index === value.length) return true;
  if (value[index] !== "e" && value[index] !== "E") return false;

  index++;
  if (value[index] === "+" || value[index] === "-") index++;

  let hasExponentDigit = false;
  while (index < value.length && isAsciiDigit(value[index])) {
    hasExponentDigit = true;
    index++;
  }

  return hasExponentDigit && index === value.length;
}
