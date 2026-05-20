import type { MechanismArchetype } from "@shared/types";

export interface ArchetypeStep {
  readonly title: string;
  readonly body: string;
}

export interface ArchetypeRisk {
  readonly headline: string;
  readonly body: string;
}

export interface ArchetypeCoin {
  readonly coinId: string;
  readonly note: string;
}

export interface ArchetypeVariation {
  readonly title: string;
  readonly body: string;
}

export interface ArchetypeCrossLink {
  readonly href: string;
  readonly label: string;
}

export interface ArchetypeDecommissionedEntry {
  readonly name: string;
  readonly date: string;
  readonly obituary: string;
  readonly coinId?: string;
}

export type ArchetypeDecommissioned = ReadonlyArray<ArchetypeDecommissionedEntry>;

export interface ArchetypeVisuals {
  readonly kickerClass: string;
}

export interface ArchetypeContent {
  readonly archetype: MechanismArchetype;
  readonly headline: string;
  readonly subtitle: string;
  readonly lead: readonly string[];
  readonly howItWorks: readonly [ArchetypeStep, ArchetypeStep, ArchetypeStep];
  readonly riskProfile: readonly ArchetypeRisk[];
  readonly representativeCoins: readonly ArchetypeCoin[];
  readonly variations: readonly ArchetypeVariation[];
  readonly whatToWatch: readonly string[];
  readonly crossLinks: readonly ArchetypeCrossLink[];
  readonly visuals: ArchetypeVisuals;
  readonly decommissioned?: ArchetypeDecommissioned;
}

export const ARCHETYPE_VISUALS: Record<MechanismArchetype, ArchetypeVisuals> = {
  "fiat-cash": { kickerClass: "text-blue-700 dark:text-blue-400" },
  tbill: { kickerClass: "text-violet-700 dark:text-violet-400" },
  cdp: { kickerClass: "text-cyan-700 dark:text-cyan-400" },
  "synthetic-delta-neutral": { kickerClass: "text-teal-700 dark:text-teal-400" },
  algorithmic: { kickerClass: "text-rose-700 dark:text-rose-400" },
  "rwa-credit-fund": { kickerClass: "text-amber-700 dark:text-amber-400" },
};
