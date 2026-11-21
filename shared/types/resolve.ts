import { z } from "zod";

export const ResolveCoinIdentitySchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  geckoId: z.string().nullable(),
  status: z.string(),
  pegCurrency: z.string(),
  governance: z.string(),
  navToken: z.boolean(),
});
export type ResolveCoinIdentity = z.infer<typeof ResolveCoinIdentitySchema>;

export const ResolveDeploymentSchema = z.object({
  chain: z.string(),
  chainName: z.string(),
  evmChainId: z.number().int().nullable(),
  address: z.string(),
  normalizedAddress: z.string(),
  decimals: z.number().int().nullable(),
  role: z.enum(["canonical", "traded"]),
});
export type ResolveDeployment = z.infer<typeof ResolveDeploymentSchema>;

export const ResolveLinksSchema = z.object({
  compliance: z.string(),
  riskCheck: z.string(),
  detail: z.string(),
  summary: z.string(),
});
export type ResolveLinks = z.infer<typeof ResolveLinksSchema>;

export const ResolveSingleDeploymentResponseSchema = z.object({
  mode: z.literal("deployment"),
  matched: z.literal(true),
  query: z.object({
    chain: z.string(),
    address: z.string(),
    normalizedAddress: z.string(),
  }),
  coin: ResolveCoinIdentitySchema,
  deployment: ResolveDeploymentSchema,
  links: ResolveLinksSchema,
});
export type ResolveSingleDeploymentResponse = z.infer<typeof ResolveSingleDeploymentResponseSchema>;

export const ResolveAddressMatchSchema = z.object({
  coin: ResolveCoinIdentitySchema,
  deployment: ResolveDeploymentSchema,
  links: ResolveLinksSchema,
});

export const ResolveAddressResponseSchema = z.object({
  mode: z.literal("address"),
  query: z.object({
    address: z.string(),
  }),
  matchCount: z.number().int().positive(),
  ambiguousCoin: z.boolean(),
  matches: z.array(ResolveAddressMatchSchema),
});
export type ResolveAddressResponse = z.infer<typeof ResolveAddressResponseSchema>;

export const ResolveCoinResponseSchema = z.object({
  mode: z.literal("coin"),
  query: z.object({
    id: z.string().optional(),
    geckoId: z.string().optional(),
  }),
  coin: ResolveCoinIdentitySchema,
  deployments: z.array(ResolveDeploymentSchema),
  links: ResolveLinksSchema,
});
export type ResolveCoinResponse = z.infer<typeof ResolveCoinResponseSchema>;

export const ResolveBatchResultItemSchema = z.object({
  input: z.string(),
  chain: z.string().nullable(),
  address: z.string().nullable(),
  normalizedAddress: z.string().nullable(),
  matched: z.boolean(),
  reason: z.enum(["invalid-contract", "unknown-chain", "deployment-not-found"]).nullable(),
  coin: ResolveCoinIdentitySchema.nullable(),
  deployment: ResolveDeploymentSchema.nullable(),
  links: ResolveLinksSchema.nullable(),
});
export type ResolveBatchResultItem = z.infer<typeof ResolveBatchResultItemSchema>;

export const ResolveBatchResponseSchema = z.object({
  mode: z.literal("batch"),
  matchedCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  results: z.array(ResolveBatchResultItemSchema),
});
export type ResolveBatchResponse = z.infer<typeof ResolveBatchResponseSchema>;

export const ResolveResponseSchema = z.union([
  ResolveSingleDeploymentResponseSchema,
  ResolveAddressResponseSchema,
  ResolveCoinResponseSchema,
  ResolveBatchResponseSchema,
]);
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
