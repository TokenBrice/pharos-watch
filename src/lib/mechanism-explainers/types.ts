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

// Owner ruling (2026-07-02): categorical identity hues collapse to neutral —
// structure, icons, and kicker copy carry archetype identity, not color. The
// empty kickerClass leaves `.pharos-kicker`'s muted treatment in charge.
export const ARCHETYPE_VISUALS: Record<MechanismArchetype, ArchetypeVisuals> = {
  "fiat-cash": { kickerClass: "" },
  tbill: { kickerClass: "" },
  cdp: { kickerClass: "" },
  "synthetic-delta-neutral": { kickerClass: "" },
  algorithmic: { kickerClass: "" },
  "rwa-credit-fund": { kickerClass: "" },
  "commodity-claim": { kickerClass: "" },
};
