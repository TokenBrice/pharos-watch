import type { MechanismArchetype } from "@shared/types";
import { content as fiatCash } from "./fiat-cash";
import { content as tbill } from "./tbill";
import { content as cdp } from "./cdp";
import { content as syntheticDeltaNeutral } from "./synthetic-delta-neutral";
import { content as algorithmic } from "./algorithmic";
import { content as rwaCreditFund } from "./rwa-credit-fund";
import { content as commodityClaim } from "./commodity-claim";
import type { ArchetypeContent } from "./types";

export const ARCHETYPE_CONTENT: Record<MechanismArchetype, ArchetypeContent> = {
  "fiat-cash": fiatCash,
  tbill,
  cdp,
  "synthetic-delta-neutral": syntheticDeltaNeutral,
  algorithmic,
  "rwa-credit-fund": rwaCreditFund,
  "commodity-claim": commodityClaim,
};

export type { ArchetypeContent, ArchetypeDecommissioned } from "./types";
