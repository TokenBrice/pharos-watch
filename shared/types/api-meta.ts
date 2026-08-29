import { z } from "zod";

export const ApiDependencyMetaSchema = z.object({
  updatedAt: z.number().nullable().optional(),
  ageSeconds: z.number().nullable().optional(),
  status: z.enum(["fresh", "degraded", "stale", "unavailable"]),
  reason: z.string().nullish(),
});

export type ApiDependencyMeta = z.output<typeof ApiDependencyMetaSchema>;

export const ApiMetaSchema = z.object({
  updatedAt: z.number(),
  ageSeconds: z.number(),
  status: z.enum(["fresh", "degraded", "stale"]),
  warning: z.string().nullish(),
  dependencies: z.record(z.string(), ApiDependencyMetaSchema).nullish(),
});

export const ApiMetaWarningOnlySchema = z.object({
  status: z.literal("degraded"),
  warning: z.string(),
  updatedAt: z.undefined().optional(),
  ageSeconds: z.undefined().optional(),
  dependencies: z.undefined().optional(),
});

export const ApiMetaEnvelopeSchema = z.union([
  ApiMetaSchema,
  ApiMetaWarningOnlySchema,
]);

export type ApiMeta = z.output<typeof ApiMetaSchema>;
export type ApiMetaWarningOnly = z.output<typeof ApiMetaWarningOnlySchema>;
export type ApiMetaEnvelope = z.output<typeof ApiMetaEnvelopeSchema>;

export function resolveApiMetaAgeMilliseconds(
  meta: ApiMetaEnvelope | null | undefined,
  fallbackUpdatedAtMs: number,
  nowMs: number,
): { updatedAtMs: number; ageMs: number | null } {
  const updatedAtMs = meta?.updatedAt != null && meta.updatedAt > 0
    ? meta.updatedAt * 1000
    : fallbackUpdatedAtMs;
  const ageMs = meta?.ageSeconds != null
    ? meta.ageSeconds * 1000
    : updatedAtMs > 0
      ? nowMs - updatedAtMs
      : null;

  return { updatedAtMs, ageMs };
}
