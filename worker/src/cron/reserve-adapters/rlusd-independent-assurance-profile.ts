import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import type { IndependentAssuranceProfile } from "./types";
import { decodeHtmlEntities } from "./helpers";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";

// Ripple's archive uses month-only anchor labels and groups the reports under
// one heading per calendar year. The filename usually carries the year, with
// both full years and abbreviated forms such as June'26; since August 2026 the
// signed files omit it ("RLUSD Attestation Report (Sep)_Final Signed.pdf"),
// so prepareIndexHtml copies the enclosing archive year into the anchor text
// and the month-only filename is dated by that section, not by its neighbours.
const MONTH_LABEL =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const FILENAME_MONTH_YEAR = new RegExp(`\\b(${MONTH_LABEL})[ '\\u2019-]+(20\\d{2}|\\d{2})(?!\\d)`, "i");
const FILENAME_MONTH = new RegExp(`\\b(${MONTH_LABEL})\\b`, "i");
const ARCHIVE_YEAR = /\b(?:19|20)\d{2}\b/;
const ARCHIVE_SECTION_HEADING = /<div\b[^>]*\bclass="[^"]*\btext-heading2\b[^"]*"[^>]*>\s*((?:19|20)\d{2})\s*<\/div>/gi;

function rlusdReportDate(href: string, text: string): string | null {
  const filename = (decodeHtmlEntities(decodeURIComponent(href)).split("/").pop() ?? "").replace(/_/g, " ");
  const match = filename.match(FILENAME_MONTH_YEAR);
  if (match) {
    const month = monthNumberFromLabel(match[1]);
    const year = Number(match[2]) + (match[2].length === 2 ? 2000 : 0);
    return month ? formatValidIsoDate(year, month, lastDayOfMonth(year, month)!) : null;
  }
  // A month-only filename is dated only from the archive year heading that
  // prepareIndexHtml copied into the anchor text; an unlabelled month stays
  // undated so discovery fails closed on the ambiguity.
  const monthOnly = filename.match(FILENAME_MONTH);
  const sectionYear = text.match(ARCHIVE_YEAR);
  if (monthOnly && sectionYear) {
    const month = monthNumberFromLabel(monthOnly[1]);
    const year = Number(sectionYear[0]);
    return month ? formatValidIsoDate(year, month, lastDayOfMonth(year, month)!) : null;
  }
  // Without a reviewed year, only the exact reviewed artifact may inherit its
  // document-verified date; other month-only URLs stay closed.
  const reviewed = getIndependentAssuranceManifest("RLUSD");
  return new URL(href).href === new URL(reviewed.reportUrl).href ? reviewed.reportDate : null;
}

// Each yearly heading is followed by one grid holding that year's report
// links, so only anchors inside the grid belong to the year. Anchors outside
// every heading (and non-PDF links) keep their text unchanged and therefore
// stay undated.
function archiveGridEnd(html: string, from: number): number | null {
  const tag = /<div\b|<\/div>/gi;
  tag.lastIndex = from;
  let depth = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return null;
}

function annotateArchiveSectionYears(html: string): string {
  const sections: Array<{ start: number; end: number; year: string }> = [];
  for (const heading of html.matchAll(ARCHIVE_SECTION_HEADING)) {
    const gridStart = html.indexOf("<div", (heading.index ?? 0) + heading[0].length);
    const gridEnd = gridStart === -1 ? null : archiveGridEnd(html, gridStart);
    if (gridStart === -1 || gridEnd === null) return html;
    sections.push({ start: gridStart, end: gridEnd, year: heading[1]! });
  }
  if (sections.length === 0) return html;
  return html.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (anchor, attributes: string, inner: string, offset: number) => {
      const section = sections.find((candidate) => offset >= candidate.start && offset < candidate.end);
      if (!section || !/\.pdf/i.test(attributes) || ARCHIVE_YEAR.test(inner)) return anchor;
      return `<a${attributes}>${inner} ${section.year}</a>`;
    },
  );
}

export const RLUSD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "rlusd-independent-assurance",
  product: "RLUSD",
  profile: "rlusd-v1",
  requiredAssetCodes: ["treasury-bills", "government-mmf", "cash"],
  classifications: {
    "treasury-bills": {
      name: "U.S. Treasury bills", risk: "very-low", assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury", riskFactors: ["duration", "liquidity", "custody"], liquidityHorizon: "seven-days",
    },
    "government-mmf": {
      name: "Government money-market funds", risk: "very-low", assetClass: "money-market-fund",
      issuerOrObligor: "U.S. government money-market funds", riskFactors: ["counterparty", "liquidity", "custody"], liquidityHorizon: "one-day",
    },
    cash: {
      name: "Cash and deposit accounts", risk: "very-low", assetClass: "bank-deposit",
      issuerOrObligor: "U.S. regulated financial institutions", riskFactors: ["counterparty", "custody", "concentration"], liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: (href) => /RLUSD/i.test(decodeURIComponent(href)) && /(?:Reserves?|Attestation)[ _]Reports?/i.test(decodeURIComponent(href)),
  reportDateFromCandidate: rlusdReportDate,
  // Decode HTML-escaped apostrophes/ampersands before the shared URL matcher;
  // percent-encode quotes so decoding cannot change the attribute boundary.
  // The archive year annotation runs on the decoded markup.
  prepareIndexHtml: async (html) => annotateArchiveSectionYears(html.replace(/\bhref=("([^"]*)"|'([^']*)')/gi, (_match, _attribute: string, double: string | undefined, single: string | undefined) =>
    `href="${decodeHtmlEntities(double ?? single ?? "").replace(/"/g, "%22").replace(/'/g, "%27")}"`)),
};
