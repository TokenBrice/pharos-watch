import { z } from "zod";
import {
  LISTING_CLASS_VALUES,
  type ListingDecisionRegistry,
  type ListingExclusionRegistry,
} from "./listing-governance";

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HttpLinkSchema = z.object({ label: z.string().trim().min(1), url: z.string().url() }).strict();

export const ListingDecisionRegistrySchema: z.ZodType<ListingDecisionRegistry> = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().trim().min(1),
    listingClassById: z.record(z.string().trim().min(1), z.enum(LISTING_CLASS_VALUES)),
  })
  .strict();

export const ListingExclusionRegistrySchema: z.ZodType<ListingExclusionRegistry> = z
  .object({
    schemaVersion: z.literal(1),
    exclusions: z.array(z.object({
      catalogId: z.string().trim().min(1),
      decidedAt: IsoDateSchema,
      reason: z.string().trim().min(1),
      providerIds: z.object({
        coingecko: z.array(z.string().trim().min(1)).optional(),
        defillama: z.array(z.string().trim().min(1)).optional(),
      }).strict(),
      contracts: z.array(z.object({
        chain: z.string().trim().min(1),
        address: z.string().trim().min(1),
      }).strict()),
      evidence: z.array(HttpLinkSchema).min(1),
    }).strict()),
  })
  .strict();
