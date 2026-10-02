import { z } from "zod";
export const DeploymentAmountEncodingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed-decimal") }).strict(),
  z.object({ kind: z.literal("xrpl-issued-currency") }).strict(),
]);
export const XrplIssuedCurrencyAmountSchema = z.object({
  value: z.string().min(1),
  currency: z.string().regex(/^(?:[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}|[A-Fa-f0-9]{40})$/).refine((value) => value !== "XRP" && !/^0{40}$/.test(value), "Not an issued currency"),
  issuer: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
}).strict();
export type DeploymentAmountEncoding = z.output<typeof DeploymentAmountEncodingSchema>;
export type ExactIssuedCurrencyAmount = z.output<typeof XrplIssuedCurrencyAmountSchema> & { coefficient: string; exponent: number };
