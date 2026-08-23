import { z } from "zod";

// Decimal grammar intentionally supports source exponent notation without Number coercion.
// eslint-disable-next-line security/detect-unsafe-regex
const DECIMAL_SOURCE_PATTERN = /^([+-]?)([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/;
// eslint-disable-next-line security/detect-unsafe-regex
const CANONICAL_DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
export const JSON_NUMBER_TOKEN_KEY = "__protocolApiJsonNumberToken";

export interface JsonNumberToken {
  [JSON_NUMBER_TOKEN_KEY]: string;
}

export function jsonNumberToken(value: string): JsonNumberToken {
  return { [JSON_NUMBER_TOKEN_KEY]: value };
}

export function canonicalizeDecimal(value: string): string {
  const match = DECIMAL_SOURCE_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal: ${value}`);

  const [, sign, integerPart, fractionPart = "", exponentPart = "0"] = match;
  const exponent = Number(exponentPart);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new Error(`Decimal exponent is out of range: ${value}`);
  }

  const digits = `${integerPart}${fractionPart}`;
  const decimalPosition = integerPart!.length + exponent;
  const padded =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  const [rawInteger, rawFraction = ""] = padded.split(".");
  const normalizedInteger = rawInteger!.replace(/^0+(?=[0-9])/, "") || "0";
  const normalizedFraction = rawFraction.replace(/0+$/, "");
  const magnitude = normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
  if (magnitude === "0") return "0";
  return sign === "-" ? `-${magnitude}` : magnitude;
}

export const DecimalSourceSchema = z.string().transform((value, context) => {
  try {
    return canonicalizeDecimal(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid decimal",
    });
    return z.NEVER;
  }
});

export const JsonNumberDecimalSourceSchema = z
  .object({ [JSON_NUMBER_TOKEN_KEY]: z.string() })
  .strict()
  .transform((token, context) => {
    try {
      return canonicalizeDecimal(token[JSON_NUMBER_TOKEN_KEY]);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid JSON number token",
      });
      return z.NEVER;
    }
  });

export const CanonicalDecimalSchema = z.string().regex(CANONICAL_DECIMAL_PATTERN);
