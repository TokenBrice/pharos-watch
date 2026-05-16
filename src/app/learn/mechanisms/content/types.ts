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

export interface ArchetypeVisuals {
  readonly accentBorder: string;
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
}

export const ARCHETYPE_VISUALS: Record<MechanismArchetype, ArchetypeVisuals> = {
  "fiat-cash": {
    accentBorder: "border-l-blue-500",
    kickerClass: "text-blue-700 dark:text-blue-400",
  },
  tbill: {
    accentBorder: "border-l-violet-500",
    kickerClass: "text-violet-700 dark:text-violet-400",
  },
  cdp: {
    accentBorder: "border-l-cyan-500",
    kickerClass: "text-cyan-700 dark:text-cyan-400",
  },
  "synthetic-delta-neutral": {
    accentBorder: "border-l-teal-500",
    kickerClass: "text-teal-700 dark:text-teal-400",
  },
  algorithmic: {
    accentBorder: "border-l-rose-500",
    kickerClass: "text-rose-700 dark:text-rose-400",
  },
};
