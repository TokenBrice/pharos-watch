import type { MechanismArchetype } from "@shared/types";

export interface ArchetypeStep {
  /** Kebab-case, unique within its array, and immutable after publication (editorial-selector identity). */
  readonly id: string;
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
  /** Kebab-case, unique within its array, and immutable after publication (editorial-selector identity). */
  readonly id: string;
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
  readonly decommissioned?: ArchetypeDecommissioned;
}

