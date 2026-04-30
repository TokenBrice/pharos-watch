import { z } from "zod";

export const ApiDependencyMetaSchema = z.object({
  updatedAt: z.number().nullable().optional(),
  ageSeconds: z.number().nullable().optional(),
  status: z.enum(["fresh", "degraded", "stale", "unavailable"]),
  reason: z.string().nullish(),
});

export type ApiDependencyMeta = z.infer<typeof ApiDependencyMetaSchema>;

export const ApiMetaSchema = z.object({
  updatedAt: z.number(),
  ageSeconds: z.number(),
  status: z.enum(["fresh", "degraded", "stale"]),
  warning: z.string().nullish(),
  dependencies: z.record(z.string(), ApiDependencyMetaSchema).nullish(),
});

export type ApiMeta = z.infer<typeof ApiMetaSchema>;
