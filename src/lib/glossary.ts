/**
 * Popover projection of the non-Pharos DeFi jargon in `./definitions` (the
 * single term source), used by `<Term>` and `[[term]]` markup.
 *
 * For Pharos-specific concepts (PegScore, DEWS, PSI, PYS, etc.) use
 * `MethodologyLabel` from `@/components/methodology-hint` instead — those
 * route to `/methodology/`, this widget gives a 2-sentence definition only.
 */
import { DEFINITIONS, type Definition, type JargonDefinitionKey } from "./definitions";

export interface GlossaryEntry {
  /** Canonical display title shown in the popover. */
  term: string;
  /** 1-2 sentence plain-language definition. */
  short: string;
  /** Optional external link for deeper reading. */
  longHref?: string;
}

export type GlossarySlug = JargonDefinitionKey;

export const GLOSSARY = Object.fromEntries(
  (Object.entries(DEFINITIONS) as [string, Definition][])
    .filter(([, def]) => def.methodologyPath === undefined)
    .map(([key, def]) => [key, { term: def.label, short: def.short }]),
) as Record<GlossarySlug, GlossaryEntry>;
