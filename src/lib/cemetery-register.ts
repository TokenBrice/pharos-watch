/**
 * Server-side projection behind the Autopsy Register (plan §6.3). The page
 * builds these rows once and passes them to the client register as props, so
 * client modules import only the types below, never `CEMETERY_ENTRIES`.
 */
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate, sortCemeteryCoins } from "@shared/lib/cemetery";
import { resolveCemeteryLogoUrl, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CHAIN_META } from "@shared/lib/chains";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatDeathDate, formatUtcDayLabel } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { PegCurrency } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types/stablecoin-taxonomy";
import { CASE_STUDY_CLIENT_BY_CEMETERY_ID } from "@/lib/case-study-client-index";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";

export type CemeteryRegisterDatePrecision = "day" | "month";

export interface CemeteryRegisterContract {
  /** Display name of the chain; the raw chain key when the chain is unknown. */
  chainName: string;
  address: string;
  explorerUrl: string | null;
}

export interface CemeteryRegisterRow {
  id: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  cause: CauseOfDeath;
  causeLabel: string;
  /** `YYYY-MM-DD` or `YYYY-MM`, verbatim. */
  deathDate: string;
  /** "Aug 27, 2026" (day precision) or "Jul 2026" (month precision). */
  deathDateLabel: string;
  precision: CemeteryRegisterDatePrecision;
  /** Recorded peak market cap in USD; null when not recorded (never 0). */
  peak: number | null;
  peakLabel: string | null;
  pegCurrency: PegCurrency;
  mechanismArchetype: MechanismArchetype | null;
  /** Tracked archive: Pharos monitored the coin live, then froze it. */
  tracked: boolean;
  /** The frozen detail page, for tracked-archive rows only. */
  archivedUrl: string | null;
  caseStudy: { slug: string; title: string } | null;
  epitaph: string | null;
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
  contracts: CemeteryRegisterContract[];
  /** Position in `sortCemeteryCoins(…, "newest")`: the default (Died, newest first) order. */
  defaultRank: number;
  /** Position in `sortCemeteryCoins(…, "oldest")`: the Died, oldest first order. */
  oldestRank: number;
}

function projectDeathDate(entry: CemeteryEntry): Pick<CemeteryRegisterRow, "deathDateLabel" | "precision"> {
  const parsed = parseCemeteryDeathDate(entry.deathDate);
  if (parsed?.month == null) {
    throw new Error(`Cemetery entry ${entry.id} has an invalid deathDate "${entry.deathDate}"`);
  }
  if (parsed.day === null) return { deathDateLabel: formatDeathDate(entry.deathDate), precision: "month" };
  return {
    deathDateLabel: formatUtcDayLabel(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day))),
    precision: "day",
  };
}

/** Every cemetery record as a register row, in the default newest-first order. */
export function buildCemeteryRegisterRows(entries: readonly CemeteryEntry[]): CemeteryRegisterRow[] {
  const oldestRankById = new Map(sortCemeteryCoins([...entries], "oldest").map((entry, index) => [entry.id, index]));

  return sortCemeteryCoins([...entries], "newest").map((entry, defaultRank) => {
    const peakMcap = entry.peakMcap;
    const peak = typeof peakMcap === "number" && Number.isFinite(peakMcap) && peakMcap > 0 ? peakMcap : null;
    const tracked = entry.archivedDataAvailable === true;
    const caseStudy = CASE_STUDY_CLIENT_BY_CEMETERY_ID[entry.id];
    return {
      id: entry.id,
      name: entry.name,
      symbol: entry.symbol,
      logoUrl: resolveCemeteryLogoUrl(entry.logo) ?? null,
      cause: entry.causeOfDeath,
      causeLabel: CAUSE_META[entry.causeOfDeath].label,
      deathDate: entry.deathDate,
      ...projectDeathDate(entry),
      peak,
      peakLabel: peak === null ? null : formatCemeteryPeak(peak),
      pegCurrency: entry.pegCurrency,
      mechanismArchetype: entry.mechanismArchetype ?? null,
      tracked,
      archivedUrl: tracked ? buildStablecoinUrl(entry.id) : null,
      caseStudy: caseStudy ? { slug: caseStudy.slug, title: caseStudy.title } : null,
      epitaph: entry.epitaph ?? null,
      obituary: entry.obituary,
      sourceUrl: entry.sourceUrl,
      sourceLabel: entry.sourceLabel,
      contracts: (entry.contracts ?? []).map((contract) => ({
        chainName: CHAIN_META[contract.chain]?.name ?? contract.chain,
        address: contract.address,
        explorerUrl: buildExplorerUrl({ chainKey: contract.chain, entityType: "contract", value: contract.address }),
      })),
      defaultRank,
      oldestRank: oldestRankById.get(entry.id) ?? defaultRank,
    };
  });
}
