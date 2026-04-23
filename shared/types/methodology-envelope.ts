import { z } from "zod";

export const MethodologyEnvelopeSchema = z.object({
  version: z.string(),
  versionLabel: z.string(),
  currentVersion: z.string(),
  currentVersionLabel: z.string(),
  changelogPath: z.string(),
  asOf: z.number(),
  isCurrent: z.boolean(),
});

export type MethodologyEnvelope = z.infer<typeof MethodologyEnvelopeSchema>;
