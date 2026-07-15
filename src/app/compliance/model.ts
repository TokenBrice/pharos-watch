import { GENIUS_REGIME_STATE, isGeniusRegimeEffective } from "@shared/lib/compliance-regime-state";
import { GENIUS_COMPLIANCE_PROFILE_BY_ID } from "@shared/lib/stablecoins/genius-compliance-registry";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isActiveStablecoinMeta } from "@shared/lib/stablecoins/status";
import {
  GENIUS_AUTHORIZATION_STATUS_VALUES,
  MICA_STATUS_VALUES,
  MICA_TOKEN_TYPE_VALUES,
} from "@shared/types/core";
import type {
  GeniusApplicability,
  GeniusAuthorizationStatus,
  GeniusDaspOfferSaleStatus,
  GeniusEnforcementStatus,
  GeniusForeignExceptionStatus,
  GeniusIssuerPathway,
  GeniusPrimaryFederalRegulator,
  MicaProfile,
  MicaStatus,
  MicaTokenType,
  PegCurrency,
  StablecoinLink,
} from "@shared/types";
import type { GeniusComplianceProfile } from "@shared/types/stablecoin-client-meta";

export const COMPLIANCE_REGIME_VALUES = ["all", "mica", "genius"] as const;
export type ComplianceRegimeFilter = (typeof COMPLIANCE_REGIME_VALUES)[number];
export type ComplianceStatusFilter = MicaStatus | GeniusAuthorizationStatus | "all";

interface BaseComplianceRow {
  id: string;
  name: string;
  symbol: string;
  peg: PegCurrency;
}

export interface MicaComplianceRow extends BaseComplianceRow {
  regime: "mica";
  status: MicaStatus;
  tokenType?: MicaTokenType;
  authorizationType?: MicaProfile["authorizationType"];
  competentAuthority?: string;
  authorizedEntity?: string;
  significant: boolean;
  references: StablecoinLink[];
}

export interface GeniusComplianceRow extends BaseComplianceRow {
  regime: "genius";
  status: GeniusAuthorizationStatus;
  applicability: GeniusApplicability;
  issuerPathway: GeniusIssuerPathway;
  issuerEntity?: string;
  issuerDomicile?: string;
  licensingRegulator?: string;
  primaryFederalRegulator?: GeniusPrimaryFederalRegulator;
  stateRegulator?: string;
  foreignExceptionStatus?: GeniusForeignExceptionStatus;
  enforcementStatus?: GeniusEnforcementStatus;
  daspOfferSaleStatus?: GeniusDaspOfferSaleStatus;
  hasAnyDisclosure: boolean;
  reserveDisclosurePresent: boolean;
  reserveDisclosureUrl?: string;
  redemptionPolicyPresent: boolean;
  monthlyAttestationPresent: boolean;
  latestReportDate?: string;
  notes?: string;
  applicabilitySummary?: string;
  foreignExceptionSummary?: string;
  negativeEvidenceSummary?: string;
  negativeEvidenceSourcesChecked: string[];
  reviewer?: string;
  reviewedAt?: string;
  references: StablecoinLink[];
}

export type ComplianceRow = MicaComplianceRow | GeniusComplianceRow;

export interface ComplianceFilters {
  regime: ComplianceRegimeFilter;
  status: ComplianceStatusFilter;
  tokenType: MicaTokenType | "all";
  peg: PegCurrency | "all";
  search: string;
}

export interface ComplianceViewModel {
  rows: ComplianceRow[];
  watchRows: ComplianceRow[];
  totalTracked: number;
  isGeniusEffective: boolean;
}

const MICA_STATUS_DISPLAY_ORDER: MicaStatus[] = [
  "authorized",
  "pending",
  "transitional",
  "non-compliant",
  "out-of-scope",
];

const GENIUS_STATUS_DISPLAY_ORDER: GeniusAuthorizationStatus[] = [
  "ppsi-approved",
  "state-qualified",
  "official-application-pending",
  "issuer-announced-intent",
  "no-public-authorization-found",
  "unknown",
  "not-applicable",
];

export const COMPLIANCE_REGIME_FILTER_OPTIONS: { value: ComplianceRegimeFilter; label: string }[] = [
  { value: "all", label: "All regimes" },
  { value: "mica", label: "MiCA" },
  { value: "genius", label: "GENIUS" },
];

export const MICA_STATUS_FILTER_OPTIONS: { value: MicaStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "authorized", label: "Authorized" },
  { value: "pending", label: "Pending" },
  { value: "transitional", label: "Transitional" },
  { value: "non-compliant", label: "Non-Compliant" },
  { value: "out-of-scope", label: "Out of Scope" },
];

