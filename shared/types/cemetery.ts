import { z } from "zod";
import { PEG_CURRENCY_VALUES } from "./core";
import { CAUSE_OF_DEATH_VALUES } from "./cause-of-death";
import { MECHANISM_ARCHETYPE_VALUES } from "./stablecoin-taxonomy";
import { StrictIsoDateSchema } from "./safety-schema-primitives";

export const DeadStablecoinSchema = z
  .object({
    id: z.string(), name: z.string(), symbol: z.string(), llamaId: z.string().optional(), geckoId: z.string().optional(),
    aliases: z.array(z.string()).optional(), logo: z.string().optional(), pegCurrency: z.enum(PEG_CURRENCY_VALUES),
    causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES), deathDate: z.string(), peakMcap: z.number().optional(),
    epitaph: z.string().optional(), obituary: z.string(), sourceUrl: z.string(), sourceLabel: z.string(),
    contracts: z.array(z.object({ chain: z.string(), address: z.string() }).strict()).optional(),
    /** How the coin worked; the one authority for cemetery mechanism links. Absent until curated. */
    mechanismArchetype: z.enum(MECHANISM_ARCHETYPE_VALUES).optional(),
    /** UTC `YYYY-MM-DD` on which the record entered Pharos (not the death date); required for curated assets. */
    recordedAt: StrictIsoDateSchema.optional(),
  })
  .strict();
export type DeadStablecoin = z.output<typeof DeadStablecoinSchema>;
