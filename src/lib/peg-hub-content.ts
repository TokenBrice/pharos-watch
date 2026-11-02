/**
 * Build-time, registry-only content for `/stablecoins/<peg>/` hubs: the static
 * "At a glance" table, the "Upcoming" list and the "Former" list. Server-only
 * (it reads the cemetery merge and the compliance sidecar); no live number,
 * price or freshness claim appears here, so nothing ages after the build.
 */
import complianceAsset from "@shared/data/stablecoins/coins.compliance.generated.json";
import { CAUSE_META } from "@shared/lib/cause-of-death";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { BACKING_LABELS, GOVERNANCE_LABELS } from "@shared/lib/classification";
import { LAUNCH_PHASE_LABELS, PRE_LAUNCH_UNPHASED_LABEL } from "@shared/lib/classification/pre-launch";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { MicaProfile, PegCurrency } from "@shared/types";
import { formatRegisterDeathDate } from "@/components/cemetery/cemetery-register-model";
import { formatFuzzyDate, isLaunchedAwaitingData } from "@/lib/pre-launch";

/** MiCA status is shown only where EU authorization is the cohort's live question. */
const MICA_AT_A_GLANCE_PEGS: ReadonlySet<PegCurrency> = new Set<PegCurrency>(["EUR", "GBP", "CHF"]);
/** Rows shown in the static table; the directory below it links every profile. */
const AT_A_GLANCE_ROW_LIMIT = 24;

const NOT_RECORDED = "Not recorded";

const MICA_STATUS_BY_ID = new Map(
  (complianceAsset as { id: string; mica?: MicaProfile }[])
    .filter((entry) => entry.mica != null)
    .map((entry) => [entry.id, entry.mica!.status] as const),
);

type AtAGlanceCoin = Pick<
  StablecoinClientMeta,
  "id" | "name" | "symbol" | "flags" | "blacklistStatus" | "launchDate" | "chainIds"
>;

export interface PegAtAGlanceRow {
  id: string;
  href: string;
  name: string;
  symbol: string;
  backing: string;
  governance: string;
  freeze: string;
  launchYear: string;
  /** Deployment chains in the registry; "Not recorded" rather than 0 when none is listed (R1). */
  chains: string;
  /** Present only on MiCA hubs; "Not reviewed" when the sidecar has no entry. */
  mica?: string;
}

/** Reviewed freeze capability from the registry's blacklistability review. */
function describeFreezeCapability(status: AtAGlanceCoin["blacklistStatus"]): string {
  if (status === true) return "Issuer can freeze";
  if (status === "inherited") return "Via collateral";
  if (status === "possible") return "Possible";
  if (status === false) return "None found";
  return "Not reviewed";
}

export function buildPegAtAGlanceRows(
  peg: PegCurrency,
  coins: readonly AtAGlanceCoin[],
): { rows: PegAtAGlanceRow[]; total: number; showMica: boolean } {
  const showMica = MICA_AT_A_GLANCE_PEGS.has(peg);
  const rows = coins.slice(0, AT_A_GLANCE_ROW_LIMIT).map((coin): PegAtAGlanceRow => {
    const chainCount = coin.chainIds?.length ?? 0;
    const micaStatus = MICA_STATUS_BY_ID.get(coin.id);
    return {
      id: coin.id,
      href: buildStablecoinUrl(coin.id),
      name: coin.name,
      symbol: coin.symbol,
      backing: BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing,
      governance: GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance,
      freeze: describeFreezeCapability(coin.blacklistStatus),
      launchYear: /^\d{4}/.test(coin.launchDate ?? "") ? coin.launchDate!.slice(0, 4) : NOT_RECORDED,
      chains: chainCount > 0 ? String(chainCount) : NOT_RECORDED,
      ...(showMica ? { mica: micaStatus ? MICA_STATUS_BADGE_STYLES[micaStatus].label : "Not reviewed" } : {}),
    };
  });
  return { rows, total: coins.length, showMica };
}

export interface UpcomingPegCoinEntry {
  id: string;
  href: string;
  name: string;
  symbol: string;
  /** "Testnet · target H2 2026", or the phase with "no target date set". */
  status: string;
  /** Live coin awaiting admitted data; rendered apart from the upcoming grid. */
  launched: boolean;
}

export function buildUpcomingPegCoinEntries(
  coins: readonly Pick<StablecoinClientMeta, "id" | "name" | "symbol" | "launchPhase" | "expectedLaunchDate" | "launchDate">[],
): UpcomingPegCoinEntry[] {
  return coins.map((coin) => {
    const phase = coin.launchPhase ? LAUNCH_PHASE_LABELS[coin.launchPhase] : PRE_LAUNCH_UNPHASED_LABEL;
    // A launched coin is live: its launch date, never a stale target.
    const target = coin.launchPhase === "launched"
      ? coin.launchDate ? `since ${formatFuzzyDate(coin.launchDate)}` : "launch date not recorded"
      : coin.expectedLaunchDate ? `target ${formatFuzzyDate(coin.expectedLaunchDate)}` : "no target date set";
    return {
      id: coin.id,
      href: buildStablecoinUrl(coin.id),
      name: coin.name,
      symbol: coin.symbol,
      status: `${phase} · ${target}`,
      launched: isLaunchedAwaitingData(coin),
    };
  });
}

export interface FormerPegCoinEntry {
  id: string;
  /** The frozen profile when Pharos tracked the coin, otherwise its cemetery record anchor. */
  href: string;
  name: string;
  symbol: string;
  /** "Regulatory · Mar 2025" */
  note: string;
  hasProfile: boolean;
}

/** Frozen profiles and curated cemetery records for one peg, newest death first. */
export function buildFormerPegCoinEntries(peg: PegCurrency): FormerPegCoinEntry[] {
  return sortCemeteryCoins(
    CEMETERY_ENTRIES.filter((entry) => entry.pegCurrency === peg),
    "newest",
  ).map((entry) => {
    const hasProfile = entry.archivedDataAvailable === true;
    return {
      id: entry.id,
      href: hasProfile ? buildStablecoinUrl(entry.id) : `/cemetery/#${encodeURIComponent(entry.id)}`,
      name: entry.name,
      symbol: entry.symbol,
      note: `${CAUSE_META[entry.causeOfDeath].label} · ${formatRegisterDeathDate(entry.deathDate)}`,
      hasProfile,
    };
  });
}
