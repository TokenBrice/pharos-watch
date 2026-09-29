import type { Donation } from "@shared/lib/funding/schema";
import {
  isEligibleDonor,
  summarizeDonorKeyEligibility,
  type DonorKeyDonationStatus,
} from "@shared/lib/funding/donor-eligibility";
import { DONOR_API_KEY_MIN_USD } from "@shared/lib/ops-limits";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import type { SafetyGradesResponse } from "@shared/types/report-cards-v9";

/**
 * Advisory outcome of the `/api/` wallet check. `unconfirmed` covers every case
 * where missing grades could change the answer, so the page never states a
 * wallet falls short while grades are unavailable.
 */
export type DonorWalletVerdict = "eligible" | "short" | "unconfirmed" | "no-donations";

export interface DonorWalletCheckRow {
  readonly key: string;
  readonly chain: Donation["chain"];
  readonly asset: string;
  readonly usd: number;
  readonly status: DonorKeyDonationStatus;
  readonly reason: string;
}

export interface DonorWalletCheck {
  readonly verdict: DonorWalletVerdict;
  /** Receipt-date USD that counts with the supplied grades. */
  readonly qualifyingUsd: number;
  readonly rows: readonly DonorWalletCheckRow[];
}

const WALLET_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

export function isWalletAddress(value: string): boolean {
  return WALLET_ADDRESS_RE.test(value);
}

/**
 * Grades the claim would use, keyed by stablecoin id. `null` when the
 * publication is missing or held: claims pause then, so nothing can be confirmed.
 */
export function donorKeyGradesFromResponse(
  response: SafetyGradesResponse | undefined,
): ReadonlyMap<string, ReportCardGrade> | null {
  if (!response || response.publicationStatus !== "current") return null;
  return new Map(response.grades.map((entry) => [entry.id, entry.grade]));
}

/** What the checker can say about grades right now. */
export type DonorWalletGradesState = "loading" | "ready" | "held" | "unavailable";

/** The parts of the grades query the checker reads. */
export interface DonorWalletGradesQuery {
  readonly data: SafetyGradesResponse | undefined;
  readonly isError: boolean;
  readonly isLoading: boolean;
}

/**
 * Grades the check may use, and the state to render. A failed fetch or refetch
 * yields no grades even when an earlier response is still cached: the claim
 * cannot read the publication then either, so nothing can be confirmed.
 */
export function resolveDonorWalletGrades(query: DonorWalletGradesQuery): {
  state: DonorWalletGradesState;
  gradesById: ReadonlyMap<string, ReportCardGrade> | null;
} {
  if (query.isError) return { state: "unavailable", gradesById: null };
  if (query.data) {
    const gradesById = donorKeyGradesFromResponse(query.data);
    return { state: gradesById ? "ready" : "held", gradesById };
  }
  return { state: query.isLoading ? "loading" : "unavailable", gradesById: null };
}

function describeRow(status: DonorKeyDonationStatus, grade: ReportCardGrade | null): string {
  switch (status) {
    case "counted":
      return "counted";
    case "grade-outside-band":
      return `graded ${grade} today`;
    case "not-qualifying":
      return "not a listed coin on this network";
    case "pool":
      return "Giveth stream";
    case "grade-unavailable":
      return "grade unavailable";
  }
}

// Reuses the claim's inclusive threshold comparison (floating-point epsilon included).
function reachesThreshold(usd: number): boolean {
  return isEligibleDonor("", new Map([["", usd]]), DONOR_API_KEY_MIN_USD);
}

/**
 * Maps the committed ledger and the live grades to the checker's rows and
 * verdict. `gradesById = null` means grades are unavailable: the result is then
 * `unconfirmed` whenever the wallet has ledger rows.
 */
export function checkDonorWallet(
  address: string,
  donations: readonly Donation[],
  gradesById: ReadonlyMap<string, ReportCardGrade> | null,
): DonorWalletCheck {
  const summary = summarizeDonorKeyEligibility(address, donations, gradesById ?? new Map());
  const rows = summary.rows.map(({ status, stablecoin, grade, donation }) => ({
    key: `${donation.chain}:${donation.tx_hash}`,
    chain: donation.chain,
    asset: stablecoin?.label ?? donation.asset_symbol,
    usd: donation.usd_at_receipt,
    status,
    reason: describeRow(status, grade),
  }));
  const pendingUsd = rows
    .filter((row) => row.status === "grade-unavailable")
    .reduce((total, row) => total + row.usd, 0);

  let verdict: DonorWalletVerdict;
  if (rows.length === 0) verdict = "no-donations";
  else if (reachesThreshold(summary.qualifyingUsd)) verdict = "eligible";
  else if (gradesById === null || reachesThreshold(summary.qualifyingUsd + pendingUsd)) verdict = "unconfirmed";
  else verdict = "short";

  return { verdict, qualifyingUsd: summary.qualifyingUsd, rows };
}
