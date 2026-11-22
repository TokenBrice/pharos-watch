import type { ReactNode } from "react";
import { Term } from "@/components/term";
import type { GlossarySlug } from "@/lib/glossary";

/**
 * Remove internal Safety Score engine version prefixes (V8/V9/V10) from
 * reader-facing mechanism explainer copy without mutating plain-text exports.
 */
export function stripEngineVersionPrefixes(text: string): string {
  return text
    .replace(/\bin the V(?:8|9|10) report card\b/g, "in the Safety Score report card")
    .replace(/;\s*V(?:8|9|10)\s+does not\b/g, "; the Safety Score does not")
    .replace(/\bV(?:8|9|10)\s+does not\b/g, "The Safety Score does not")
    .replace(/^V(?:8|9|10)\s+([a-z])/gm, (_match, initial: string) => initial.toUpperCase())
    .replace(/\bV(?:8|9|10)\s+(Backing|Exit|Economic Control)\b/g, "$1")
    .replace(/\bV(?:8|9|10)\s+/g, "");
}

interface TermRule {
  slug: GlossarySlug;
  pattern: RegExp;
}

const MECHANISM_TERM_RULES: readonly TermRule[] = [
  { slug: "economicControl", pattern: /\bEconomic Control\b/ },
  { slug: "overcollateralization", pattern: /\bover-?collateraliz(?:ed|ation)\b/i },
  { slug: "delta-neutral", pattern: /\bdelta-neutral\b/i },
  { slug: "basis-trade", pattern: /\bbasis trade\b/i },
  { slug: "funding-rate", pattern: /\bfunding rates?\b/i },
  { slug: "cdp", pattern: /\bCDPs?\b/ },
  { slug: "amo", pattern: /\bAMOs?\b/ },
  { slug: "psm", pattern: /\bPSMs?\b/ },
  { slug: "rwa", pattern: /\bRWA\b/ },
  { slug: "nav", pattern: /\bNAV\b/ },
  { slug: "mica", pattern: /\bMiCA\b/ },
  { slug: "emi", pattern: /\bEMI\b/ },
  { slug: "backing", pattern: /\bBacking\b/ },
  { slug: "exit", pattern: /\bExit\b/ },
  { slug: "attestation", pattern: /\battestations?\b/i },
  { slug: "liquidation", pattern: /\bliquidations?\b/i },
];

/**
 * Clean engine prefixes and annotate the first occurrence of each tracked
 * glossary term inside a prose passage with an inline `<Term>` popover.
 */
export function renderMechanismProse(text: string, seenSlugs?: Set<GlossarySlug>): ReactNode {
  const cleaned = stripEngineVersionPrefixes(text);
  const seen = seenSlugs ?? new Set<GlossarySlug>();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  while (cursor < cleaned.length) {
    let bestMatch: { start: number; end: number; matched: string; slug: GlossarySlug } | null = null;
    const remainder = cleaned.slice(cursor);

    for (const rule of MECHANISM_TERM_RULES) {
      if (seen.has(rule.slug)) continue;
      const match = rule.pattern.exec(remainder);
      if (!match) continue;
      const start = cursor + match.index;
      const end = start + match[0].length;
      if (
        !bestMatch ||
        start < bestMatch.start ||
        (start === bestMatch.start && match[0].length > bestMatch.matched.length)
      ) {
        bestMatch = { start, end, matched: match[0], slug: rule.slug };
      }
    }

    if (!bestMatch) {
      nodes.push(cleaned.slice(cursor));
      break;
    }

    if (bestMatch.start > cursor) {
      nodes.push(cleaned.slice(cursor, bestMatch.start));
    }
    seen.add(bestMatch.slug);
    nodes.push(
      <Term key={`${bestMatch.slug}-${tokenIndex}`} slug={bestMatch.slug}>
        {bestMatch.matched}
      </Term>,
    );
    tokenIndex += 1;
    cursor = bestMatch.end;
  }

  return nodes;
}
