import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { MICA_STATUS_VALUES, MICA_TOKEN_TYPE_VALUES } from "@shared/types/core";
import type {
  MicaProfile,
  MicaStatus,
  MicaTokenType,
  PegCurrency,
  StablecoinLink,
} from "@shared/types";

export interface MicaRow {
  id: string;
  name: string;
  symbol: string;
  peg: PegCurrency;
  status: MicaStatus;
  tokenType?: MicaTokenType;
  authorizationType?: MicaProfile["authorizationType"];
  competentAuthority?: string;
  authorizedEntity?: string;
  significant: boolean;
  references: StablecoinLink[];
}

export interface MicaFilters {
  status: MicaStatus | "all";
  tokenType: MicaTokenType | "all";
  peg: PegCurrency | "all";
  search: string;
}

export interface MicaViewModel {
  rows: MicaRow[];
  totalTracked: number;
}

/** Status order for display: strongest claim first, neutral last. */
const STATUS_DISPLAY_ORDER: MicaStatus[] = [
  "authorized",
  "pending",
  "transitional",
  "non-compliant",
  "out-of-scope",
];

export const MICA_STATUS_FILTER_OPTIONS: { value: MicaStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "authorized", label: "Authorized" },
  { value: "pending", label: "Pending" },
  { value: "transitional", label: "Transitional" },
  { value: "non-compliant", label: "Non-Compliant" },
  { value: "out-of-scope", label: "Out of Scope" },
];

export const MICA_TOKEN_TYPE_FILTER_OPTIONS: { value: MicaTokenType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "EMT", label: "EMT" },
  { value: "ART", label: "ART" },
];

export function normalizeMicaStatusFilter(value: string): MicaStatus | "all" {
  return value !== "all" && (MICA_STATUS_VALUES as readonly string[]).includes(value)
    ? (value as MicaStatus)
    : "all";
}

export function normalizeMicaTokenTypeFilter(value: string): MicaTokenType | "all" {
  return value !== "all" && (MICA_TOKEN_TYPE_VALUES as readonly string[]).includes(value)
    ? (value as MicaTokenType)
    : "all";
}

/** All tracked coins that carry a populated `mica` profile, as table rows. */
function buildAllMicaRows(): MicaRow[] {
  const rows: MicaRow[] = [];
  for (const meta of CLIENT_TRACKED_STABLECOINS) {
    const mica = meta.mica;
    if (!mica) continue;
    if (meta.status === "frozen") continue;
    rows.push({
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
      peg: meta.flags.pegCurrency,
      status: mica.status,
      tokenType: mica.tokenType,
      authorizationType: mica.authorizationType,
      competentAuthority: mica.competentAuthority,
      authorizedEntity: mica.authorizedEntity,
      significant: mica.significant ?? false,
      references: mica.references ?? [],
    });
  }
  return rows;
}

export function buildMicaViewModel(filters: MicaFilters): MicaViewModel {
  const all = buildAllMicaRows();
  const q = filters.search.toLowerCase().trim();

  const rows = all
    .filter((row) => {
      if (filters.status !== "all" && row.status !== filters.status) return false;
      if (filters.tokenType !== "all" && row.tokenType !== filters.tokenType) return false;
      if (filters.peg !== "all" && row.peg !== filters.peg) return false;
      if (q && !row.name.toLowerCase().includes(q) && !row.symbol.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const statusDelta =
        STATUS_DISPLAY_ORDER.indexOf(a.status) - STATUS_DISPLAY_ORDER.indexOf(b.status);
      if (statusDelta !== 0) return statusDelta;
      return a.symbol.localeCompare(b.symbol);
    });

  return { rows, totalTracked: all.length };
}
