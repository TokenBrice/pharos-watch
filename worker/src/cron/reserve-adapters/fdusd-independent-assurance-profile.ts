import type { IndependentAssuranceProfile } from "./types";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";

const ADAPTER_KEY = "fdusd-independent-assurance";

// The official firstdigitallabs.com index 403s Cloudflare Worker egress on every
// strategy (IA7); the issuer's Webflow mirror is the pinned working source and
// carries the same dated ISAE 3000 report series.
export const FDUSD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: ADAPTER_KEY,
  product: "FDUSD",
  profile: "fdusd-v1",
  requiredAssetCodes: ["treasury-bills", "fixed-deposits", "custody-cash"],
  classifications: {
    "treasury-bills": {
      name: "U.S. Treasury Bills",
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Government",
      riskFactors: ["credit", "duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    "fixed-deposits": {
      name: "U.S. government guaranteed fixed deposits held pursuant to reserve repurchase agreements",
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "U.S. Government guaranteed institutions",
      riskFactors: ["credit", "counterparty", "custody"],
      liquidityHorizon: "one-day",
    },
    "custody-cash": {
      name: "US$ held in custody accounts",
      risk: "very-low",
      assetClass: "cash",
      issuerOrObligor: "First Digital Trust Limited (custodian) and underlying financial institutions",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: (href) => {
    const decodedHref = decodeURIComponent(href);
    return !/whitepaper/i.test(decodedHref) &&
      /(?:ISAE[-_ ]?3000|Attestation[ _]+Report[ _]+on[ _]+Reserves[ _]+Account)/i.test(decodedHref);
  },
  reportDateFromCandidate: fdusdReportDate,
  prepareIndexHtml: prepareFdusdIndexHtml,
};

async function prepareFdusdIndexHtml(html: string): Promise<string> {
  // Bind only the date cell immediately beside this row's download anchor.
  // A page heading or a neighboring report cannot date an undated candidate.
  return html.replace(
    /(<div\b[^>]*\bclass=["'][^"']*\btransparency-report_item\b[^"']*["'][^>]*>\s*<div\b[^>]*>)([A-Za-z]+)\s+((?:19|20)\d{2})(<\/div>\s*<a\b[^>]*>)/gi,
    (row, before: string, monthLabel: string, yearLabel: string, after: string) => {
      const month = monthNumberFromLabel(monthLabel.slice(0, 3));
      const year = Number(yearLabel);
      const date = month ? formatValidIsoDate(year, month, lastDayOfMonth(year, month)!, 2000) : null;
      return date ? `${before}${monthLabel} ${yearLabel}${after}FDUSD report period:${date} ` : row;
    },
  );
}

function fdusdReportDate(href: string, text: string): string | null {
  // Keep explicit filename dates authoritative. The issuer's yearless filename
  // convention additionally requires its matching same-row month/year cell.
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const match = fileName.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[_\s]+((?:19|20)\d{2})\b/i,
  );
  if (match) {
    const month = monthNumberFromLabel(match[1].slice(0, 3));
    const year = Number(match[2]);
    return month ? formatValidIsoDate(year, month, lastDayOfMonth(year, month)!, 2000) : null;
  }
  const filenameMonth = fileName.match(
    /(?:^|[_\s(])(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:[_\s).]|$)/i,
  );
  const rowDate = text.match(/\bFDUSD report period:((?:19|20)\d{2})-(\d{2})-(\d{2})\b/);
  if (!filenameMonth || !rowDate) return null;
  const month = monthNumberFromLabel(filenameMonth[1].slice(0, 3));
  const year = Number(rowDate[1]);
  if (!month || month !== Number(rowDate[2]) || Number(rowDate[3]) !== lastDayOfMonth(year, month)) return null;
  return formatValidIsoDate(year, month, Number(rowDate[3]), 2000);
}

