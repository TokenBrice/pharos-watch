/**
 * Citation format renderers for the Pharos `<CitationBlock>` component.
 *
 * BibTeX, APA 7, Chicago author-date, and a plain URL+URN line.
 *
 * Runtime-neutral. Do not import from `@/` or `worker/`.
 */

export interface CitationInput {
  /** Page or artifact title (rendered as-is into BibTeX `title`, APA title, etc.). */
  title: string;
  /** Canonical URL (https://...). */
  url: string;
  /** Pharos URN identifier. */
  urn: string;
  /** Methodology / changelog version pinned at the citation moment. Optional. */
  version?: string;
  /**
   * ISO 8601 `YYYY-MM-DD` date the citation refers to. Pinned to the build's
   * sitemap-dates entry — never the browser clock.
   */
  accessedDate: string;
}

const PUBLISHER = "Pharos Watch";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function parseDateParts(iso: string): { year: string; month: string; day: string } {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    throw new TypeError(`Invalid accessedDate (expected YYYY-MM-DD): ${iso}`);
  }
  const [, year, month, day] = match;
  return { year, month, day };
}

function monthName(monthDigits: string): string {
  const index = Number.parseInt(monthDigits, 10) - 1;
  return MONTH_NAMES[index] ?? monthDigits;
}

function escapeBibTeX(value: string): string {
  // BibTeX special characters: `{`, `}`, `\`, `#`, `$`, `%`, `&`, `_`, `~`, `^`.
  return value.replace(/[\\{}#$%&_~^]/g, (char) => `\\${char}`);
}

/**
 * Derive a deterministic BibTeX cite-key from the URN.
 * Strips the `urn:pharos:` prefix and replaces structural separators with
 * underscores so the key is BibTeX-safe.
 */
export function deriveCiteKey(urn: string): string {
  const stripped = urn.replace(/^urn:pharos:/, "");
  return stripped.replace(/[:@]/g, "_").replace(/[^a-zA-Z0-9_]/g, "-");
}

export function formatBibTeX(cite: CitationInput): string {
  const { year, month } = parseDateParts(cite.accessedDate);
  const key = deriveCiteKey(cite.urn);
  const lines = [
    `@misc{${key},`,
    `  author       = {${escapeBibTeX(PUBLISHER)}},`,
    `  title        = {${escapeBibTeX(cite.title)}},`,
    `  year         = {${year}},`,
    `  month        = {${monthName(month).toLowerCase()}},`,
    `  howpublished = {\\url{${cite.url}}},`,
  ];
  if (cite.version) {
    lines.push(`  version      = {${escapeBibTeX(cite.version)}},`);
  }
  lines.push(`  note         = {Accessed: ${cite.accessedDate}; ${cite.urn}},`);
  lines.push(`  urldate      = {${cite.accessedDate}}`);
  lines.push(`}`);
  return lines.join("\n");
}

export function formatAPA7(cite: CitationInput): string {
  const { year, month, day } = parseDateParts(cite.accessedDate);
  const monthLabel = monthName(month);
  const dayNumber = Number.parseInt(day, 10);
  const versionSuffix = cite.version ? ` (${cite.version})` : "";
  return `${PUBLISHER}. (${year}, ${monthLabel} ${dayNumber}). ${cite.title}${versionSuffix}. Retrieved ${cite.accessedDate}, from ${cite.url}`;
}

export function formatChicago(cite: CitationInput): string {
  const { year } = parseDateParts(cite.accessedDate);
  const versionSuffix = cite.version ? ` Version ${cite.version}.` : "";
  return `${PUBLISHER}. ${year}. "${cite.title}."${versionSuffix} ${PUBLISHER}. Accessed ${cite.accessedDate}. ${cite.url}.`;
}

export function formatPlain(cite: CitationInput): string {
  const versionSuffix = cite.version ? ` (${cite.version})` : "";
  return `${cite.title}${versionSuffix} — ${cite.url} — ${cite.urn}`;
}