export const GENIUS_STATUS_FILTER_OPTIONS: { value: GeniusAuthorizationStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ppsi-approved", label: "PPSI Approved" },
  { value: "state-qualified", label: "State Qualified" },
  { value: "official-application-pending", label: "Official Pending" },
  { value: "issuer-announced-intent", label: "Issuer Intent" },
  { value: "no-public-authorization-found", label: "No Public Auth" },
  { value: "not-applicable", label: "Not Applicable" },
  { value: "unknown", label: "Unknown" },
];

export const MICA_TOKEN_TYPE_FILTER_OPTIONS: { value: MicaTokenType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "EMT", label: "EMT" },
  { value: "ART", label: "ART" },
];

export function isMicaStatus(value: string): value is MicaStatus {
  return (MICA_STATUS_VALUES as readonly string[]).includes(value);
}

export function isGeniusAuthorizationStatus(value: string): value is GeniusAuthorizationStatus {
  return (GENIUS_AUTHORIZATION_STATUS_VALUES as readonly string[]).includes(value);
}

export function normalizeComplianceRegimeFilter(value: string): ComplianceRegimeFilter {
  return (COMPLIANCE_REGIME_VALUES as readonly string[]).includes(value)
    ? (value as ComplianceRegimeFilter)
    : "all";
}

export function normalizeComplianceStatusFilter(
  value: string,
  regime: ComplianceRegimeFilter = "all",
): ComplianceStatusFilter {
  if (value === "all") return "all";
  if (regime === "mica") return isMicaStatus(value) ? value : "all";
  if (regime === "genius") return isGeniusAuthorizationStatus(value) ? value : "all";
  if (isMicaStatus(value) || isGeniusAuthorizationStatus(value)) return value;
  return "all";
}

export function normalizeMicaTokenTypeFilter(value: string): MicaTokenType | "all" {
  return value !== "all" && (MICA_TOKEN_TYPE_VALUES as readonly string[]).includes(value)
    ? (value as MicaTokenType)
    : "all";
}

function buildMicaRow(meta: (typeof CLIENT_TRACKED_STABLECOINS)[number], mica: MicaProfile): MicaComplianceRow {
  return {
    regime: "mica",
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
  };
}

function buildGeniusRow(
  meta: (typeof CLIENT_TRACKED_STABLECOINS)[number],
  genius: GeniusComplianceProfile,
): GeniusComplianceRow {
  return {
    regime: "genius",
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
    peg: meta.flags.pegCurrency,
    status: genius.authorizationStatus,
    applicability: genius.applicability,
    issuerPathway: genius.issuerPathway,
    issuerEntity: genius.issuerEntity,
    issuerDomicile: genius.issuerDomicile,
    licensingRegulator: genius.licensingRegulator,
    primaryFederalRegulator: genius.primaryFederalRegulator,
    stateRegulator: genius.stateRegulator,
    foreignExceptionStatus: genius.foreignExceptionStatus,
    enforcementStatus: genius.enforcementStatus,
    daspOfferSaleStatus: genius.daspOfferSaleStatus,
    hasAnyDisclosure: Boolean(
      genius.reserveDisclosurePresent ||
        genius.reserveDisclosureUrl ||
        genius.redemptionPolicyPresent ||
        genius.monthlyAttestationPresent ||
        genius.latestReportDate,
    ),
    reserveDisclosurePresent: genius.reserveDisclosurePresent ?? false,
    reserveDisclosureUrl: genius.reserveDisclosureUrl,
    redemptionPolicyPresent: genius.redemptionPolicyPresent ?? false,
    monthlyAttestationPresent: genius.monthlyAttestationPresent ?? false,
    latestReportDate: genius.latestReportDate,
    notes: genius.notes,
    applicabilitySummary: genius.applicabilityBasis?.summary,
    foreignExceptionSummary: genius.foreignExceptionEvidence?.summary,
    negativeEvidenceSummary: genius.negativeEvidenceReview?.summary,
    negativeEvidenceSourcesChecked: genius.negativeEvidenceReview?.sourcesChecked ?? [],
    reviewer: genius.reviewer,
    reviewedAt: genius.reviewedAt,
    references: collectGeniusReferences(genius),
  };
}

