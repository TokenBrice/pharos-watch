import { XrplIssuedCurrencyAmountSchema, type ExactIssuedCurrencyAmount, type DeploymentAmountEncoding } from "../types/deployment-amounts";
import { V9_CANDIDATE_POLICY_V1 } from "./safety-score-v9/policy";

export function isFixedDecimalDeployment<T extends { chain: string; decimals: number | null; amountEncoding?: DeploymentAmountEncoding }>(deployment: T): deployment is T & { decimals: number } {
  return deployment.chain !== "xrpl" && deployment.amountEncoding?.kind !== "xrpl-issued-currency" && deployment.decimals !== null && Number.isInteger(deployment.decimals) && deployment.decimals >= 0;
}
export function parseXrplIssuedCurrencyAmount(input: unknown, expected?: { issuer: string; currency: string }): ExactIssuedCurrencyAmount {
  const amount = XrplIssuedCurrencyAmountSchema.parse(input);
  const contract = V9_CANDIDATE_POLICY_V1.policy.semantic.control.exactScope.issuedCurrencyAmount;
  if (expected && (expected.issuer !== amount.issuer || expected.currency !== amount.currency)) throw new Error("xrpl-issued-identity-mismatch");
  if (amount.value.length > contract.maxInputLength) throw new Error("xrpl-issued-input-too-long");
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored linear decimal shape over input already capped at maxInputLength.
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(amount.value);
  if (!match) throw new Error("xrpl-issued-invalid-decimal");
  const negative = match[1] === "-";
  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return { ...amount, coefficient: "0", exponent: 0 };
  const wireExponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(wireExponent)) throw new Error("xrpl-issued-exponent-out-of-range");
  let exponent = wireExponent - (match[3]?.length ?? 0);
  const trailingZeros = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailingZeros) { digits = digits.slice(0, -trailingZeros); exponent += trailingZeros; }
  if (digits.length > contract.significantDigits) throw new Error("xrpl-issued-overprecision");
  const padding = contract.significantDigits - digits.length;
  exponent -= padding;
  if (exponent < contract.minExponent || exponent > contract.maxExponent) throw new Error("xrpl-issued-exponent-out-of-range");
  return { ...amount, coefficient: `${negative ? "-" : ""}${digits}${"0".repeat(padding)}`, exponent };
}
export function compareXrplIssuedCurrencyAmounts(left: ExactIssuedCurrencyAmount, right: ExactIssuedCurrencyAmount): -1 | 0 | 1 {
  if (left.issuer !== right.issuer || left.currency !== right.currency) throw new Error("xrpl-issued-identity-mismatch");
  const exponent = Math.min(left.exponent, right.exponent);
  const a = BigInt(left.coefficient) * 10n ** BigInt(left.exponent - exponent);
  const b = BigInt(right.coefficient) * 10n ** BigInt(right.exponent - exponent);
  return a < b ? -1 : a > b ? 1 : 0;
}
