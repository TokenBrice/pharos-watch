import {
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
  PSI_METHODOLOGY_VERSION_LABEL,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

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

/**
 * Known endpoint labels that map to a stable methodology label. Consumers
 * that touch a methodology not in this map should pass `methodologyLabel`
 * explicitly to `<TableExportMenu>`.
 */
const METHODOLOGY_LABEL_BY_ENDPOINT: Record<string, string> = {
  stablecoins: `safety-score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}`,
  "report-cards": `safety-score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}`,
  "bluechip-ratings": `safety-score ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}`,
  "peg-summary": `depeg-dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`,
  "depeg-events": `depeg-dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`,
  "dews-snapshot": `depeg-dews ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`,
  "dex-liquidity": `liquidity-score ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}`,
  liquidity: `liquidity-score ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}`,
  psi: `psi ${PSI_METHODOLOGY_VERSION_LABEL}`,
  "psi-snapshot": `psi ${PSI_METHODOLOGY_VERSION_LABEL}`,
  "mint-burn-flows": `mint-burn-flow ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}`,
  blacklist: `blacklist-tracker ${BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}`,
  yield: `yield ${YIELD_METHODOLOGY_VERSION_LABEL}`,
  "yield-rankings": `yield ${YIELD_METHODOLOGY_VERSION_LABEL}`,
  pricing: `pricing-pipeline ${PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL}`,
  "redemption-backstop": `redemption-backstop ${REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL}`,
};

/**
 * Resolve a stable methodology label for a known endpoint. Returns `null`
 * when the endpoint isn't in the map; callers should then pass an explicit
 * `methodologyLabel` to `<TableExportMenu>`.
 */
export function getMethodologyLabel(endpoint: string): string | null {
  return METHODOLOGY_LABEL_BY_ENDPOINT[endpoint] ?? null;
}