function collectGeniusReferences(genius: GeniusComplianceProfile): StablecoinLink[] {
  const references = [
    ...(genius.references ?? []),
    ...(genius.applicabilityBasis?.references ?? []),
    ...(genius.foreignExceptionEvidence?.references ?? []),
    ...(genius.negativeEvidenceReview?.references ?? []),
  ];
  const seen = new Set<string>();
  const deduped: StablecoinLink[] = [];
  for (const reference of references) {
    const key = `${reference.label}:${reference.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ label: reference.label, url: reference.url });
  }
  return deduped;
}

function buildAllComplianceRows(): { rows: ComplianceRow[]; watchRows: ComplianceRow[]; geniusEffective: boolean } {
  const rows: ComplianceRow[] = [];
  const watchRows: ComplianceRow[] = [];
  const geniusEffective = isGeniusRegimeEffective(GENIUS_REGIME_STATE);

  for (const meta of CLIENT_TRACKED_STABLECOINS) {
    if (isActiveStablecoinMeta(meta) && meta.mica) {
      rows.push(buildMicaRow(meta, meta.mica));
    }

    const genius = GENIUS_COMPLIANCE_PROFILE_BY_ID.get(meta.id);
    if (!genius || (meta.status !== "pre-launch" && !isActiveStablecoinMeta(meta))) continue;
    const geniusRow = buildGeniusRow(meta, genius);
    if (geniusEffective && isActiveStablecoinMeta(meta)) {
      rows.push(geniusRow);
    } else {
      watchRows.push(geniusRow);
    }
  }

  return { rows, watchRows, geniusEffective };
}

function matchesFilters(row: ComplianceRow, filters: ComplianceFilters, q: string): boolean {
  if (filters.regime !== "all" && row.regime !== filters.regime) return false;
  if (filters.status !== "all" && row.status !== filters.status) return false;
  if (filters.tokenType !== "all" && (row.regime !== "mica" || row.tokenType !== filters.tokenType)) return false;
  if (filters.peg !== "all" && row.peg !== filters.peg) return false;
  if (q && !buildSearchText(row).includes(q)) return false;
  return true;
}

function buildSearchText(row: ComplianceRow): string {
  const fields: (string | undefined)[] = [row.name, row.symbol, row.peg, row.status];
  if (row.regime === "mica") {
    fields.push(row.tokenType, row.authorizationType, row.competentAuthority, row.authorizedEntity);
  } else {
    fields.push(
      row.applicability,
      row.issuerPathway,
      row.issuerEntity,
      row.issuerDomicile,
      row.licensingRegulator,
      row.primaryFederalRegulator,
      row.stateRegulator,
    );
  }
  return fields.filter(Boolean).join(" ").toLowerCase();
}

function sortComplianceRows(a: ComplianceRow, b: ComplianceRow): number {
  if (a.regime !== b.regime) return a.regime === "mica" ? -1 : 1;

  const statusDelta = a.regime === "mica" && b.regime === "mica"
    ? MICA_STATUS_DISPLAY_ORDER.indexOf(a.status) - MICA_STATUS_DISPLAY_ORDER.indexOf(b.status)
    : GENIUS_STATUS_DISPLAY_ORDER.indexOf(a.status as GeniusAuthorizationStatus) -
      GENIUS_STATUS_DISPLAY_ORDER.indexOf(b.status as GeniusAuthorizationStatus);
  if (statusDelta !== 0) return statusDelta;
  return a.symbol.localeCompare(b.symbol);
}

export interface ComplianceSummary {
  micaAuthorized: number;
  micaAssessed: number;
  geniusTracked: number;
  assessedRegimeRows: number;
  micaAuthorizedPct: number;
}

export function buildComplianceSummary(): ComplianceSummary {
  const { rows, watchRows } = buildAllComplianceRows();
  const all = [...rows, ...watchRows];
  const micaRows = all.filter((row) => row.regime === "mica");
  const micaAssessed = micaRows.length;
  const micaAuthorized = micaRows.filter((row) => row.status === "authorized").length;
  const geniusTracked = all.filter((row) => row.regime === "genius").length;
  return {
    micaAuthorized,
    micaAssessed,
    geniusTracked,
    assessedRegimeRows: all.length,
    micaAuthorizedPct: micaAssessed > 0 ? Math.round((micaAuthorized / micaAssessed) * 100) : 0,
  };
}

export function buildComplianceViewModel(filters: ComplianceFilters): ComplianceViewModel {
  const all = buildAllComplianceRows();
  const q = filters.search.toLowerCase().trim();

  const rows = all.rows.filter((row) => matchesFilters(row, filters, q)).sort(sortComplianceRows);
  const watchRows = all.watchRows.filter((row) => matchesFilters(row, filters, q)).sort(sortComplianceRows);

  return {
    rows,
    watchRows,
    totalTracked: all.rows.length + all.watchRows.length,
    isGeniusEffective: all.geniusEffective,
  };
}
