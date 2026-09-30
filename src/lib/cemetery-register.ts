/**
 * Server-side projection behind the Autopsy Register (plan §6.3). The page
 * builds these rows and the filter options once and passes them to the client
 * register (and the same `rows` array to the hero) as props, so client modules
 * import only the types below, never `CEMETERY_ENTRIES`.
 *
 * Rows carry only what the client cannot derive: labels (cause, date, peak),
 * the archived-page URL and rank orders are derived client-side from these
 * fields by one helper each (`cemetery-register-model.ts`, `formatCemeteryPeak`).
 */
import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import { MECHANISM_ARCHETYPE_SHORT_LABELS } from "@shared/lib/classification";
import { parseCemeteryDeathDate, sortCemeteryCoins } from "@shared/lib/cemetery";
import { resolveCemeteryLogoUrl, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CHAIN_META } from "@shared/lib/chains";
import { buildExplorerUrl } from "@shared/lib/explorer";
import type { PegCurrency } from "@shared/types/core";
import type { MechanismArchetype } from "@shared/types/stablecoin-taxonomy";
import { CASE_STUDY_CLIENT_BY_CEMETERY_ID } from "@/lib/case-study-client-index";
import {
  CEMETERY_PEAK_BUCKET_LABELS,
  CEMETERY_RECORD_FILTER_LABELS,
  type CemeteryRegisterFilters,
} from "@/lib/cemetery-selection";
import type { CemeteryStats } from "@/lib/cemetery-stats";

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
  /** `YYYY-MM-DD` or `YYYY-MM`, verbatim; validated by the builder. */
  deathDate: string;
  /** Recorded peak market cap in USD; null when not recorded (never 0). */
  peak: number | null;
  pegCurrency: PegCurrency;
  mechanismArchetype: MechanismArchetype | null;
  /** Tracked archive: Pharos monitored the coin live, then froze it (its detail page stays online). */
  tracked: boolean;
  caseStudy: { slug: string; title: string } | null;
  epitaph: string | null;
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
  contracts: CemeteryRegisterContract[];
}

/**
 * Every cemetery record as a register row, in `sortCemeteryCoins(…, "newest")`
 * order. Consumers rely on that order: it is the register's default "Died,
 * newest first" order and `rows[0]` is the latest recorded death.
 */
export function buildCemeteryRegisterRows(entries: readonly CemeteryEntry[]): CemeteryRegisterRow[] {
  return sortCemeteryCoins([...entries], "newest").map((entry) => {
    if (parseCemeteryDeathDate(entry.deathDate)?.month == null) {
      throw new Error(`Cemetery entry ${entry.id} has an invalid deathDate "${entry.deathDate}"`);
    }
    const peakMcap = entry.peakMcap;
    const caseStudy = CASE_STUDY_CLIENT_BY_CEMETERY_ID[entry.id];
    return {
      id: entry.id,
      name: entry.name,
      symbol: entry.symbol,
      logoUrl: resolveCemeteryLogoUrl(entry.logo) ?? null,
      cause: entry.causeOfDeath,
      deathDate: entry.deathDate,
      peak: typeof peakMcap === "number" && Number.isFinite(peakMcap) && peakMcap > 0 ? peakMcap : null,
      pegCurrency: entry.pegCurrency,
      mechanismArchetype: entry.mechanismArchetype ?? null,
      tracked: entry.archivedDataAvailable === true,
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
    };
  });
}

export type RegisterFacetKey = Extract<keyof CemeteryRegisterFilters, "year" | "peg" | "mechanism" | "record" | "peak">;

export interface RegisterFacetOption {
  value: string;
  label: string;
  /** Global count across every record, so the numbers stay stable while filtering. */
  count: number;
}

export interface RegisterFilterOptions {
  total: number;
  /** In `CAUSE_ORDER`. */
  causes: { cause: CauseOfDeath; count: number }[];
  facets: Record<RegisterFacetKey, RegisterFacetOption[]>;
}

/** Register filter choices with global counts, built on the server from the page stats and the rows. */
export function buildRegisterFilterOptions(
  stats: Pick<CemeteryStats, "total" | "causes" | "years" | "mechanisms" | "trackedCount" | "curatedCount" | "peakBuckets">,
  rows: readonly CemeteryRegisterRow[],
): RegisterFilterOptions {
  const pegCounts = new Map<string, number>();
  for (const row of rows) pegCounts.set(row.pegCurrency, (pegCounts.get(row.pegCurrency) ?? 0) + 1);

  return {
    total: stats.total,
    causes: stats.causes.map(({ cause, count }) => ({ cause, count })),
    facets: {
      year: stats.years
        .filter((year) => year.total > 0)
        .map((year) => ({ value: String(year.year), label: String(year.year), count: year.total }))
        .reverse(),
      peg: [...pegCounts]
        .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0))
        .map(([peg, count]) => ({ value: peg, label: peg, count })),
      mechanism: stats.mechanisms.counts.map(({ archetype, count }) => ({
        value: archetype,
        label: MECHANISM_ARCHETYPE_SHORT_LABELS[archetype],
        count,
      })),
      record: [
        { value: "tracked", label: CEMETERY_RECORD_FILTER_LABELS.tracked, count: stats.trackedCount },
        { value: "curated", label: CEMETERY_RECORD_FILTER_LABELS.curated, count: stats.curatedCount },
        {
          value: "case-study",
          label: CEMETERY_RECORD_FILTER_LABELS["case-study"],
          count: rows.filter((row) => row.caseStudy !== null).length,
        },
      ],
      peak: stats.peakBuckets.map(({ key, count }) => ({ value: key, label: CEMETERY_PEAK_BUCKET_LABELS[key], count })),
    },
  };
}
