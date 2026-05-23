import type { CaseStudy } from "./types";
import { content as usdcSvb2023 } from "./usdc-svb-2023";
import { content as terraUst2022 } from "./terra-ust-2022";
import { content as daiBlackThursday } from "./dai-black-thursday";
import { content as usdeOracle2025 } from "./usde-oracle-2025";
import { content as usd0ppUsual2025 } from "./usd0pp-usual-2025";
import { content as crvusdExploitTrilogy } from "./crvusd-exploit-trilogy";
import { content as ironTitan2021 } from "./iron-titan-2021";
import { content as feiProtocol } from "./fei-protocol";
import { content as usrResolv2026 } from "./usr-resolv-2026";
import { content as pmusdPreciousMetals } from "./pmusd-precious-metals";

/**
 * Canonical display + sitemap order. Tier 1 (one per archetype, marquee) first,
 * then Tier 2. The hub grid and `generateStaticParams` both follow this order.
 */
export const CASE_STUDY_LIST: readonly CaseStudy[] = [
  usdcSvb2023,
  terraUst2022,
  daiBlackThursday,
  usdeOracle2025,
  usd0ppUsual2025,
  crvusdExploitTrilogy,
  ironTitan2021,
  feiProtocol,
  usrResolv2026,
  pmusdPreciousMetals,
];

export const CASE_STUDY_ORDER: readonly string[] = CASE_STUDY_LIST.map(
  (study) => study.slug,
);

export const CASE_STUDIES: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.map((study) => [study.slug, study]),
);

export function getCaseStudy(slug: string): CaseStudy | undefined {
  return CASE_STUDIES[slug];
}

/** Reverse lookups so other surfaces can link inward to a coin's / event's study. */
export const CASE_STUDY_BY_COIN_ID: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.filter((s) => s.primaryCoinId).map((s) => [s.primaryCoinId!, s]),
);

export const CASE_STUDY_BY_CEMETERY_ID: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.filter((s) => s.cemeteryId).map((s) => [s.cemeteryId!, s]),
);

export const CASE_STUDY_BY_DEPEG_SLUG: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.filter((s) => s.depegEventSlug).map((s) => [s.depegEventSlug!, s]),
);

const EVENT_MATCH_DAY_MS = 86_400_000;

/**
 * Resolve the case study that covers a charted event for `coinId` at `tsMs`.
 * Matches the coin against each study's subject (primaryCoinId) first, then its
 * contagion set (relatedCoins), and requires the timestamp to fall inside the
 * study's event window (± a day of slack). Lets the chart-annotation legend
 * link a pin to its long-form retrospective without storing slugs in the
 * curated annotation data.
 */
export function caseStudySlugForEvent(coinId: string, tsMs: number): string | undefined {
  const inWindow = (study: CaseStudy): boolean => {
    const start = Date.parse(study.eventWindow.startISO);
    if (!Number.isFinite(start)) return false;
    const end = study.eventWindow.endISO
      ? Date.parse(study.eventWindow.endISO) + EVENT_MATCH_DAY_MS
      : start + 2 * EVENT_MATCH_DAY_MS;
    return tsMs >= start - 2 * EVENT_MATCH_DAY_MS && tsMs <= end;
  };
  const primary = CASE_STUDY_LIST.find(
    (s) => s.primaryCoinId === coinId && inWindow(s),
  );
  if (primary) return primary.slug;
  const related = CASE_STUDY_LIST.find(
    (s) => (s.relatedCoins?.some((c) => c.coinId === coinId) ?? false) && inWindow(s),
  );
  return related?.slug;
}

export type { CaseStudy } from "./types";
