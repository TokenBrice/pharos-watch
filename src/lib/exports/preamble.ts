/**
 * Deterministic "as-of" header prepended to every CSV/NDJSON/Markdown export
 * so a saved file can be cited and replayed against a known methodology
 * version. Per research/07-power-user.md §"URL Contracts Summary".
 */
export interface ExportPreamble {
  /** Short endpoint label, e.g. "stablecoins", "report-cards". */
  endpoint: string;
  /** ISO 8601 UTC timestamp (e.g. `2026-05-16T12:00:00.000Z`). */
  asOfISO: string;
  /** Full canonical page URL the export was triggered from. */
  sourceUrl: string;
  /** Methodology label, e.g. "safety-score v7.25". */
  methodologyLabel: string;
}

const SITE_LABEL = "Pharos pharos.watch";

function preambleLine(p: ExportPreamble): string {
  return `${SITE_LABEL} | Endpoint: ${p.endpoint} | As of: ${p.asOfISO} | URL: ${p.sourceUrl} | Methodology: ${p.methodologyLabel}`;
}

/** CSV preamble: a single `# `-prefixed comment line; paste-into-Excel safe. */
export function formatPreambleCsv(p: ExportPreamble): string {
  return `# ${preambleLine(p)}`;
}

/** NDJSON preamble: one `{"_meta": ...}` row consumers can skip. */
export function formatPreambleNdjson(p: ExportPreamble): string {
  return JSON.stringify({
    _meta: {
      endpoint: p.endpoint,
      asOfISO: p.asOfISO,
      sourceUrl: p.sourceUrl,
      methodologyLabel: p.methodologyLabel,
    },
  });
}

/** Markdown preamble: one `> ` blockquote line above the table. */
export function formatPreambleMarkdown(p: ExportPreamble): string {
  return `> ${preambleLine(p)}`;
}
